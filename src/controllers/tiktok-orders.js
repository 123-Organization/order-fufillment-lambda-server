const finerworksService = require('../helpers/finerworks-service');
const { sendApiError } = require('../helpers/api-error');
const { resolveTiktokShopAuth, tiktokShopCall, summarizeTiktokHttpError } = require('./tiktok-products');
const debug = require('debug');
const log = debug('app:tiktokOrders');

/**
 * TikTok Shop Order + Fulfillment APIs — paths/shapes confirmed against two independent,
 * current-version-pinned community SDKs (EcomPHP PHP client, hsib19 TypeScript SDK), both
 * agreeing exactly on method/path/field names; see tiktok-auth.js's header comment for the
 * same confirmation approach used on the OAuth side.
 *
 * Order status values are strings: UNPAID, ON_HOLD, AWAITING_SHIPMENT, AWAITING_COLLECTION,
 * PARTIALLY_SHIPPING, IN_TRANSIT, DELIVERED, COMPLETED, CANCELLED.
 */

/** `YYYY-MM-DD` or any parseable date -> Unix seconds (TikTok's create_time_ge/lt are epoch seconds,
 * unlike most other platforms in this codebase which use ISO strings). */
function toEpochSeconds(v, endOfDay = false) {
  if (v == null || String(v).trim() === '') return null;
  const t = String(v).trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : t;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

/**
 * Lists/searches TikTok Shop orders for a shop.
 *
 * Mirrors the other platforms' POST /<platform>/orders: account_key required, optional
 * shop_cipher/shop_id when the account has multiple authorized shops, startDate/endDate
 * (mapped to TikTok's create_time_ge/create_time_lt), order_status filter. Response shape
 * matches unified-orders.js's expectation ({success, count, orders}).
 */
const getTiktokOrders = async (req, res) => {
  try {
    const account_key = req.body?.account_key || req.query?.account_key;
    const shop_cipher = req.body?.shop_cipher || req.query?.shop_cipher;
    const shop_id = req.body?.shop_id || req.query?.shop_id;
    const startDate = req.body?.startDate || req.body?.start_date || req.query?.startDate || req.query?.start_date;
    const endDate = req.body?.endDate || req.body?.end_date || req.query?.endDate || req.query?.end_date;
    const order_status = req.body?.order_status || req.query?.order_status || null;
    const pageSize = Math.min(Number(req.body?.page_size || req.query?.page_size) || 50, 100);

    if ((startDate && !endDate) || (!startDate && endDate)) {
      return sendApiError(res, 400, 'Provide both startDate and endDate or omit both.');
    }

    const { accessToken, shopCipher } = await resolveTiktokShopAuth({ account_key, shop_cipher, shop_id });

    const body = {
      ...(order_status ? { order_status } : {}),
      ...(startDate && endDate
        ? { create_time_ge: toEpochSeconds(startDate), create_time_lt: toEpochSeconds(endDate, true) }
        : {}),
    };

    const orders = [];
    let pageToken = null;
    for (let page = 0; page < 50; page++) {
      const r = await tiktokShopCall({
        method: 'POST',
        path: '/order/202309/orders/search',
        accessToken,
        shopCipher,
        extraParams: { page_size: pageSize, ...(pageToken ? { page_token: pageToken } : {}) },
        body,
      });
      if (r.status < 200 || r.status >= 300 || r.data?.code !== 0) {
        const err = new Error('TikTok order search failed');
        err.response = r;
        throw err;
      }
      const pageOrders = Array.isArray(r.data?.data?.orders) ? r.data.data.orders : [];
      orders.push(...pageOrders);
      pageToken = r.data?.data?.next_page_token || null;
      if (!pageToken || !pageOrders.length) break;
    }

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'tiktok',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'getTiktokOrders',
      operation: 'TikTok Shop orders list fetched successfully',
      account_key: String(account_key).trim(),
      result: { count: orders.length, shopCipher },
      timestamp: new Date().toISOString(),
    });
    console.log(successLog);
    log('Success in getTiktokOrders: %s', successLog);

    return res.status(200).json({ success: true, count: orders.length, orders, shopCipher });
  } catch (err) {
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'tiktok',
      source: err?.response ? 'tiktok_api' : 'lambda',
      function: 'getTiktokOrders',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || err?.status || null,
      message: `Failed to fetch TikTok Shop orders: ${err?.message || 'Unknown error'}`,
      detail: summarizeTiktokHttpError(err),
      timestamp: new Date().toISOString(),
    });
    console.error(errorJson);
    log('Formatted error in getTiktokOrders: %s', errorJson);
    return sendApiError(res, err?.status || 500, err?.message || 'Unknown error', err?.data);
  }
};

