const finerworksService = require('../helpers/finerworks-service');
const shippoService = require('../helpers/shippo-service');
const { sendApiError } = require('../helpers/api-error');
const debug = require('debug');
const log = debug('app:shippoOrders');

const SHIPPO_CONNECTION_NAME = 'Shippo';
const ETSY_SHOP_APP = 'Etsy';
/** Shippo filters by date/shop_app server-side; we still page through the (small) result set. */
const SHIPPO_MAX_PAGES = 100;
const SHIPPO_PAGE_SIZE = 100;

function toIsoOrNull(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * For `YYYY-MM-DD` only (no time), bound to full UTC days so the last day is inclusive.
 * Anything else is parsed as a normal date/time string.
 */
function parseDateRangeInputs(startRaw, endRaw) {
  const startTrim = String(startRaw || '').trim();
  const endTrim = String(endRaw || '').trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;

  const startIso = dateOnly.test(startTrim)
    ? `${startTrim}T00:00:00.000Z`
    : toIsoOrNull(startTrim);
  const endIso = dateOnly.test(endTrim) ? `${endTrim}T23:59:59.999Z` : toIsoOrNull(endTrim);

  return { startIso, endIso };
}

/** Shippo's date params are ISO 8601 UTC; drop the milliseconds to match their documented format. */
function toShippoDateParam(iso) {
  if (!iso) return undefined;
  return iso.replace(/\.\d{3}Z$/, 'Z');
}

/** Shippo places the order timestamp in `placed_at`; fall back to other common fields. */
function getOrderPlacedTimeMs(order) {
  const raw =
    order?.placed_at ?? order?.order_date ?? order?.object_created ?? order?.created ?? null;
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/**
 * Client-side backstop for the server-side date filter: if Shippo ever ignores start_date/end_date,
 * this still drops out-of-range orders. It is lenient — an order with no usable timestamp is kept,
 * trusting that Shippo's own filter already applied.
 */
function isWithinRangeBackstop(order, startMs, endMs) {
  if (startMs == null && endMs == null) return true;
  const t = getOrderPlacedTimeMs(order);
  if (t == null) return true;
  if (startMs != null && t < startMs) return false;
  if (endMs != null && t > endMs) return false;
  return true;
}

/** Stable identity for an order, used to drop duplicates within a single response. */
function orderDedupeKey(order) {
  const byId = order?.object_id != null ? String(order.object_id).trim() : '';
  if (byId) return byId;
  const byNumber = order?.order_number != null ? String(order.order_number).trim() : '';
  return byNumber || null;
}

function dedupeOrders(orders) {
  const seen = new Set();
  const out = [];
  for (const o of orders) {
    const key = orderDedupeKey(o);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(o);
  }
  return out;
}

/**
 * Same order_po convention as buildSquarespaceOrderPo (squarespace-order-webhook.js): the
 * merchant-facing order number, alphanumeric-sanitized, falling back to Shippo's own object_id.
 */
function buildShippoOrderPo(order) {
  const orderNumber = order?.order_number != null ? String(order.order_number) : '';
  return (
    orderNumber.replace(/[^A-Za-z0-9]/g, '') ||
    (order?.object_id ? String(order.object_id).replace(/[^A-Za-z0-9]/g, '') : null)
  );
}

/**
 * Drops Shippo orders already brought into FinerWorks — as a submitted order (LIST_ORDERS) or a
 * staged pending order (LIST_PENDING_ORDERS) — matched by order_po. Same dedup lookup
 * upload-orders.js's uploadOrdersToLocalDatabaseShopify runs before saving new orders (list_orders
 * + list_pending_orders in parallel, matched by order_po); this is read-only, so orders already in
 * FinerWorks are excluded from the response instead of being skipped before a save.
 */
async function excludeOrdersAlreadyInFinerworks(orders, account_key) {
  const orderPos = [...new Set(orders.map((o) => buildShippoOrderPo(o)).filter(Boolean))];
  if (!orderPos.length) return orders;

  const [listOrdersResult, listPendingResult] = await Promise.allSettled([
    finerworksService.LIST_ORDERS({ account_key, order_pos: orderPos }),
    finerworksService.LIST_PENDING_ORDERS({ account_key }),
  ]);

  const existingOrderPos = new Set();
  if (listOrdersResult.status === 'fulfilled') {
    for (const o of (Array.isArray(listOrdersResult.value?.orders) ? listOrdersResult.value.orders : [])) {
      existingOrderPos.add(String(o.order_po));
    }
  } else {
    log('list_orders lookup failed; proceeding without that check: %s', listOrdersResult.reason?.message);
  }
  if (listPendingResult.status === 'fulfilled') {
    for (const o of (Array.isArray(listPendingResult.value?.orders) ? listPendingResult.value.orders : [])) {
      existingOrderPos.add(String(o.order_po));
    }
  } else {
    log('list_pending_orders lookup failed; proceeding without that check: %s', listPendingResult.reason?.message);
  }

  return orders.filter((o) => {
    const po = buildShippoOrderPo(o);
    return !po || !existingOrderPos.has(po);
  });
}

// Shippo pages by number (not an opaque cursor like Squarespace's), so unlike
// fetchAllSquarespaceOrders — which must fetch one page at a time because it doesn't know the next
// cursor until the current page responds — pages here can be requested speculatively in parallel.
const SHIPPO_PAGE_CONCURRENCY = 100;

/**
 * Page through Shippo orders (bounded), forwarding the server-side filters on every page. Fetches
 * up to SHIPPO_PAGE_CONCURRENCY pages at once via Promise.allSettled (same concurrent-batch pattern
 * getSquarespaceOrders uses for its LIST_ORDERS lookups), instead of one page per round trip —
 * cuts wall-clock time roughly by that factor when a scan runs long. Requesting a page past the end
 * is harmless (Shippo just returns an empty/short page), so over-fetching by up to one batch at the
 * tail is an acceptable tradeoff for not needing to know the page count up front.
 */
async function fetchAllShippoOrders({ status, startDate, endDate, shopApp, liveKey, testKey }) {
  const all = [];
  for (let page = 1; page <= SHIPPO_MAX_PAGES; page += SHIPPO_PAGE_CONCURRENCY) {
    const batchPages = [];
    for (let i = 0; i < SHIPPO_PAGE_CONCURRENCY && page + i <= SHIPPO_MAX_PAGES; i++) {
      batchPages.push(page + i);
    }

    const settled = await Promise.allSettled(
      batchPages.map((p) =>
        shippoService.GET_ORDERS({
          status,
          page: p,
          results: SHIPPO_PAGE_SIZE,
          start_date: startDate,
          end_date: endDate,
          shop_app: shopApp,
          liveKey,
          testKey,
        })
      )
    );

    // Surface the first failure exactly as the old sequential version did (a rejected await
    // propagates to the caller's try/catch), rather than silently dropping a failed page.
    const firstRejected = settled.find((r) => r.status === 'rejected');
    if (firstRejected) throw firstRejected.reason;

    let reachedEnd = false;
    for (const result of settled) {
      const batch = Array.isArray(result.value?.results) ? result.value.results : [];
      all.push(...batch);
      if (!result.value?.next || batch.length < SHIPPO_PAGE_SIZE) reachedEnd = true;
    }

    if (reachedEnd) break;
  }
  return all;
}

const MAX_SHIPPO_ORDER_NUMBER_BATCH = 50;

function normalizeStringList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (item === undefined || item === null) continue;
    const s = String(item).trim();
    if (s) out.push(s);
  }
  return out;
}

