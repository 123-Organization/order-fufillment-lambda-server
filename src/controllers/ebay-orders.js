const finerworksService = require('../helpers/finerworks-service');
const { sendApiError } = require('../helpers/api-error');
const { ebayApiCall, isOk, ebayError, summarizeEbayHttpError, isEbayUrl } = require('../helpers/ebay-api');
const { resolveEbayAuth, getEbayConnection } = require('./ebay-auth');
const { submitEbayOrderToFinerWorks } = require('../helpers/ebay-order-webhook');
const { scanAllEbayAccounts } = require('../helpers/ebay-accounts-dynamo');
const debug = require('debug');
const log = debug('app:ebayOrders');

/**
 * eBay Fulfillment API (seller orders):
 *   GET  /sell/fulfillment/v1/order                      list/search (filter by creation date + fulfillment status)
 *   GET  /sell/fulfillment/v1/order?orderIds=a,b          up to 50 specific orders
 *   GET  /sell/fulfillment/v1/order/{orderId}             one order
 *   POST /sell/fulfillment/v1/order/{orderId}/shipping_fulfillment   tracking -> marks line items shipped
 *
 * Order statuses: orderFulfillmentStatus NOT_STARTED | IN_PROGRESS | FULFILLED,
 *                 orderPaymentStatus PAID | PENDING | FAILED | FULLY_REFUNDED | PARTIALLY_REFUNDED.
 */
const ORDER_PATH = '/sell/fulfillment/v1/order';

function toIso(v, endOfDay = false) {
  if (v == null || String(v).trim() === '') return null;
  const t = String(v).trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : t;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Builds the Fulfillment API `filter` param, e.g. creationdate:[a..b],orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS} */
function buildOrderFilter({ from, to, fulfillmentStatuses }) {
  const parts = [];
  // eBay rejects any creationdate in the future ("The start and end dates can't be in the
  // future"), and an endDate of today expands to 23:59:59.999Z — so cap both at "now".
  const now = new Date().toISOString();
  if (to && to > now) to = now;
  if (from && from > now) from = now;
  if (from || to) parts.push(`creationdate:[${from || ''}..${to || ''}]`);
  if (fulfillmentStatuses?.length) parts.push(`orderfulfillmentstatus:{${fulfillmentStatuses.join('|')}}`);
  return parts.join(',') || undefined;
}

/** Pages through getOrders (max 200 per page) up to `maxOrders`. */
async function listEbayOrders(accessToken, { filter, maxOrders = 1000 }) {
  const orders = [];
  let offset = 0;
  const limit = 200;
  for (let page = 0; page < 50 && orders.length < maxOrders; page++) {
    const r = await ebayApiCall({ method: 'GET', path: ORDER_PATH, accessToken, params: { filter, limit, offset } });
    if (!isOk(r)) throw ebayError('eBay order search failed', r);
    const pageOrders = Array.isArray(r.data?.orders) ? r.data.orders : [];
    orders.push(...pageOrders);
    const total = Number(r.data?.total) || 0;
    offset += limit;
    if (!pageOrders.length || offset >= total) break;
  }
  return orders.slice(0, maxOrders);
}

async function fetchEbayOrder(accessToken, orderId) {
  const r = await ebayApiCall({ method: 'GET', path: `${ORDER_PATH}/${encodeURIComponent(orderId)}`, accessToken });
  if (r.status === 404) return null;
  if (!isOk(r)) throw ebayError('Failed to fetch eBay order', r);
  return r.data;
}

function logError(fn, req, err, message) {
  const errorJson = JSON.stringify({
    level: 'ERROR',
    platform: 'ebay',
    source: isEbayUrl(err) || err?.response ? 'ebay_api' : 'lambda',
    function: fn,
    account_key: req.body?.account_key || req.query?.account_key || 'unknown',
    httpStatus: err?.response?.status || err?.status || null,
    message: `${message}: ${err?.message || 'Unknown error'}`,
    detail: err?.data || summarizeEbayHttpError(err),
    timestamp: new Date().toISOString(),
  });
  console.error(errorJson);
  log('Formatted error in %s: %s', fn, errorJson);
}

/**
 * POST /ebay/orders — list a seller's eBay orders.
 * Body/query: account_key (required), startDate + endDate (optional, YYYY-MM-DD or ISO; both or
 * neither), fulfillment_status (optional: NOT_STARTED, IN_PROGRESS, FULFILLED; comma-separated).
 * Response: { success, count, orders } (same shape as the other platforms).
 */
