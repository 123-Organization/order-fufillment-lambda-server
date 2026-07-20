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
 * Page through Shippo orders (bounded), forwarding the server-side filters on every page. Shippo
 * returns `{ count, next, previous, results }`; we stop when there is no `next` page or a short
 * page comes back.
 */
async function fetchAllShippoOrders({ status, startDate, endDate, shopApp, liveKey, testKey }) {
  const all = [];
  for (let page = 1; page <= SHIPPO_MAX_PAGES; page++) {
    const resp = await shippoService.GET_ORDERS({
      status,
      page,
      results: SHIPPO_PAGE_SIZE,
      start_date: startDate,
      end_date: endDate,
      shop_app: shopApp,
      liveKey,
      testKey,
    });
    const batch = Array.isArray(resp?.results) ? resp.results : [];
    all.push(...batch);
    if (!resp?.next || batch.length < SHIPPO_PAGE_SIZE) break;
  }
  return all;
}

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
        result: { count: 0, ...appliedFilters, etsyFromShippo },
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