/**
 * Fetches one or more specific TikTok Shop orders by id (GET /order/202309/orders?ids=...,
 * up to 50 at once — TikTok's own limit on this endpoint).
 * Expects body/query: { account_key, order_id } or { account_key, order_ids: [...] }.
 */
const getTiktokOrderById = async (req, res) => {
  try {
    const account_key = req.body?.account_key || req.query?.account_key;
    const shop_cipher = req.body?.shop_cipher || req.query?.shop_cipher;
    const shop_id = req.body?.shop_id || req.query?.shop_id;
    const idsRaw = req.body?.order_ids || req.query?.order_ids || req.body?.order_id || req.query?.order_id;
    const ids = (Array.isArray(idsRaw) ? idsRaw : String(idsRaw || '').split(','))
      .map((s) => String(s).trim())
      .filter(Boolean);

    if (!ids.length) {
      return sendApiError(res, 400, 'Missing required parameter: order_id or order_ids');
    }
    if (ids.length > 50) {
      return sendApiError(res, 400, 'order_ids must have at most 50 entries');
    }

    const { accessToken, shopCipher } = await resolveTiktokShopAuth({ account_key, shop_cipher, shop_id });

    const r = await tiktokShopCall({
      method: 'GET',
      path: '/order/202309/orders',
      accessToken,
      shopCipher,
      extraParams: { ids: ids.join(',') },
    });
    if (r.status < 200 || r.status >= 300 || r.data?.code !== 0) {
      return sendApiError(res, r.status >= 400 ? r.status : 502, 'Failed to fetch TikTok order detail', summarizeTiktokHttpError({ response: r }));
    }

    const orders = Array.isArray(r.data?.data?.orders) ? r.data.data.orders : [];
    log('Success in getTiktokOrderById: count=%d', orders.length);

    if (ids.length === 1) {
      if (!orders[0]) return sendApiError(res, 404, `Order not found for id: ${ids[0]}`);
      return res.status(200).json({ success: true, order: orders[0] });
    }
    return res.status(200).json({ success: true, count: orders.length, orders });
  } catch (err) {
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'tiktok',
      source: err?.response ? 'tiktok_api' : 'lambda',
      function: 'getTiktokOrderById',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || err?.status || null,
      message: `Failed to fetch TikTok Shop order by id: ${err?.message || 'Unknown error'}`,
      detail: summarizeTiktokHttpError(err),
      timestamp: new Date().toISOString(),
    });
    console.error(errorJson);
    log('Formatted error in getTiktokOrderById: %s', errorJson);
    return sendApiError(res, err?.status || 500, err?.message || 'Unknown error', err?.data);
  }
};

/**
 * Adds tracking info to a TikTok Shop order once FinerWorks has shipped it — the TikTok
 * equivalent of Square/Squarespace/Wix's "fulfill order with tracking info".
 *
 * Loads tracking from FinerWorks GET_ORDER_STATUS (same source the other platforms' fulfill
 * handlers use), then calls TikTok's shipping_info/update (confirmed path:
 * POST /fulfillment/202309/orders/{order_id}/shipping_info/update, body {tracking_number,
 * shipping_provider_id}) — this updates an already-created package/shipment's tracking rather
 * than performing the initial "ship package" handover flow, which needs a package_id and a
 * pickup/drop-off choice that doesn't fit this simpler, more common case.
 *
 * Expects body: { account_key, order_id, shipping_provider_id } (shipping_provider_id must be
 * a valid id from GET /logistics/202309/delivery_options/{id}/shipping_providers for this
 * shop — pass it explicitly; auto-resolving it needs a delivery_option_id this endpoint
 * doesn't otherwise require, and TikTok's valid providers vary by shop/region).
 */