/** Accepts a real array, a JSON-array string, or a CSV string — some clients/gateways flatten arrays. */
function coerceListInput(raw) {
  if (raw === undefined || raw === null) return raw;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return raw;
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) return parsed;
      } catch (_) {
        /* single scalar string or malformed; fall through */
      }
    }
    if (t.includes(',')) {
      return t.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return raw;
}

/**
 * Shippo has no server-side lookup by `order_number` — confirmed against their docs: the Orders
 * list endpoint (GET /orders/) only filters by shop_app/start_date/end_date/order_status, and the
 * only id-based retrieval is GET /orders/{ObjectId}/ (Shippo's own object_id, not the merchant-
 * facing order_number) — https://docs.goshippo.com/docs/Orders/Orders. So this pages through
 * Shippo's orders (same fetchAllShippoOrders used by fetchShippoOrders below, scoped to Etsy and to
 * an optional date range) and matches client-side on order_number. Their docs don't state
 * order_number is guaranteed unique, so every match is returned rather than just the first.
 *
 * Without a date range this scans up to SHIPPO_MAX_PAGES pages (10,000 orders) looking for matches
 * — pass startDate/endDate when you know roughly when the orders were placed to keep this fast.
 */
exports.fetchShippoOrdersByOrderNumber = async (req, res) => {
  try {
    const account_key = req.body?.account_key || req.body?.accountKey;
    if (!account_key) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: 'account_key is required.',
      });
    }

    const orderNumberRaw = coerceListInput(
      req.body?.order_numbers ??
      req.body?.orderNumbers ??
      req.body?.order_number ??
      req.body?.orderNumber ??
      null
    );
    const orderNumberList = normalizeStringList(
      Array.isArray(orderNumberRaw) ? orderNumberRaw : [orderNumberRaw]
    );
    const uniqueOrderNumbers = [...new Set(orderNumberList)];

    if (!uniqueOrderNumbers.length) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: 'order_numbers is required and must contain at least one order number.',
      });
    }
    if (uniqueOrderNumbers.length > MAX_SHIPPO_ORDER_NUMBER_BATCH) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: `order_numbers must have at most ${MAX_SHIPPO_ORDER_NUMBER_BATCH} entries.`,
      });
    }

    const startDate = req.body?.startDate || req.body?.start_date;
    const endDate = req.body?.endDate || req.body?.end_date;
    const { startIso, endIso } = parseDateRangeInputs(startDate, endDate);
    if (String(startDate || '').trim() && !startIso) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: 'Invalid startDate. Use YYYY-MM-DD or a valid date/time string.',
      });
    }
    if (String(endDate || '').trim() && !endIso) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: 'Invalid endDate. Use YYYY-MM-DD or a valid date/time string.',
      });
    }

    const getInfo = await finerworksService.GET_INFO({ account_key });
    const accountId = getInfo?.user_account?.account_id;
    if (!accountId) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: 'Could not resolve account ID from account_key.',
      });
    }

    const connections = getInfo?.user_account?.connections || [];
    const shippoConn = connections.find((c) => c.name === SHIPPO_CONNECTION_NAME);
    if (!shippoConn) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: 'Shippo is not connected to this account. Call POST /shippo/connect first.',
      });
    }
    const { live_key, test_key } = JSON.parse(shippoConn.data || '{}');

    log('Fetching %s Shippo order(s) by order_number: %s', uniqueOrderNumbers.length, uniqueOrderNumbers.join(', '));

    const shippoOrders = await fetchAllShippoOrders({
      startDate: toShippoDateParam(startIso),
      endDate: toShippoDateParam(endIso),
      shopApp: ETSY_SHOP_APP,
      liveKey: live_key,
      testKey: test_key,
    });

    const wantedByNormalizedNumber = new Map(
      uniqueOrderNumbers.map((n) => [n.toLowerCase(), n])
    );
    const matchedNormalizedNumbers = new Set();
    let orders = [];
    for (const order of shippoOrders) {
      const orderNumber = order?.order_number != null ? String(order.order_number).trim() : '';
      if (!orderNumber) continue;
      const normalized = orderNumber.toLowerCase();
      if (wantedByNormalizedNumber.has(normalized)) {
        orders.push(order);
        matchedNormalizedNumbers.add(normalized);
      }
    }

    const notFound = uniqueOrderNumbers.filter(
      (n) => !matchedNormalizedNumbers.has(n.toLowerCase())
    );

    const beforeFinerworksExclusion = orders.length;
    orders = await excludeOrdersAlreadyInFinerworks(orders, account_key);
    const excludedAlreadyInFinerworks = beforeFinerworksExclusion - orders.length;

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'shippo',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'fetchShippoOrdersByOrderNumber',
      operation: 'Shippo orders fetched by order_number',
      account_key,
      result: {
        requested: uniqueOrderNumbers.length,
        found: orders.length,
        notFound: notFound.length,
        scanned: shippoOrders.length,
        excludedAlreadyInFinerworks,
      },
      timestamp: new Date().toISOString()
    });
    console.log('Success in fetchShippoOrdersByOrderNumber: %s', successLog);
    log('Success in fetchShippoOrdersByOrderNumber: %s', successLog);

    return res.status(200).json({
      statusCode: 200,
      status: true,
      message: `Shippo orders fetched: ${orders.length} match(es) for ${uniqueOrderNumbers.length} requested order number(s).`,
      data: orders,
      not_found: notFound,
    });
  } catch (err) {
    const isShippoError = err?.response?.config?.url?.includes('shippo') || err?.config?.url?.includes('shippo');
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'shippo',
      source: isShippoError ? 'shippo_api' : (isFinerworksError ? 'finerworks_api' : 'lambda'),
      function: 'fetchShippoOrdersByOrderNumber',
      account_key: req.body?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to fetch Shippo orders by order_number: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.detail || err?.response?.data?.message || null,
      timestamp: new Date().toISOString()
    });
    console.error('Shippo API Error in fetchShippoOrdersByOrderNumber: %s', errorJson);
    log('Formatted error in fetchShippoOrdersByOrderNumber: %s', errorJson);
    return sendApiError(res, err);
  }
};