const getEbayOrders = async (req, res) => {
  try {
    const account_key = req.body?.account_key || req.query?.account_key;
    const startDate = req.body?.startDate || req.body?.start_date || req.query?.startDate || req.query?.start_date;
    const endDate = req.body?.endDate || req.body?.end_date || req.query?.endDate || req.query?.end_date;
    const statusRaw = req.body?.fulfillment_status || req.query?.fulfillment_status || req.body?.order_status || null;
    if ((startDate && !endDate) || (!startDate && endDate)) {
      return sendApiError(res, 400, 'Provide both startDate and endDate or omit both.');
    }
    const fulfillmentStatuses = (Array.isArray(statusRaw) ? statusRaw : String(statusRaw || '').split(','))
      .map((s) => String(s).trim().toUpperCase())
      .filter(Boolean);

    const { accessToken } = await resolveEbayAuth(account_key);
    const filter = buildOrderFilter({ from: toIso(startDate), to: toIso(endDate, true), fulfillmentStatuses });
    const orders = await listEbayOrders(accessToken, { filter });

    console.log(JSON.stringify({
      level: 'INFO',
      platform: 'ebay',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'getEbayOrders',
      operation: 'eBay orders fetched',
      account_key: String(account_key).trim(),
      result: { count: orders.length },
      timestamp: new Date().toISOString(),
    }));
    return res.status(200).json({ success: true, count: orders.length, orders });
  } catch (err) {
    logError('getEbayOrders', req, err, 'Failed to fetch eBay orders');
    return sendApiError(res, err?.status || 500, err?.message || 'Unknown error', err?.data);
  }
};

/**
 * POST /ebay/order-by-id — one order ({ order }) or up to 50 ({ count, orders }).
 * Body/query: account_key, order_id or order_ids (array or comma-separated).
 */
const getEbayOrderById = async (req, res) => {
  try {
    const account_key = req.body?.account_key || req.query?.account_key;
    const idsRaw = req.body?.order_ids || req.query?.order_ids || req.body?.order_id || req.query?.order_id;
    const ids = (Array.isArray(idsRaw) ? idsRaw : String(idsRaw || '').split(','))
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (!ids.length) return sendApiError(res, 400, 'Missing required parameter: order_id or order_ids');
    if (ids.length > 50) return sendApiError(res, 400, 'order_ids must have at most 50 entries');

    const { accessToken } = await resolveEbayAuth(account_key);
    if (ids.length === 1) {
      const order = await fetchEbayOrder(accessToken, ids[0]);
      if (!order) return sendApiError(res, 404, `Order not found for id: ${ids[0]}`);
      return res.status(200).json({ success: true, order });
    }
    const r = await ebayApiCall({ method: 'GET', path: ORDER_PATH, accessToken, params: { orderIds: ids.join(',') } });
    if (!isOk(r)) throw ebayError('Failed to fetch eBay orders', r);
    const orders = Array.isArray(r.data?.orders) ? r.data.orders : [];
    return res.status(200).json({ success: true, count: orders.length, orders });
  } catch (err) {
    logError('getEbayOrderById', req, err, 'Failed to fetch eBay order by id');
    return sendApiError(res, err?.status || 500, err?.message || 'Unknown error', err?.data);
  }
};

/** FinerWorks carrier text -> eBay shippingCarrierCode. Unknown carriers pass through as-is. */
function toEbayCarrierCode(carrier) {
  const c = String(carrier || '').trim();
  const k = c.toLowerCase().replace(/[^a-z]/g, '');
  if (!k) return null;
  if (k.startsWith('usps') || k.includes('postal')) return 'USPS';
  if (k.startsWith('ups')) return 'UPS';
  if (k.startsWith('fedex') || k.startsWith('federalexpress')) return 'FedEx';
  if (k.startsWith('dhl')) return 'DHL';
  if (k.startsWith('ontrac')) return 'OnTrac';
  if (k.startsWith('canadapost')) return 'CanadaPost';
  return c;
}

/**
 * POST /ebay/fulfill-order — pushes tracking to eBay (marks the line items shipped).
 * Also the FinerWorks order-status callback URL attached to every eBay order we submit.
 *
 * Body/query:
 *   account_key, order_id (eBay order id) — required
 *   trackingNumber + carrier (shipping_carrier_code) — or orderNumber (FinerWorks order_po) to
 *     read the tracking number + carrier from FinerWorks GET_ORDER_STATUS
 *   line_items (optional) — [{ lineItemId, quantity }]; default: every line item not yet fulfilled
 *   shipped_date (optional ISO; default now)
 */
