const axios = require('axios');
const finerworksService = require('../helpers/finerworks-service');
const {
  resolveWixAuth,
  buildAuthHeaders,
  summarizeWixHttpError,
  maybePersistDiscoveredWixSiteId,
} = require('./wix-products');
const { sendApiError, safeWixErrorData } = require('../helpers/api-error');
const debug = require('debug');
const log = debug('app:wixOrders');

const WIX_SEARCH_ORDERS_URL = 'https://www.wixapis.com/ecom/v1/orders/search';
const WIX_CREATE_FULFILLMENT_BASE = 'https://www.wixapis.com/ecom/v1/fulfillments/orders';
const MAX_ORDER_SEARCH_PAGES = 100;
/** Max order_number / GUID values per request when `order_number` is an array. */
const MAX_WIX_ORDER_BY_NUMBER_BATCH = 100;

function toIsoOrNull(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Wix search rejects putting both bounds in one map: `{ createdDate: { $gte, $lte } }`.
 * Use `$and` with two clauses. Operators here are the standard Wix query language
 * `$gte` / `$lte` (not `$ge` / `$le`; those appear on other endpoints only).
 */
function createdDateRangeFilter(startIso, endIso) {
  return {
    $and: [{ createdDate: { $gte: startIso } }, { createdDate: { $lte: endIso } }],
  };
}

/** For `YYYY-MM-DD` only (no time), bound to full UTC days so last day is inclusive. */
function parseDateRangeInputs(startRaw, endRaw) {
  const startTrim = String(startRaw || '').trim();
  const endTrim = String(endRaw || '').trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;

  let startIso = null;
  let endIso = null;

  if (dateOnly.test(startTrim)) {
    startIso = `${startTrim}T00:00:00.000Z`;
  } else {
    startIso = toIsoOrNull(startTrim);
  }

  if (dateOnly.test(endTrim)) {
    endIso = `${endTrim}T23:59:59.999Z`;
  } else {
    endIso = toIsoOrNull(endTrim);
  }

  return { startIso, endIso };
}

/** UUID-ish order id used for GET order by path. */
function looksLikeOrderGuid(raw) {
  const s = String(raw || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function parseOrderNumber(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const s = String(raw).trim().replace(/^#/, '');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Non-empty trimmed strings; skips null/empty entries (does not 400 on those). */
function normalizeOrderNumberArray(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (item === undefined || item === null) continue;
    const s = String(item).trim();
    if (s) out.push(s);
  }
  return out;
}

/**
 * Many clients/API gateways pass multiple order numbers as a string (JSON array or CSV).
 * Accept those so batch mode still runs.
 */
function coerceOrderNumberRaw(raw) {
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
      return t
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return raw;
}

/**
 * Maps FinerWorks / free-text carrier names to Wix predefined `shippingProvider` slugs when possible.
 * Custom carriers require `trackingLink` in the Wix API.
 * @see https://dev.wix.com/docs/rest/business-solutions/e-commerce/order-fulfillments/create-fulfillment.md
 */
function resolveWixShippingProvider(carrierRaw) {
  const raw = String(carrierRaw || '').trim();
  const c = raw.toLowerCase();
  if (!c) return { shippingProvider: 'Custom', predefined: false };
  if (/\bfedex\b|federal\s*express/.test(c)) return { shippingProvider: 'fedex', predefined: true };
  if (/\bups\b|united\s*parcel/.test(c)) return { shippingProvider: 'ups', predefined: true };
  if (/\busps\b|u\.?s\.?\s*postal|post\s*office/.test(c))
    return { shippingProvider: 'usps', predefined: true };
  if (/\bdhl\b/.test(c)) return { shippingProvider: 'dhl', predefined: true };
  if (/\bcanada\s*post\b|canadapost/.test(c))
    return { shippingProvider: 'canadaPost', predefined: true };
  return { shippingProvider: raw.slice(0, 200), predefined: false };
}

/**
 * Line items Wix can attach to a shipment fulfillment (excludes obvious non-shipped presets).
 */
function buildDefaultFulfillmentLineItems(order) {
  const items = Array.isArray(order?.lineItems) ? order.lineItems : [];
  const out = [];
  for (const li of items) {
    const id = li?.id != null ? String(li.id).trim() : '';
    if (!id) continue;
    const qty = Number(li?.quantity);
    if (Number.isFinite(qty) && qty <= 0) continue;
    const preset = li?.itemType?.preset;
    if (preset === 'DIGITAL' || preset === 'SERVICE') continue;
    const entry = { id };
    if (Number.isFinite(qty) && qty > 0) entry.quantity = Math.round(qty);
    out.push(entry);
  }
  return out;
}

async function fetchWixOrderByGuid(wixAuth, guid) {
  const headers = buildAuthHeaders(wixAuth);
  const url = `https://www.wixapis.com/ecom/v1/orders/${encodeURIComponent(guid)}`;
  const r = await axios.get(url, { headers, timeout: 120000, validateStatus: () => true });
  if (r.status >= 200 && r.status < 300) {
    const order = r?.data?.order ?? r?.data ?? null;
    return { ok: true, order, status: r.status };
  }
  const wixPayload = summarizeWixHttpError(r);
  const st = r.status >= 400 && r.status < 600 ? r.status : 502;
  return { ok: false, status: st, wixPayload, guid };
}

async function searchWixOrdersPage(wixAuth, body) {
  const headers = buildAuthHeaders(wixAuth);
  return axios.post(WIX_SEARCH_ORDERS_URL, body, {
    headers,
    timeout: 120000,
    validateStatus: () => true,
  });
}

async function fetchAllOrdersBySearch({ wixAuth, buildFirstBodyFn }) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < MAX_ORDER_SEARCH_PAGES; page++) {
    const searchPayload =
      page === 0
        ? buildFirstBodyFn()
        : {
          search: {
            cursorPaging: {
              limit: 100,
              cursor,
            },
          },
        };

    const r = await searchWixOrdersPage(wixAuth, searchPayload);

    if (r.status < 200 || r.status >= 300) {
      const err = new Error('Wix search orders failed');
      err.response = r;
      throw err;
    }

    const orders = Array.isArray(r?.data?.orders) ? r.data.orders : [];
    out.push(...orders);

    const meta = r?.data?.metadata || r?.data?.pagingMetadata || {};
    const hasNext = meta.hasNext === true;
    const nextCursor =
      meta.cursors?.next || meta.cursor?.next || (typeof meta.next === 'string' ? meta.next : null);

    if (!hasNext || !nextCursor) break;
    cursor = nextCursor;
  }

  return out;
}

/** HTTP response for a single GET-by-GUID result (scalar `order_id` / GUID-like `order_number`). */
function sendSingleGuidOrderLookupResponse(res, fetchResult, notFoundMessage, logContext = {}) {
  const { ok, order, status, wixPayload } = fetchResult;
  if (ok) {
    if (!order) {
      return sendApiError(res, 502, 'Wix returned an empty order payload');
    }
    const { account_key = 'unknown', req = {} } = logContext;
    const orderKeyCount = order && typeof order === 'object' ? Object.keys(order).length : 0;
    const orderSummary = orderKeyCount <= 20
      ? order
      : { id: order?.id, number: order?.number, status: order?.status, lineItemsCount: Array.isArray(order?.lineItems) ? order.lineItems.length : undefined };
    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'wix',
      method: req.method || 'UNKNOWN',
      api: req.originalUrl || req.url || 'unknown',
      function: 'getWixOrderByNumber',
      operation: 'Wix order fetched by GUID',
      account_key,
      result: orderSummary,
      timestamp: new Date().toISOString()
    });
    console.log('Success in getWixOrderByNumber (GUID): %s', successLog);
    log('Success in getWixOrderByNumber (GUID): %s', successLog);
    return res.status(200).json({ success: true, order });
  }
  if (status === 404) {
    return sendApiError(res, 404, notFoundMessage, safeWixErrorData(wixPayload));
  }
  return sendApiError(
    res,
    status,
    'Failed to retrieve Wix order by id',
    safeWixErrorData(wixPayload)
  );
}