exports.fetchShippoOrders = async (req, res) => {
  try {
    const { account_key, status, page, results } = req.body;
    const startDate = req.body?.startDate || req.body?.start_date;
    const endDate = req.body?.endDate || req.body?.end_date;

    if (!account_key) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: 'account_key is required.',
      });
    }

    // Validate the date inputs up front so a malformed date is rejected rather than silently ignored.
    const { startIso, endIso } = parseDateRangeInputs(startDate, endDate);
    if (String(startDate || '').trim() && !startIso) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: 'Invalid startDate. Use YYYY-MM-DD or a valid date/time string.',
      });
    }
    if (String(endDate || '').trim() && !endIso) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: 'Invalid endDate. Use YYYY-MM-DD or a valid date/time string.',
      });
    }

    const startMs = startIso ? Date.parse(startIso) : null;
    const endMs = endIso ? Date.parse(endIso) : null;
    if (startMs != null && endMs != null && startMs > endMs) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: 'startDate must be on or before endDate.',
      });
    }
    const hasDateFilter = startMs != null || endMs != null;

    const getInfo = await finerworksService.GET_INFO({ account_key });
    const accountId = getInfo?.user_account?.account_id;
    if (!accountId) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: 'Could not resolve account ID from account_key.',
      });
    }

    const connections = getInfo?.user_account?.connections || [];
    const shippoConn = connections.find((c) => c.name === SHIPPO_CONNECTION_NAME);
    if (!shippoConn) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: 'Shippo is not connected to this account. Call POST /shippo/connect first.',
      });
    }

    const shippoStartDate = toShippoDateParam(startIso);
    const shippoEndDate = toShippoDateParam(endIso);

    log(
      'Fetching Shippo orders status=%s page=%s results=%s start_date=%s end_date=%s shop_app=%s',
      status,
      page,
      results,
      shippoStartDate,
      shippoEndDate,
      ETSY_SHOP_APP
    );
    const { live_key, test_key } = JSON.parse(shippoConn.data || '{}');

    // Shippo filters by shop_app + placed_at date range server-side. With a date filter we page
    // through the full (already narrowed) result set; without one we keep the original single-page
    // behavior for existing callers — but still ask Shippo for Etsy only.
    let shippoOrders;
    if (hasDateFilter) {
      shippoOrders = await fetchAllShippoOrders({
        status,
        startDate: shippoStartDate,
        endDate: shippoEndDate,
        shopApp: ETSY_SHOP_APP,
        liveKey: live_key,
        testKey: test_key,
      });
    } else {
      const shippoResponse = await shippoService.GET_ORDERS({
        status,
        page,
        results,
        shop_app: ETSY_SHOP_APP,
        liveKey: live_key,
        testKey: test_key,
      });
      shippoOrders = shippoResponse.results || [];
    }

    // Shippo already filtered by shop_app; keep an exact-match backstop in case the API returns extras.
    let etsyOrders = shippoOrders.filter((o) => o.shop_app === ETSY_SHOP_APP);
    const etsyFromShippo = etsyOrders.length;
    if (hasDateFilter) {
      etsyOrders = etsyOrders.filter((o) => isWithinRangeBackstop(o, startMs, endMs));
    }
    const beforeDedupe = etsyOrders.length;
    etsyOrders = dedupeOrders(etsyOrders);
    const duplicatesRemoved = beforeDedupe - etsyOrders.length;

    const beforeFinerworksExclusion = etsyOrders.length;
    etsyOrders = await excludeOrdersAlreadyInFinerworks(etsyOrders, account_key);
    const excludedAlreadyInFinerworks = beforeFinerworksExclusion - etsyOrders.length;

    const appliedFilters = {
      startDate: startIso,
      endDate: endIso,
      dateFilterApplied: hasDateFilter,
      shopApp: ETSY_SHOP_APP,
      serverSideFiltered: true,
    };

    if (!etsyOrders.length) {
      const emptyLog = JSON.stringify({
        level: 'INFO',
        platform: 'shippo',
        method: req.method,
        api: req.originalUrl || req.url,
        function: 'fetchShippoOrders',
        operation: 'Shippo Etsy orders fetched — no orders found for given filters',
        account_key: req.body?.account_key || 'unknown',
        result: { count: 0, ...appliedFilters, etsyFromShippo, excludedAlreadyInFinerworks },
        timestamp: new Date().toISOString()
      });
      console.log('Success (empty) in fetchShippoOrders: %s', emptyLog);
      log('Success (empty) in fetchShippoOrders: %s', emptyLog);
      return res.status(200).json({
        statusCode: 200,
        status: true,
        message: 'No orders found for the given filters.',
        data: [],
        skipped: [],
        filters: appliedFilters,
      });
    }

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'shippo',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'fetchShippoOrders',
      operation: 'Shippo Etsy orders fetched successfully',
      account_key: req.body?.account_key || 'unknown',
      result: {
        ...(etsyOrders.length <= 20
          ? { count: etsyOrders.length, orderIds: etsyOrders.map(o => o?.object_id || o?.order_number) }
          : { count: etsyOrders.length, firstOrderIds: etsyOrders.slice(0, 5).map(o => o?.object_id || o?.order_number) }),
        ...appliedFilters,
        etsyFromShippo,
        duplicatesRemoved,
        excludedAlreadyInFinerworks,
      },
      timestamp: new Date().toISOString()
    });
    console.log('Success in fetchShippoOrders: %s', successLog);
    log('Success in fetchShippoOrders: %s', successLog);
    return res.status(200).json({
      statusCode: 200,
      status: true,
      message: `Etsy orders fetched successfully from Shippo. Total: ${etsyOrders.length}`,
      data: etsyOrders,
      filters: appliedFilters,
      pagination: {
        count: etsyOrders.length,
      },
    });
  } catch (err) {
    const isShippoError = err?.response?.config?.url?.includes('shippo') || err?.config?.url?.includes('shippo');
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'shippo',
      source: isShippoError ? 'shippo_api' : (isFinerworksError ? 'finerworks_api' : 'lambda'),
      function: 'fetchShippoOrders',
      account_key: req.body?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to fetch Shippo orders: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.detail || err?.response?.data?.message || null,
      timestamp: new Date().toISOString()
    });
    console.error('Shippo API Error in fetchShippoOrders: %s', errorJson);
    log('Formatted error in fetchShippoOrders: %s', errorJson);
    return sendApiError(res, err);
  }
};
