const axios = require('axios');
const crypto = require('crypto');
const finerworksService = require('../helpers/finerworks-service');
const { sendApiError } = require('../helpers/api-error');
const {
  getSquareBaseUrl,
  refreshSquareTokensCore,
} = require('./square-auth');
const {
  resolveSquareAuth,
  buildSquareHeaders,
  summarizeSquareHttpError,
  syncSquareTokensToDynamo,
} = require('./square-products');
const debug = require('debug');
const log = debug('app:squareOrders');

const MAX_ORDER_SEARCH_PAGES = 100;
const SEARCH_ORDERS_PAGE_LIMIT = 100;
/** Square BatchRetrieveOrders accepts at most 100 order ids per call. */
const MAX_SQUARE_ORDER_BY_ID_BATCH = 100;

function toIsoOrNull(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
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

/** Non-empty trimmed strings; skips null/empty entries (does not 400 on those). */
function normalizeOrderIdArray(raw) {
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
 * Many clients/API gateways pass multiple order ids as a string (JSON array or CSV).
 * Accept those so batch mode still runs.
 */
function coerceOrderIdRaw(raw) {
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
 * Wraps Square calls with one retry on 401 using the stored refresh token
 * (same pattern as square-products sync).
 */
function createSquareAuthRetry(account_key, initialAuth) {
  let squareAuth = initialAuth;
  let headers = buildSquareHeaders(squareAuth.accessToken);
  let triedRefresh = false;

  const withAuthRetry = async (doCall) => {
    let r = await doCall(headers);
    if (r.status === 401 && squareAuth.refreshToken && !triedRefresh) {
      triedRefresh = true;
      try {
        const tokenData = await refreshSquareTokensCore(account_key, squareAuth.refreshToken);
        await syncSquareTokensToDynamo(account_key, tokenData, squareAuth.refreshToken);
        squareAuth = {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token || squareAuth.refreshToken,
          source: 'connections_refresh',
        };
        headers = buildSquareHeaders(squareAuth.accessToken);
        r = await doCall(headers);
      } catch (refreshErr) {
        log('mid-request Square token refresh failed', {
          account_key,
          message: refreshErr?.message,
        });
      }
    }
    return r;
  };

  return { withAuthRetry, getAuth: () => squareAuth };
}

/**
 * SearchOrders requires location_ids (max 10 per call). Resolve the merchant's
 * locations, honoring an explicit location_id override when provided.
 */
async function resolveSquareLocationIds({ baseUrl, withAuthRetry, explicitLocationId }) {
  const locResp = await withAuthRetry((h) =>
    axios.get(`${baseUrl}/v2/locations`, { headers: h, timeout: 30000, validateStatus: () => true })
  );
  if (locResp.status < 200 || locResp.status >= 300) {
    const err = new Error('Failed to list Square locations');
    err.response = locResp;
    throw err;
  }
  const locations = Array.isArray(locResp?.data?.locations) ? locResp.data.locations : [];
  if (explicitLocationId) {
    const found = locations.find((l) => String(l?.id || '') === String(explicitLocationId).trim());
    return found ? [found.id] : [];
  }
  return locations.map((l) => l?.id).filter(Boolean);
}

/**
 * Pages through POST /v2/orders/search for one batch of location ids.
 * When filtering by a time range Square requires sorting on the same field,
 * so the created_at filter is paired with a CREATED_AT sort.
 */
async function searchSquareOrdersForLocations({
  baseUrl,
  withAuthRetry,
  locationIds,
  startIso,
  endIso,
}) {
  const orders = [];
  let cursor = null;

  for (let page = 0; page < MAX_ORDER_SEARCH_PAGES; page++) {
    const body = {
      location_ids: locationIds,
      limit: SEARCH_ORDERS_PAGE_LIMIT,
      return_entries: false,
      query: {
        ...(startIso && endIso
          ? {
              filter: {
                date_time_filter: {
                  created_at: { start_at: startIso, end_at: endIso },
                },
              },
            }
          : {}),
        sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' },
      },
      ...(cursor ? { cursor } : {}),
    };

    const r = await withAuthRetry((h) =>
      axios.post(`${baseUrl}/v2/orders/search`, body, {
        headers: h,
        timeout: 120000,
        validateStatus: () => true,
      })
    );

    if (r.status < 200 || r.status >= 300) {
      const err = new Error('Square search orders failed');
      err.response = r;
      throw err;
    }

    const pageOrders = Array.isArray(r?.data?.orders) ? r.data.orders : [];
    orders.push(...pageOrders);

    if (!r?.data?.cursor) break;
    cursor = r.data.cursor;
  }

  return orders;
}

/** Square caps SearchOrders at 10 location_ids per call; batch across all locations. */
async function fetchAllSquareOrders({ baseUrl, withAuthRetry, locationIds, startIso, endIso }) {
  const orders = [];
  for (let i = 0; i < locationIds.length; i += 10) {
    const batch = locationIds.slice(i, i + 10);
    const batchOrders = await searchSquareOrdersForLocations({
      baseUrl,
      withAuthRetry,
      locationIds: batch,
      startIso,
      endIso,
    });
    orders.push(...batchOrders);
  }
  return orders;
}

function jsonSquareOrdersError(res, err, clientMessage) {
  const r = err?.response;
  const status = r?.status >= 400 && r?.status < 600 ? r.status : 502;
  return sendApiError(res, status, clientMessage, r ? summarizeSquareHttpError(r) : {});
}

/**
 * Lists Square orders, optionally filtered by created_at date range.
 * Mirrors POST /wix/orders shape: account_key (required), startDate/endDate
 * (optional pair), optional access_token override and location_id.
 *
 * Requires OAuth permission: ORDERS_READ.
 */
const getSquareOrders = async (req, res) => {
  try {
    const account_key =
      req.body?.account_key ||
      req.body?.accountKey ||
      req.query?.account_key ||
      req.query?.accountKey;

    const access_token =
      req.body?.access_token || req.query?.access_token || req.headers['x-square-access-token'];

    const explicitLocationId =
      req.body?.location_id || req.body?.locationId || req.query?.location_id || null;

    if (!account_key || !String(account_key).trim()) {
      return sendApiError(res, 400, 'account_key is required');
    }

    const squareAuth = await resolveSquareAuth({ account_key, access_token });
    if (!squareAuth?.accessToken) {
      return sendApiError(
        res,
        401,
        'Square credentials not configured. Connect Square for this account or pass access_token.'
      );
    }

    const startDate =
      req.body?.startDate || req.body?.start_date || req.query?.startDate || req.query?.start_date;
    const endDate =
      req.body?.endDate || req.body?.end_date || req.query?.endDate || req.query?.end_date;

    const { startIso, endIso } = parseDateRangeInputs(startDate, endDate);

    if ((startIso && !endIso) || (!startIso && endIso)) {
      return sendApiError(res, 400, 'Provide both startDate and endDate or omit both.');
    }

    const baseUrl = getSquareBaseUrl();
    const { withAuthRetry, getAuth } = createSquareAuthRetry(account_key, squareAuth);

    let locationIds;
    try {
      locationIds = await resolveSquareLocationIds({ baseUrl, withAuthRetry, explicitLocationId });
    } catch (locErr) {
      return jsonSquareOrdersError(res, locErr, 'Failed to list Square locations');
    }

    if (explicitLocationId && !locationIds.length) {
      return sendApiError(res, 400, `Square location_id ${explicitLocationId} not found`);
    }
    if (!locationIds.length) {
      return sendApiError(res, 400, 'No Square locations found for this merchant');
    }

    let orders;
    try {
      orders = await fetchAllSquareOrders({
        baseUrl,
        withAuthRetry,
        locationIds,
        startIso,
        endIso,
      });
    } catch (searchErr) {
      return jsonSquareOrdersError(res, searchErr, 'Failed to search Square orders');
    }

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'square',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'getSquareOrders',
      operation: 'Square orders list fetched successfully',
      account_key: String(account_key).trim(),
      result: orders.length <= 20
        ? { count: orders.length, orderIds: orders.map(o => o?.id), locationIds }
        : { count: orders.length, firstOrderIds: orders.slice(0, 5).map(o => o?.id), locationIds },
      timestamp: new Date().toISOString()
    });
    console.log('Success in getSquareOrders: %s', successLog);
    log('Success in getSquareOrders: %s', successLog);
    return res.status(200).json({
      success: true,
      squareAuthSource: getAuth().source,
      count: orders.length,
      orders,
    });
  } catch (err) {
    const isSquareError =
      err?.response?.config?.url?.includes('squareup') || err?.config?.url?.includes('squareup');
    const isFinerworksError =
      err?.response?.config?.url?.includes('finerworks.com') ||
      err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'square',
      source: isSquareError ? 'square_api' : (isFinerworksError ? 'finerworks_api' : 'lambda'),
      function: 'getSquareOrders',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to fetch Square orders: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.errors?.[0]?.detail || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in getSquareOrders: %s', errorJson);
    return sendApiError(res, err);
  }
};

async function fetchSquareOrderById({ baseUrl, withAuthRetry, orderId }) {
  const r = await withAuthRetry((h) =>
    axios.get(`${baseUrl}/v2/orders/${encodeURIComponent(orderId)}`, {
      headers: h,
      timeout: 120000,
      validateStatus: () => true,
    })
  );
  if (r.status >= 200 && r.status < 300) {
    return { ok: true, order: r?.data?.order ?? null, status: r.status };
  }
  const st = r.status >= 400 && r.status < 600 ? r.status : 502;
  return { ok: false, status: st, squarePayload: summarizeSquareHttpError(r) };
}

/**
 * Batch: one BatchRetrieveOrders call per 100 ids. Square omits unknown ids
 * from the response rather than erroring, so report them as not_found.
 */
async function fetchSquareOrdersByIdList(res, { baseUrl, withAuthRetry }, orderIdList, logContext = {}) {
  const uniqueIds = [...new Set(orderIdList)];
  const byId = new Map();

  for (let i = 0; i < uniqueIds.length; i += MAX_SQUARE_ORDER_BY_ID_BATCH) {
    const batch = uniqueIds.slice(i, i + MAX_SQUARE_ORDER_BY_ID_BATCH);
    const r = await withAuthRetry((h) =>
      axios.post(
        `${baseUrl}/v2/orders/batch-retrieve`,
        { order_ids: batch },
        { headers: h, timeout: 120000, validateStatus: () => true }
      )
    );
    if (r.status < 200 || r.status >= 300) {
      const st = r.status >= 400 && r.status < 600 ? r.status : 502;
      sendApiError(res, st, 'Failed to batch-retrieve Square orders', summarizeSquareHttpError(r));
      return;
    }
    const orders = Array.isArray(r?.data?.orders) ? r.data.orders : [];
    for (const o of orders) {
      if (o?.id && !byId.has(o.id)) byId.set(o.id, o);
    }
  }

  const ordersOut = [];
  const notFound = [];
  for (const id of orderIdList) {
    const o = byId.get(id);
    if (o) ordersOut.push(o);
    else notFound.push(id);
  }

  const payload = { success: true, count: ordersOut.length, orders: ordersOut };
  if (notFound.length > 0) payload.not_found = notFound;
  const { account_key = 'unknown', req = {} } = logContext;
  const successLog = JSON.stringify({
    level: 'INFO',
    platform: 'square',
    method: req.method || 'UNKNOWN',
    api: req.originalUrl || req.url || 'unknown',
    function: 'getSquareOrderById',
    operation: 'Square orders fetched by id list',
    account_key,
    result: ordersOut.length <= 20
      ? { count: ordersOut.length, orderIds: ordersOut.map(o => o?.id), not_found: notFound }
      : { count: ordersOut.length, firstOrderIds: ordersOut.slice(0, 5).map(o => o?.id), not_found_count: notFound.length },
    timestamp: new Date().toISOString()
  });
  console.log('Success in getSquareOrderById (batch): %s', successLog);
  log('Success in getSquareOrderById (batch): %s', successLog);
  res.status(200).json(payload);
}

/**
 * Fetches order(s) by Square order id.
 *
 * Body: account_key (required), order_id (string or array of up to 100 ids);
 * optional access_token override. Arrays return `{ orders, count, not_found? }`.
 *
 * Requires OAuth permission: ORDERS_READ.
 */
const getSquareOrderById = async (req, res) => {
  try {
    const account_key =
      req.body?.account_key ||
      req.body?.accountKey ||
      req.query?.account_key ||
      req.query?.accountKey;

    const access_token =
      req.body?.access_token || req.query?.access_token || req.headers['x-square-access-token'];

    const orderIdRaw = coerceOrderIdRaw(
      req.body?.order_id ??
        req.body?.orderId ??
        req.body?.order_ids ??
        req.body?.orderIds ??
        req.query?.order_id ??
        req.query?.orderId ??
        null
    );

    if (!account_key || !String(account_key).trim()) {
      return sendApiError(res, 400, 'account_key is required');
    }

    const isOrderIdArray = Array.isArray(orderIdRaw);
    const orderIdList = isOrderIdArray ? normalizeOrderIdArray(orderIdRaw) : null;
    const orderIdTrim =
      !isOrderIdArray && orderIdRaw !== undefined && orderIdRaw !== null && String(orderIdRaw).trim()
        ? String(orderIdRaw).trim()
        : null;

    if (!orderIdTrim && !(isOrderIdArray && orderIdList.length > 0)) {
      return sendApiError(res, 400, 'Missing required parameter: order_id');
    }

    if (isOrderIdArray && orderIdList.length > MAX_SQUARE_ORDER_BY_ID_BATCH) {
      return sendApiError(
        res,
        400,
        `order_id array must have at most ${MAX_SQUARE_ORDER_BY_ID_BATCH} entries`
      );
    }

    const squareAuth = await resolveSquareAuth({ account_key, access_token });
    if (!squareAuth?.accessToken) {
      return sendApiError(
        res,
        401,
        'Square credentials not configured. Connect Square for this account or pass access_token.'
      );
    }

    const baseUrl = getSquareBaseUrl();
    const { withAuthRetry } = createSquareAuthRetry(account_key, squareAuth);

    if (isOrderIdArray && orderIdList.length > 0) {
      await fetchSquareOrdersByIdList(
        res,
        { baseUrl, withAuthRetry },
        orderIdList,
        { account_key: String(account_key).trim(), req }
      );
      return;
    }

    const fetchResult = await fetchSquareOrderById({ baseUrl, withAuthRetry, orderId: orderIdTrim });

    if (!fetchResult.ok) {
      if (fetchResult.status === 404) {
        return sendApiError(res, 404, `Order not found for order_id: ${orderIdTrim}`, {
          orderId: orderIdTrim,
          ...fetchResult.squarePayload,
        });
      }
      return sendApiError(
        res,
        fetchResult.status,
        'Failed to retrieve Square order by id',
        fetchResult.squarePayload
      );
    }

    const order = fetchResult.order;
    if (!order) {
      return sendApiError(res, 502, 'Square returned an empty order payload');
    }

    const orderKeyCount = order && typeof order === 'object' ? Object.keys(order).length : 0;
    const orderSummary = orderKeyCount <= 20
      ? order
      : { id: order?.id, state: order?.state, location_id: order?.location_id, lineItemsCount: Array.isArray(order?.line_items) ? order.line_items.length : undefined };
    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'square',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'getSquareOrderById',
      operation: 'Square order fetched by order id',
      account_key: String(account_key).trim(),
      result: orderSummary,
      timestamp: new Date().toISOString()
    });
    console.log('Success in getSquareOrderById: %s', successLog);
    log('Success in getSquareOrderById: %s', successLog);
    return res.status(200).json({ success: true, order });
  } catch (err) {
    const isSquareError =
      err?.response?.config?.url?.includes('squareup') || err?.config?.url?.includes('squareup');
    const isFinerworksError =
      err?.response?.config?.url?.includes('finerworks.com') ||
      err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'square',
      source: isSquareError ? 'square_api' : (isFinerworksError ? 'finerworks_api' : 'lambda'),
      function: 'getSquareOrderById',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to fetch Square order by id: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.errors?.[0]?.detail || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in getSquareOrderById: %s', errorJson);
    return sendApiError(res, err);
  }
};