function jsonSearchOrdersError(res, err, clientMessage) {
  const r = err?.response;
  const wixPayload = typeof r?.data !== 'undefined' ? summarizeWixHttpError(r) : null;
  const status = r?.status || err?.response?.status || 502;
  return sendApiError(
    res,
    status >= 400 ? status : 502,
    clientMessage,
    wixPayload ? safeWixErrorData(wixPayload) : {}
  );
}

/**
 * Batch: parallel GUID GETs + one paged search for numeric order numbers.
 */
async function fetchWixOrdersByNumberList(res, wixAuth, orderNumberList, logContext = {}) {
  for (const item of orderNumberList) {
    if (looksLikeOrderGuid(item)) continue;
    if (parseOrderNumber(item) === null) {
      sendApiError(
        res,
        400,
        `order_number entries must be numeric or a Wix order GUID (UUID); invalid: ${item}`
      );
      return;
    }
  }

  const guidKeys = [...new Set(orderNumberList.filter(looksLikeOrderGuid))];
  const numericKeys = [
    ...new Set(
      orderNumberList
        .filter((x) => !looksLikeOrderGuid(x))
        .map((x) => parseOrderNumber(x))
        .filter((n) => n !== null)
    ),
  ];

  const guidToOrder = new Map();
  if (guidKeys.length > 0) {
    const guidResults = await Promise.all(
      guidKeys.map((guid) => fetchWixOrderByGuid(wixAuth, guid).then((r) => ({ guid, r })))
    );
    for (const { guid, r } of guidResults) {
      if (r.ok) {
        if (!r.order) {
          sendApiError(res, 502, 'Wix returned an empty order payload', { orderId: guid });
          return;
        }
        guidToOrder.set(guid, r.order);
      } else if (r.status !== 404) {
        sendApiError(
          res,
          r.status,
          'Failed to retrieve Wix order by id',
          safeWixErrorData(r.wixPayload)
        );
        return;
      }
    }
  }

  const byNumber = new Map();
  if (numericKeys.length > 0) {
    try {
      const searched = await fetchAllOrdersBySearch({
        wixAuth,
        buildFirstBodyFn: () => ({
          search: {
            filter: { number: { $in: numericKeys } },
            cursorPaging: { limit: 100 },
            sort: [{ fieldName: 'createdDate', order: 'DESC' }],
          },
        }),
      });
      for (const o of searched) {
        const n = Number(o?.number);
        if (Number.isFinite(n) && !byNumber.has(n)) byNumber.set(n, o);
      }
    } catch (searchErr) {
      jsonSearchOrdersError(res, searchErr, 'Failed to search Wix orders by number');
      return;
    }
  }

  const ordersOut = [];
  const notFound = [];
  for (const item of orderNumberList) {
    const o = looksLikeOrderGuid(item)
      ? guidToOrder.get(item)
      : byNumber.get(parseOrderNumber(item));
    if (o) ordersOut.push(o);
    else notFound.push(item);
  }

  const payload = { success: true, count: ordersOut.length, orders: ordersOut };
  if (notFound.length > 0) payload.not_found = notFound;
  const { account_key = 'unknown', req = {} } = logContext;
  const successLog = JSON.stringify({
    level: 'INFO',
    platform: 'wix',
    method: req.method || 'UNKNOWN',
    api: req.originalUrl || req.url || 'unknown',
    function: 'getWixOrderByNumber',
    operation: 'Wix orders fetched by number list',
    account_key,
    result: ordersOut.length <= 20
      ? { count: ordersOut.length, orderIds: ordersOut.map(o => o?.id), not_found: notFound }
      : { count: ordersOut.length, firstOrderIds: ordersOut.slice(0, 5).map(o => o?.id), not_found_count: notFound.length },
    timestamp: new Date().toISOString()
  });
  console.log('Success in getWixOrderByNumber (batch): %s', successLog);
  log('Success in getWixOrderByNumber (batch): %s', successLog);
  res.status(200).json(payload);
}