const fulfillEbayOrderWithTrackingInfo = async (req, res) => {
  const flog = (step, message, data) => {
    if (data === undefined) console.log(`[eBay fulfill] ${step} ${message}`);
    else console.log(`[eBay fulfill] ${step} ${message}`, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  };
  try {
    const account_key = req.body?.account_key || req.query?.account_key;
    const order_id = req.body?.order_id || req.query?.order_id;
    const orderNumber = req.body?.orderNumber || req.query?.orderNumber || req.body?.order_po || null;
    let trackingNumber = req.body?.trackingNumber || req.body?.tracking_number || null;
    let carrier = req.body?.carrier || req.body?.shipping_carrier_code || req.query?.carrier || null;
    flog('1', 'Request', { account_key, order_id, orderNumber, trackingNumber, carrier });
    if (!order_id) return sendApiError(res, 400, 'Missing required parameter: order_id');

    const { accessToken } = await resolveEbayAuth(account_key);

    if ((!trackingNumber || !carrier) && orderNumber) {
      const status = await finerworksService.GET_ORDER_STATUS({ order_pos: [orderNumber], account_key: String(account_key).trim() });
      const shipment = status?.orders?.[0]?.shipments?.[0] || null;
      flog('2', 'FinerWorks shipment', { status: status?.orders?.[0]?.order_status_label || null, shipment });
      trackingNumber = trackingNumber || shipment?.tracking_number || null;
      carrier = carrier || shipment?.carrier || shipment?.shipping_carrier || shipment?.ship_method || null;
    }
    if (!trackingNumber) {
      return sendApiError(res, 400, 'Missing trackingNumber (or orderNumber of a shipped FinerWorks order)');
    }
    const shippingCarrierCode = toEbayCarrierCode(carrier);
    if (!shippingCarrierCode) {
      return sendApiError(res, 400, 'Missing carrier (e.g. USPS, UPS, FedEx, DHL)');
    }

    const order = await fetchEbayOrder(accessToken, order_id);
    if (!order) return sendApiError(res, 404, `eBay order not found for id: ${order_id}`);

    let lineItems = Array.isArray(req.body?.line_items) && req.body.line_items.length
      ? req.body.line_items.map((li) => ({ lineItemId: String(li.lineItemId || li.line_item_id), quantity: Number(li.quantity) || 1 }))
      : (order.lineItems || [])
        .filter((li) => String(li?.lineItemFulfillmentStatus || '').toUpperCase() !== 'FULFILLED')
        .map((li) => ({ lineItemId: String(li.lineItemId), quantity: Number(li.quantity) || 1 }));
    lineItems = lineItems.filter((li) => li.lineItemId && li.lineItemId !== 'undefined');
    if (!lineItems.length) {
      return sendApiError(res, 409, 'All line items on this eBay order are already marked shipped');
    }

    const body = {
      lineItems,
      shippedDate: toIso(req.body?.shipped_date) || new Date().toISOString(),
      shippingCarrierCode,
      trackingNumber: String(trackingNumber).trim(),
    };
    flog('3', 'Calling eBay createShippingFulfillment', body);
    const r = await ebayApiCall({
      method: 'POST',
      path: `${ORDER_PATH}/${encodeURIComponent(order_id)}/shipping_fulfillment`,
      accessToken,
      body,
    });
    flog('4', `eBay response HTTP ${r.status}`, isOk(r) ? (r.headers?.location || '') : summarizeEbayHttpError({ response: r }));
    if (!isOk(r)) throw ebayError('Failed to add tracking to the eBay order', r);
    const fulfillmentId = String(r.headers?.location || '').split('/').pop() || null;

    console.log(JSON.stringify({
      level: 'INFO',
      platform: 'ebay',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'fulfillEbayOrderWithTrackingInfo',
      operation: 'eBay order marked shipped with tracking',
      account_key: String(account_key).trim(),
      result: { order_id, trackingNumber: body.trackingNumber, shippingCarrierCode, fulfillmentId },
      timestamp: new Date().toISOString(),
    }));
    return res.status(200).json({
      success: true,
      message: 'eBay order fulfilled with tracking info',
      fulfillmentId,
      trackingNumber: body.trackingNumber,
      shippingCarrierCode,
      lineItems,
    });
  } catch (err) {
    flog('ERR', err?.message || 'Unknown error', err?.data);
    logError('fulfillEbayOrderWithTrackingInfo', req, err, 'eBay order fulfillment failed');
    return sendApiError(res, err?.status || 500, err?.message || 'Unknown error', err?.data);
  }
};

/**
 * Checks one account's recent eBay orders and submits every paid, unshipped order that
 * FinerWorks doesn't have yet. Shared by POST /ebay/sync-orders and the scheduled job.
 */
async function syncRecentEbayOrdersForAccount(account_key, { lookbackHours } = {}) {
  const hours = Number(lookbackHours) > 0 ? Number(lookbackHours) : Number(process.env.EBAY_ORDER_POLL_LOOKBACK_HOURS) || 48;
  const { accessToken } = await resolveEbayAuth(account_key);
  const from = new Date(Date.now() - hours * 3600_000).toISOString();
  const orders = await listEbayOrders(accessToken, {
    filter: buildOrderFilter({ from, fulfillmentStatuses: ['NOT_STARTED', 'IN_PROGRESS'] }),
    maxOrders: 500,
  });
  const results = [];
  for (const order of orders) {
    const result = await submitEbayOrderToFinerWorks(order, account_key, {
      trace: (step, message) => log('[eBay sync %s] %s %s', account_key, step, message),
    });
    results.push({ orderId: order.orderId, status: result.status, reason: result.reason || null, order_po: result.order_po || null });
  }
  return {
    lookbackHours: hours,
    checked: orders.length,
    submitted: results.filter((r) => r.status === 'submitted').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
  };
}

/**
 * POST /ebay/sync-orders — run the order check now for one account (works whether or not order
 * sync is on; useful for testing and for catching up). Body: { account_key, lookback_hours? }.
 */
const syncEbayOrders = async (req, res) => {
  try {
    const account_key = req.body?.account_key || req.query?.account_key;
    if (!account_key) return sendApiError(res, 400, 'Missing required parameter: account_key');
    const summary = await syncRecentEbayOrdersForAccount(String(account_key).trim(), {
      lookbackHours: req.body?.lookback_hours || req.query?.lookback_hours,
    });
    console.log(JSON.stringify({
      level: 'INFO',
      platform: 'ebay',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'syncEbayOrders',
      operation: 'eBay order check completed',
      account_key: String(account_key).trim(),
      result: { checked: summary.checked, submitted: summary.submitted, skipped: summary.skipped, failed: summary.failed },
      timestamp: new Date().toISOString(),
    }));
    return res.status(200).json({ success: summary.failed === 0, ...summary });
  } catch (err) {
    logError('syncEbayOrders', req, err, 'eBay order check failed');
    return sendApiError(res, err?.status || 500, err?.message || 'Unknown error', err?.data);
  }
};

/**
 * Scheduled job (EventBridge input {"ebayOrderPoll": true}): runs the order check for every
 * account in the eBay registry whose connection has order sync on. Safety net for the
 * notification webhook (and the only path if the order notification topic isn't available).
 */
async function runEbayOrderPollJob() {
  const rows = await scanAllEbayAccounts();
  const keys = [...new Set(rows.filter((r) => r?.account_key && r?.order_sync === true).map((r) => String(r.account_key).trim()))];
  const summary = { accounts: keys.length, submitted: 0, failed: 0, errors: [] };
  for (const key of keys) {
    try {
      const conn = await getEbayConnection(key);
      const data = conn || {};
      if (!conn || data.order_sync !== true) continue; // FinerWorks connection is the source of truth
      const r = await syncRecentEbayOrdersForAccount(key);
      summary.submitted += r.submitted;
      summary.failed += r.failed;
    } catch (e) {
      summary.errors.push({ account_key: key, message: e?.message || 'Unknown error' });
    }
  }
  console.log(JSON.stringify({ level: 'INFO', platform: 'ebay', function: 'runEbayOrderPollJob', result: summary, timestamp: new Date().toISOString() }));
  return summary;
}

module.exports = {
  getEbayOrders,
  getEbayOrderById,
  fulfillEbayOrderWithTrackingInfo,
  syncEbayOrders,
  runEbayOrderPollJob,
  syncRecentEbayOrdersForAccount,
  fetchEbayOrder,
  toEbayCarrierCode,
  buildOrderFilter,
};