/** First SHIPMENT fulfillment on the order (tracking updates attach to it), or null. */
function findShipmentFulfillment(order) {
  const fulfillments = Array.isArray(order?.fulfillments) ? order.fulfillments : [];
  return fulfillments.find((f) => String(f?.type || '').toUpperCase() === 'SHIPMENT') || null;
}

/**
 * Like POST /wix/fulfill-order and /squarespace/fulfill-order: loads tracking from FinerWorks
 * GET_ORDER_STATUS, then marks the Square order shipped. Square has no separate fulfillment
 * endpoint — the order itself is sparse-updated (PUT /v2/orders/{order_id} with the current
 * `version`) setting a SHIPMENT fulfillment to COMPLETED with shipment_details tracking info.
 *
 * Body/query: account_key (required), order_id (Square order id), orderNumber (FinerWorks
 * order_pos key). Optional: access_token override.
 *
 * Requires OAuth permission: ORDERS_WRITE.
 */
const fulfillSquareOrderWithTrackingInfo = async (req, res) => {
  try {
    const account_key =
      req.body?.account_key ||
      req.body?.accountKey ||
      req.query?.account_key ||
      req.query?.accountKey;

    const access_token =
      req.body?.access_token || req.query?.access_token || req.headers['x-square-access-token'];

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
      return sendApiError(res, 400, 'Missing required parameter: order_id (Square order id)');
    }
    if (!orderNumberRaw || !String(orderNumberRaw).trim()) {
      return sendApiError(
        res,
        400,
        'Missing required parameter: orderNumber (used for FinerWorks GET_ORDER_STATUS)'
      );
    }

    const orderId = String(orderIdRaw).trim();
    const orderNumber = String(orderNumberRaw).trim();

    const squareAuth = await resolveSquareAuth({ account_key, access_token });
    if (!squareAuth?.accessToken) {
      return sendApiError(
        res,
        401,
        'Square credentials not configured. Connect Square for this account or pass access_token.'
      );
    }

    const baseUrl = getSquareBaseUrl();
    const { withAuthRetry } = createSquareAuthRetry(account_key, squareAuth);

    const orderFetch = await fetchSquareOrderById({ baseUrl, withAuthRetry, orderId });
    if (!orderFetch.ok) {
      if (orderFetch.status === 404) {
        return sendApiError(res, 404, `Square order not found for order_id: ${orderId}`, {
          orderId,
          ...orderFetch.squarePayload,
        });
      }
      return sendApiError(
        res,
        orderFetch.status,
        'Failed to load Square order before fulfillment',
        orderFetch.squarePayload
      );
    }

    const squareOrder = orderFetch.order;
    if (!squareOrder) {
      return sendApiError(res, 502, 'Square returned an empty order payload');
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
        platform: 'square',
        source: 'finerworks_api',
        function: 'fulfillSquareOrderWithTrackingInfo',
        account_key: req.body?.account_key || req.query?.account_key || 'unknown',
        orderId,
        orderNumber,
        httpStatus: error?.response?.status || null,
        message: `Failed to fetch order status from FinerWorks: ${error?.message || 'Unknown error'}`,
        detail: error?.response?.data?.message || null,
        timestamp: new Date().toISOString()
      });
      console.error(errorJson);
      log('Formatted error in fulfillSquareOrderWithTrackingInfo: %s', errorJson);
      return sendApiError(res, error);
    }
    console.log('shipment', orderStatusData)
    const shipment = orderStatusData?.orders?.[0]?.shipments?.[0] || {};
    const trackingNumber =
      shipment?.tracking_number != null ? String(shipment.tracking_number).trim() : '12345';
    const trackingUrlRaw =
      shipment?.tracking_url != null ? String(shipment.tracking_url).trim() : 'https://www.finerworks.com';
    const carrierName = shipment?.carrier != null ? String(shipment.carrier).trim() : 'FedEx';
    const shippedAtIso = toIsoOrNull(shipment?.shipment_date);

    if (!trackingNumber) {
      return sendApiError(res, 400, 'Missing tracking number in FinerWorks shipment data');
    }

    const shipmentDetails = {
      tracking_number: trackingNumber,
      ...(carrierName ? { carrier: carrierName } : {}),
      ...(trackingUrlRaw && /^https?:\/\//i.test(trackingUrlRaw)
        ? { tracking_url: trackingUrlRaw }
        : {}),
      ...(shippedAtIso ? { shipped_at: shippedAtIso } : {}),
    };

    const existingShipment = findShipmentFulfillment(squareOrder);
    const fulfillmentPatch = {
      ...(existingShipment?.uid ? { uid: existingShipment.uid } : {}),
      type: 'SHIPMENT',
      state: 'COMPLETED',
      shipment_details: shipmentDetails,
    };

    const updateBody = {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: squareOrder.location_id,
        version: squareOrder.version,
        fulfillments: [fulfillmentPatch],
      },
    };

    const r = await withAuthRetry((h) =>
      axios.put(`${baseUrl}/v2/orders/${encodeURIComponent(orderId)}`, updateBody, {
        headers: h,
        timeout: 120000,
        validateStatus: () => true,
      })
    );

    if (r.status < 200 || r.status >= 300) {
      const st = r.status >= 400 && r.status < 600 ? r.status : 502;
      return sendApiError(
        res,
        st,
        'Failed to update Square order fulfillment',
        summarizeSquareHttpError(r)
      );
    }

    const updatedOrder = r?.data?.order ?? null;
    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'square',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'fulfillSquareOrderWithTrackingInfo',
      operation: 'Square order fulfilled with tracking info successfully',
      account_key: String(account_key).trim(),
      result: {
        orderId,
        orderNumber,
        fulfillmentUid: existingShipment?.uid || updatedOrder?.fulfillments?.[0]?.uid || null,
        trackingNumber,
        trackingUrl: shipmentDetails.tracking_url || null,
        carrier: carrierName || null,
        shippedAt: shippedAtIso,
      },
      timestamp: new Date().toISOString()
    });
    console.log('Success in fulfillSquareOrderWithTrackingInfo: %s', successLog);
    log('Success in fulfillSquareOrderWithTrackingInfo: %s', successLog);
    return res.status(200).json({
      success: true,
      message: 'Square order fulfilled with tracking info',
      data: r.data,
    });
  } catch (err) {
    const isSquareError =
      err?.response?.config?.url?.includes('squareup') || err?.config?.url?.includes('squareup');
    const isFinerworksError =
      err?.response?.config?.url?.includes('finerworks.com') ||
      err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'square',
      source: isSquareError ? 'square_api' : (isFinerworksError ? 'finerworks_api' : 'lambda'),
      function: 'fulfillSquareOrderWithTrackingInfo',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      orderId: req.body?.order_id || req.body?.orderId || req.query?.order_id || 'unknown',
      orderNumber: req.body?.orderNumber || req.query?.orderNumber || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Square order fulfillment failed: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.errors?.[0]?.detail || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in fulfillSquareOrderWithTrackingInfo: %s', errorJson);
    return sendApiError(res, err);
  }
};

module.exports = {
  getSquareOrders,
  getSquareOrderById,
  fulfillSquareOrderWithTrackingInfo,
  // Shared Square order helpers (used by the order.created webhook receiver)
  createSquareAuthRetry,
  fetchSquareOrderById,
};