/**
 * Lists Wix eCommerce orders, optionally filtered by createdDate range.
 * Mirrors POST /squarespace/orders shape: account_key, startDate/endDate (optional pairs).
 *
 * Requires app permission: READ-ORDERS.
 */
exports.fetchWixOrderByGuid = fetchWixOrderByGuid;

exports.getWixOrders = async (req, res) => {
  try {
    const account_key =
      req.body?.account_key ||
      req.body?.accountKey ||
      req.query?.account_key ||
      req.query?.accountKey;

    const access_token =
      req.body?.access_token || req.query?.access_token || req.headers['x-wix-access-token'];

    if (!account_key || !String(account_key).trim()) {
      return sendApiError(res, 400, 'account_key is required');
    }

    const wixAuth = await resolveWixAuth({
      account_key: String(account_key).trim(),
      access_token,
      ignoreRequestToken: false,
    });

    if (!wixAuth?.accessToken) {
      return sendApiError(
        res,
        401,
        'Wix credentials not configured. Connect Wix / pass access_token or set env vars.'
      );
    }

    if (wixAuth.siteId && account_key) {
      await maybePersistDiscoveredWixSiteId(String(account_key).trim(), wixAuth.siteId);
    }

    const startDate =
      req.body?.startDate || req.body?.start_date || req.query?.startDate || req.query?.start_date;
    const endDate =
      req.body?.endDate || req.body?.end_date || req.query?.endDate || req.query?.end_date;

    const { startIso, endIso } = parseDateRangeInputs(startDate, endDate);

    if ((startIso && !endIso) || (!startIso && endIso)) {
      return sendApiError(res, 400, 'Provide both startDate and endDate or omit both.');
    }

    let filter = {};
    if (startIso && endIso) {
      filter = createdDateRangeFilter(startIso, endIso);
    }

    const orders = await fetchAllOrdersBySearch({
      wixAuth,
      buildFirstBodyFn: () => ({
        search: {
          ...(Object.keys(filter).length ? { filter } : {}),
          cursorPaging: { limit: 100 },
          sort: [{ fieldName: 'createdDate', order: 'DESC' }],
        },
      }),
    });

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'wix',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'getWixOrders',
      operation: 'Wix orders list fetched successfully',
      account_key: String(account_key).trim(),
      result: orders.length <= 20
        ? { count: orders.length, orderIds: orders.map(o => o?.id) }
        : { count: orders.length, firstOrderIds: orders.slice(0, 5).map(o => o?.id) },
      timestamp: new Date().toISOString()
    });
    console.log('Success in getWixOrders: %s', successLog);
    log('Success in getWixOrders: %s', successLog);
    return res.status(200).json({
      success: true,
      count: orders.length,
      orders,
    });
  } catch (err) {
    const isWixError = err?.response?.config?.url?.includes('wixapis.com') || err?.config?.url?.includes('wixapis.com');
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'wix',
      source: isWixError ? 'wix_api' : (isFinerworksError ? 'finerworks_api' : 'lambda'),
      function: 'getWixOrders',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to fetch Wix orders: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in getWixOrders: %s', errorJson);
    return sendApiError(res, err);
  }
};