const fulfillTiktokOrderWithTrackingInfo = async (req, res) => {
  try {
    const account_key = req.body?.account_key || req.query?.account_key;
    const shop_cipher = req.body?.shop_cipher || req.query?.shop_cipher;
    const shop_id = req.body?.shop_id || req.query?.shop_id;
    const order_id = req.body?.order_id || req.query?.order_id;
    const orderNumber = req.body?.orderNumber || req.body?.order_po || null;
    let shipping_provider_id = req.body?.shipping_provider_id || req.query?.shipping_provider_id;

    if (!order_id) {
      return sendApiError(res, 400, 'Missing required parameter: order_id');
    }

    const { accessToken, shopCipher } = await resolveTiktokShopAuth({ account_key, shop_cipher, shop_id });

    let trackingNumber = req.body?.trackingNumber || req.body?.tracking_number || null;
    if (!trackingNumber && orderNumber) {
      const orderStatusData = await finerworksService.GET_ORDER_STATUS({
        order_pos: [orderNumber],
        account_key: String(account_key).trim(),
      });
      trackingNumber = orderStatusData?.orders?.[0]?.shipments?.[0]?.tracking_number || null;
    }
    if (!trackingNumber) {
      return sendApiError(res, 400, 'Missing required parameter: trackingNumber (or orderNumber to look it up from FinerWorks)');
    }
    if (!shipping_provider_id) {
      return sendApiError(res, 400, 'Missing required parameter: shipping_provider_id (see GET /logistics/202309/delivery_options/{id}/shipping_providers for valid ids)');
    }

    const r = await tiktokShopCall({
      method: 'POST',
      path: `/fulfillment/202309/orders/${encodeURIComponent(order_id)}/shipping_info/update`,
      accessToken,
      shopCipher,
      body: { tracking_number: trackingNumber, shipping_provider_id },
    });
    if (r.status < 200 || r.status >= 300 || r.data?.code !== 0) {
      return sendApiError(res, r.status >= 400 ? r.status : 502, 'Failed to update TikTok Shop order tracking', summarizeTiktokHttpError({ response: r }));
    }

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'tiktok',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'fulfillTiktokOrderWithTrackingInfo',
      operation: 'TikTok Shop order fulfilled with tracking info successfully',
      account_key: String(account_key).trim(),
      result: { order_id, trackingNumber, shipping_provider_id },
      timestamp: new Date().toISOString(),
    });
    console.log(successLog);
    log('Success in fulfillTiktokOrderWithTrackingInfo: %s', successLog);

    return res.status(200).json({
      success: true,
      message: 'TikTok Shop order fulfilled with tracking info',
      data: r.data?.data || null,
    });
  } catch (err) {
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'tiktok',
      source: err?.response ? 'tiktok_api' : 'finerworks_api',
      function: 'fulfillTiktokOrderWithTrackingInfo',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      order_id: req.body?.order_id || req.query?.order_id || 'unknown',
      httpStatus: err?.response?.status || err?.status || null,
      message: `TikTok Shop order fulfillment failed: ${err?.message || 'Unknown error'}`,
      detail: summarizeTiktokHttpError(err),
      timestamp: new Date().toISOString(),
    });
    console.error(errorJson);
    log('Formatted error in fulfillTiktokOrderWithTrackingInfo: %s', errorJson);
    return sendApiError(res, err?.status || 500, err?.message || 'Unknown error', err?.data);
  }
};

module.exports = {
  getTiktokOrders,
  getTiktokOrderById,
  fulfillTiktokOrderWithTrackingInfo,
  toEpochSeconds,
};