/**
 * Fetches order(s) by Wix order GUID (`order_id`) or by dashboard order `number`.
 * Accepts Shopify-style `#12345` display form for numbers.
 *
 * Provide exactly one of: order_id | order_number / orderNumber / orderName.
 * When `order_number` is an array, returns `{ orders, count, not_found? }` (200); each
 * element may be a numeric order number or a Wix order GUID.
 */
exports.getWixOrderByNumber = async (req, res) => {
  try {
    const account_key =
      req.body?.account_key ||
      req.body?.accountKey ||
      req.query?.account_key ||
      req.query?.accountKey;

    const access_token =
      req.body?.access_token || req.query?.access_token || req.headers['x-wix-access-token'];

    const orderIdRaw =
      req.body?.order_id || req.body?.orderId || req.query?.order_id || req.query?.orderId || null;

    const orderNumRaw = coerceOrderNumberRaw(
      req.body?.order_number ??
      req.body?.orderNumber ??
      req.body?.orderName ??
      req.body?.order_name ??
      req.query?.order_number ??
      req.query?.orderNumber ??
      req.query?.orderName ??
      null
    );

    if (!account_key || !String(account_key).trim()) {
      return sendApiError(res, 400, 'account_key is required');
    }

    const orderIdTrim =
      orderIdRaw != null && String(orderIdRaw).trim() ? String(orderIdRaw).trim() : null;
    const isOrderNumArray = Array.isArray(orderNumRaw);
    const orderNumberList = isOrderNumArray ? normalizeOrderNumberArray(orderNumRaw) : null;
    const orderNumStrTrim =
      !isOrderNumArray &&
        orderNumRaw !== undefined &&
        orderNumRaw !== null &&
        String(orderNumRaw).trim()
        ? String(orderNumRaw).trim()
        : null;

    if (orderIdTrim && (orderNumStrTrim || (isOrderNumArray && orderNumberList.length > 0))) {
      return sendApiError(
        res,
        400,
        'Provide only one of order_id or order_number (order_number / orderName)'
      );
    }

    if (!orderIdTrim && !orderNumStrTrim && !(isOrderNumArray && orderNumberList.length > 0)) {
      return sendApiError(res, 400, 'Missing required parameter: order_id or order_number');
    }

    if (isOrderNumArray && orderNumberList.length > MAX_WIX_ORDER_BY_NUMBER_BATCH) {
      return sendApiError(
        res,
        400,
        `order_number array must have at most ${MAX_WIX_ORDER_BY_NUMBER_BATCH} entries`
      );
    }

    const wixAuth = await resolveWixAuth({
      account_key: String(account_key).trim(),
      access_token,
      ignoreRequestToken: false,
    });

    if (!wixAuth?.accessToken) {
      return sendApiError(
        res,
        401,
        'Wix credentials not configured. Connect Wix / pass access_token or set env vars.'
      );
    }

    if (wixAuth.siteId && account_key) {
      await maybePersistDiscoveredWixSiteId(String(account_key).trim(), wixAuth.siteId);
    }

    if (isOrderNumArray && orderNumberList.length > 0) {
      await fetchWixOrdersByNumberList(res, wixAuth, orderNumberList, { account_key: String(account_key).trim(), req });
      return;
    }

    let guid = null;
    let notFoundLabel = '';
    if (orderIdTrim) {
      if (!looksLikeOrderGuid(orderIdTrim)) {
        return sendApiError(res, 400, 'order_id must be a Wix order GUID (UUID)');
      }
      guid = orderIdTrim;
      notFoundLabel = `Order not found for order_id: ${orderIdTrim}`;
    } else if (orderNumStrTrim && looksLikeOrderGuid(orderNumStrTrim)) {
      guid = orderNumStrTrim;
      notFoundLabel = `Order not found for order_id: ${orderNumStrTrim}`;
    }

    if (guid) {
      const fetchResult = await fetchWixOrderByGuid(wixAuth, guid);
      return sendSingleGuidOrderLookupResponse(res, fetchResult, notFoundLabel, { account_key: String(account_key).trim(), req });
    }

    const orderNum = parseOrderNumber(orderNumStrTrim);
    if (orderNum === null) {
      return sendApiError(res, 400, 'order_number must be numeric or a Wix order GUID (UUID)');
    }

    const r = await searchWixOrdersPage(wixAuth, {
      search: {
        filter: { number: orderNum },
        cursorPaging: { limit: 5 },
      },
    });

    if (r.status < 200 || r.status >= 300) {
      const wixPayload = summarizeWixHttpError(r);
      return sendApiError(
        res,
        r.status >= 400 ? r.status : 502,
        'Failed to search Wix order by number',
        safeWixErrorData(wixPayload)
      );
    }

    const orders = Array.isArray(r?.data?.orders) ? r.data.orders : [];
    const found = orders.find((o) => Number(o?.number) === orderNum) || orders[0] || null;

    if (!found) {
      return sendApiError(res, 404, `Order not found for order_number: ${orderNumStrTrim}`, {
        orderNumber: orderNumStrTrim,
      });
    }

    const foundKeyCount = found && typeof found === 'object' ? Object.keys(found).length : 0;
    const foundSummary = foundKeyCount <= 20
      ? found
      : { id: found?.id, number: found?.number, status: found?.status, lineItemsCount: Array.isArray(found?.lineItems) ? found.lineItems.length : undefined };
    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'wix',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'getWixOrderByNumber',
      operation: 'Wix order fetched by order number',
      account_key: String(account_key).trim(),
      result: foundSummary,
      timestamp: new Date().toISOString()
    });
    console.log('Success in getWixOrderByNumber: %s', successLog);
    log('Success in getWixOrderByNumber: %s', successLog);
    return res.status(200).json({ success: true, order: found });
  } catch (err) {
    const isWixError = err?.response?.config?.url?.includes('wixapis.com') || err?.config?.url?.includes('wixapis.com');
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'wix',
      source: isWixError ? 'wix_api' : (isFinerworksError ? 'finerworks_api' : 'lambda'),
      function: 'getWixOrderByNumber',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to fetch Wix order by number: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in getWixOrderByNumber: %s', errorJson);
    return sendApiError(res, err);
  }
};

/**
 * Like POST /squarespace/fulfill-order: loads tracking from FinerWorks GET_ORDER_STATUS, then creates
 * a Wix eCommerce fulfillment (Create Fulfillment API).
 *
 * Body: account_key (required), order_id (Wix order GUID), order_number (FinerWorks / order_pos key).
 * Optional: access_token | Authorization: Bearer, line_items [{ id, quantity? }] to override line selection.
 *
 * Permissions: Manage Orders (`SCOPE.DC-STORES.MANAGE-ORDERS` per Wix docs).
 */
exports.fulfillWixOrderWithTrackingInfo = async (req, res) => {
  try {
    const account_key =
      req.body?.account_key ||
      req.body?.accountKey ||
      req.query?.account_key ||
      req.query?.accountKey;

    let access_token =
      req.body?.access_token || req.query?.access_token || req.headers['x-wix-access-token'];
    const authHeader = req.headers?.authorization || req.headers?.Authorization;
    if (!access_token && typeof authHeader === 'string' && /^Bearer\s+/i.test(authHeader.trim())) {
      access_token = authHeader.replace(/^Bearer\s+/i, '').trim();
    }

    const orderIdRaw =
      req.body?.order_id || req.body?.orderId || req.query?.order_id || req.query?.orderId;

    const orderNumberRaw =
      req.body?.orderNumber ||
      req.body?.order_number ||
      req.body?.orderName ||
      req.body?.order_name ||
      req.query?.orderNumber ||
      req.query?.order_number;

    if (!account_key || !String(account_key).trim()) {
      return sendApiError(res, 400, 'account_key is required');
    }
    if (!orderIdRaw || !String(orderIdRaw).trim()) {
      return sendApiError(res, 400, 'Missing required parameter: order_id (Wix order GUID)');
    }
    if (!orderNumberRaw || !String(orderNumberRaw).trim()) {
      return sendApiError(
        res,
        400,
        'Missing required parameter: order_number (used for FinerWorks GET_ORDER_STATUS)'
      );
    }

    const orderId = String(orderIdRaw).trim();
    const orderNumber = String(orderNumberRaw).trim();

    if (!looksLikeOrderGuid(orderId)) {
      return sendApiError(res, 400, 'order_id must be a Wix order GUID (UUID)');
    }

    const wixAuth = await resolveWixAuth({
      account_key: String(account_key).trim(),
      access_token,
      ignoreRequestToken: false,
    });

    if (!wixAuth?.accessToken) {
      return sendApiError(
        res,
        401,
        'Wix credentials not configured. Connect Wix / pass access_token or set env vars.'
      );
    }

    if (wixAuth.siteId && account_key) {
      await maybePersistDiscoveredWixSiteId(String(account_key).trim(), wixAuth.siteId);
    }

    const orderFetch = await fetchWixOrderByGuid(wixAuth, orderId);
    if (!orderFetch.ok) {
      if (orderFetch.status === 404) {
        return sendApiError(res, 404, `Wix order not found for order_id: ${orderId}`, {
          orderId,
          ...(orderFetch.wixPayload ? safeWixErrorData(orderFetch.wixPayload) : {}),
        });
      }
      return sendApiError(
        res,
        orderFetch.status >= 400 ? orderFetch.status : 502,
        'Failed to load Wix order before fulfillment',
        orderFetch.wixPayload ? safeWixErrorData(orderFetch.wixPayload) : {}
      );
    }

    const wixOrder = orderFetch.order;
    let lineItems;
    if (Array.isArray(req.body?.line_items) && req.body.line_items.length > 0) {
      lineItems = [];
      for (const row of req.body.line_items) {
        const id = row?.id != null ? String(row.id).trim() : '';
        if (!id) {
          return sendApiError(res, 400, 'line_items entries must include id (Wix line item GUID)');
        }
        const ent = { id };
        const q = Number(row?.quantity);
        if (Number.isFinite(q) && q > 0) ent.quantity = Math.round(q);
        lineItems.push(ent);
      }
    } else {
      lineItems = buildDefaultFulfillmentLineItems(wixOrder);
    }

    if (!lineItems.length) {
      return sendApiError(
        res,
        400,
        'No fulfillable line items on this Wix order (or none match filters). Pass line_items with Wix line item GUIDs.'
      );
    }

    const selectOrderId = {
      order_pos: [orderNumber],
      account_key: String(account_key).trim(),
    };

    let orderStatusData = null;
    try {
      orderStatusData = await finerworksService.GET_ORDER_STATUS(selectOrderId);
    } catch (error) {
      const errorJson = JSON.stringify({
        level: 'ERROR',
        platform: 'wix',
        source: 'finerworks_api',
        function: 'fulfillWixOrderWithTrackingInfo',
        account_key: req.body?.account_key || req.query?.account_key || 'unknown',
        orderId: String(orderIdRaw || '').trim(),
        orderNumber: String(orderNumberRaw || '').trim(),
        httpStatus: error?.response?.status || null,
        message: `Failed to fetch order status from FinerWorks: ${error?.message || 'Unknown error'}`,
        detail: error?.response?.data?.message || null,
        timestamp: new Date().toISOString()
      });
      console.error(errorJson);
      log('Formatted error in fulfillWixOrderWithTrackingInfo: %s', errorJson);
      return sendApiError(res, error);
    }

    const shipment = orderStatusData?.orders?.[0]?.shipments?.[0] || {};
    const trackingNumber =
      shipment?.tracking_number != null ? String(shipment.tracking_number).trim() : '';
    const trackingUrlRaw =
      shipment?.tracking_url != null ? String(shipment.tracking_url).trim() : '';
    const carrierName = shipment?.carrier;

    if (!trackingNumber) {
      return sendApiError(res, 400, 'Missing tracking number in FinerWorks shipment data');
    }

    const { shippingProvider, predefined } = resolveWixShippingProvider(carrierName);
    const trackingInfo = {
      trackingNumber,
      shippingProvider,
    };

    if (!predefined) {
      if (!trackingUrlRaw || !/^https?:\/\//i.test(trackingUrlRaw)) {
        return sendApiError(
          res,
          400,
          'Carrier is not a Wix predefined provider; provide a valid http(s) tracking_url from FinerWorks for trackingLink.'
        );
      }
      trackingInfo.trackingLink = trackingUrlRaw;
    } else if (trackingUrlRaw && /^https?:\/\//i.test(trackingUrlRaw)) {
      trackingInfo.trackingLink = trackingUrlRaw;
    }

    const createUrl = `${WIX_CREATE_FULFILLMENT_BASE}/${encodeURIComponent(orderId)}/create-fulfillment`;
    const createBody = {
      fulfillment: {
        lineItems,
        trackingInfo,
      },
    };

    const headers = buildAuthHeaders(wixAuth);
    const resp = await axios.post(createUrl, createBody, {
      headers,
      timeout: 120000,
      validateStatus: () => true,
    });

    if (resp.status >= 200 && resp.status < 300) {
      const fulfillmentId = resp.data?.fulfillment?.id || resp.data?.fulfillmentId || null;
      const successLog = JSON.stringify({
        level: 'INFO',
        platform: 'wix',
        method: req.method,
        api: req.originalUrl || req.url,
        function: 'fulfillWixOrderWithTrackingInfo',
        operation: 'Wix order fulfillment created successfully',
        account_key: String(account_key).trim(),
        result: {
          orderId,
          orderNumber,
          fulfillmentId,
          trackingNumber,
          carrier: shippingProvider,
        },
        timestamp: new Date().toISOString()
      });
      console.log('Success in fulfillWixOrderWithTrackingInfo: %s', successLog);
      log('Success in fulfillWixOrderWithTrackingInfo: %s', successLog);
      return res.status(200).json({
        success: true,
        message: 'Wix order fulfillment created',
        data: resp.data,
      });
    }

    const wixPayload = summarizeWixHttpError(resp);
    return sendApiError(
      res,
      resp.status >= 400 ? resp.status : 502,
      'Failed to create Wix fulfillment',
      safeWixErrorData(wixPayload)
    );
  } catch (err) {
    const isWixError = err?.response?.config?.url?.includes('wixapis.com') || err?.config?.url?.includes('wixapis.com');
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'wix',
      source: isWixError ? 'wix_api' : (isFinerworksError ? 'finerworks_api' : 'lambda'),
      function: 'fulfillWixOrderWithTrackingInfo',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      order_id: req.body?.order_id || req.body?.orderId || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Wix order fulfillment failed: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in fulfillWixOrderWithTrackingInfo: %s', errorJson);
    return sendApiError(res, err);
  }
};