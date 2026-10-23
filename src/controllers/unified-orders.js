const debug = require('debug');
const { sendApiError } = require('../helpers/api-error');
const { logIncomingRequest } = require('../helpers/request-log');
const { getWixOrders, getWixOrderByNumber } = require('./wix-orders');
const { getSquarespaceOrders, getSquarespaceOrderByNumber } = require('./squarespace-orders');
const { getTiktokOrders, getTiktokOrderById } = require('./tiktok-orders');

const log = debug('app:unifiedOrders');

/** Any of these present (body or query) selects single-order mode over list mode — same field
 * names each platform's own by-number/by-id endpoint already accepts, just checked up front
 * here to decide which underlying handler to delegate to. */
const ORDER_KEY_FIELDS = ['order_id', 'orderId', 'order_number', 'orderNumber', 'orderName', 'order_name'];

function hasOrderKeyParam(req) {
  return ORDER_KEY_FIELDS.some((key) => {
    const v = req.body?.[key] ?? req.query?.[key];
    return v != null && String(v).trim() !== '';
  });
}

/**
 * Platforms with a working fetch-orders implementation, wired into this endpoint.
 * Each entry has a `list` handler (POST /<platform>/orders — date range/status, etc.) and a
 * `single` handler (POST /<platform>/order-by-number — one order by order_id/order_number),
 * both the platform's own existing, unchanged handlers. `normalize` reshapes whichever one ran
 * into this endpoint's common envelope. Add a platform here once its handlers exist — see
 * RESERVED_PLATFORMS below for the ones still pending.
 */
const IMPLEMENTED_PLATFORMS = {
  wix: {
    list: {
      handler: getWixOrders,
      normalize: (body) => ({
        count: body?.count ?? (Array.isArray(body?.orders) ? body.orders.length : 0),
        orders: body?.orders || [],
      }),
    },
    single: {
      handler: getWixOrderByNumber,
      // getWixOrderByNumber returns { order } for one lookup, or { count, orders, not_found }
      // when order_number was sent as an array (batch mode) — normalize whichever came back.
      normalize: (body) =>
        Array.isArray(body?.orders)
          ? {
            count: body?.count ?? body.orders.length,
            orders: body.orders,
            extra: { not_found: body?.not_found },
          }
          : { order: body?.order || null },
    },
  },
  squarespace: {
    list: {
      handler: getSquarespaceOrders,
      normalize: (body) => ({
        count: body?.count ?? (Array.isArray(body?.orders) ? body.orders.length : 0),
        orders: body?.orders || [],
        // Squarespace-specific extras — omitted for platforms that don't have them.
        extra: {
          totalAvailableCount: body?.totalAvailableCount,
          submittedCount: body?.submittedCount,
          pendingCount: body?.pendingCount,
        },
      }),
    },
    single: {
      handler: getSquarespaceOrderByNumber,
      normalize: (body) => ({ order: body?.order || null }),
    },
  },
  tiktok: {
    list: {
      handler: getTiktokOrders,
      normalize: (body) => ({
        count: body?.count ?? (Array.isArray(body?.orders) ? body.orders.length : 0),
        orders: body?.orders || [],
        // TikTok-specific extra — which authorized shop (shop_cipher) this ran against.
        extra: { shopCipher: body?.shopCipher },
      }),
    },
    single: {
      handler: getTiktokOrderById,
      // getTiktokOrderById returns { order } for one id, or { count, orders } when order_id(s)
      // resolved to more than one order — normalize whichever came back (same shape as Wix's).
      normalize: (body) =>
        Array.isArray(body?.orders)
          ? { count: body?.count ?? body.orders.length, orders: body.orders }
          : { order: body?.order || null },
    },
  },
};

/**
 * Platforms this endpoint knows about but doesn't fetch orders for yet. `existingEndpoint`
 * (when set) is what the reserved-platform response points callers to in the meantime.
 * Add an entry to IMPLEMENTED_PLATFORMS above (and require its handler) once a
 * unified-compatible fetch exists for it:
 *   - square:      getSquareOrders in square-orders.js — POST /square/orders
 *   - shopify:     getShopifyOrders in shopify-orders.js — POST /shopify/orders
 *   - etsy:        no dedicated order-fetch endpoint exists yet — only reachable indirectly
 *                  via the Shippo integration (POST /shippo/orders) if Shippo is connected
 *   - woocommerce: no order-list endpoint exists yet — only per-order-id lookup against the
 *                  merchant's own WordPress site, and product-sync endpoints
 */
const RESERVED_PLATFORMS = {
  square: { existingEndpoint: 'POST /square/orders' },
  shopify: { existingEndpoint: 'POST /shopify/orders' },
  etsy: { existingEndpoint: null },
  woocommerce: { existingEndpoint: null },
};

/**
 * Runs an existing platform order-fetch handler (an Express (req,res) function that calls
 * res.status().json() itself) without an HTTP round trip, by handing it a minimal res stand-in
 * that captures what would have been sent. Lets this endpoint delegate to the real,
 * already-working Wix/Squarespace logic verbatim instead of reimplementing it.
 */
async function runHandlerCapturingResponse(handlerFn, req) {
  let statusCode = 200;
  let body = null;
  const capturingRes = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };
  await handlerFn(req, capturingRes);
  return { statusCode, body };
}

/**
 * Single entry point for fetching orders across e-commerce platforms — lists orders, or fetches
 * one specific order when an order key is supplied.
 *
 * Currently wired for: wix, squarespace, tiktok. square, shopify, etsy, and woocommerce are
 * recognized platform values that return a clear "not yet implemented" response rather than
 * a generic 400, so callers can distinguish "reserved for later" from "invalid platform".
 *
 * Mode is decided by whether an order key is present — no separate mode flag needed:
 *   - Any of order_id / order_number / orderNumber / orderName / order_name present
 *     (body or query) -> single-order mode: delegates to the platform's by-number/by-id
 *     handler, date range and status are not required (and ignored if sent anyway).
 *   - None present -> list mode (unchanged): delegates to the platform's list handler,
 *     same required/optional params as calling POST /<platform>/orders directly.
 *
 * Every other field (account_key, access_token, startDate/endDate, fulfillmentStatus,
 * customerId, order_id, order_number, ...) is forwarded exactly as sent to the underlying
 * platform handler, so the same field names and requirements documented for each platform's
 * own endpoints apply here — this endpoint only adds `platform` on top.
 *
 * Expects body/query: { platform: 'wix' | 'squarespace' | 'tiktok', ...platform-specific params }.
 */
exports.fetchOrdersUnified = async (req, res) => {
  try {
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'fetchOrdersUnified',
      accountKey: req.body?.account_key || req.query?.account_key,
      body: req.body,
      query: req.query,
    });

    const platformRaw = req.body?.platform || req.query?.platform;
    const platform = String(platformRaw || '').trim().toLowerCase();

    const reservedNames = Object.keys(RESERVED_PLATFORMS);
    const allKnownNames = `${Object.keys(IMPLEMENTED_PLATFORMS).join(', ')} (${reservedNames.join(', ')} reserved for a future update)`;

    if (!platform) {
      log('fetchOrdersUnified rejected: missing platform');
      return sendApiError(res, 400, `Missing required parameter: platform. Expected one of: ${allKnownNames}`);
    }

    if (Object.prototype.hasOwnProperty.call(RESERVED_PLATFORMS, platform)) {
      log('fetchOrdersUnified rejected: platform=%s not yet implemented here', platform);
      const { existingEndpoint } = RESERVED_PLATFORMS[platform];
      const message = existingEndpoint
        ? `Order fetch for '${platform}' is not implemented in this unified endpoint yet — use its existing endpoint directly (${existingEndpoint}) for now. Support here is reserved for a future update.`
        : `Order fetch for '${platform}' is not implemented in this unified endpoint yet, and there's no dedicated fetch-orders endpoint for it elsewhere in this API either. Support here is reserved for a future update.`;
      return sendApiError(res, 501, message, { platform });
    }

    const entry = IMPLEMENTED_PLATFORMS[platform];
    if (!entry) {
      log('fetchOrdersUnified rejected: unknown platform=%s', platform);
      return sendApiError(res, 400, `Invalid platform. Expected one of: ${allKnownNames}`);
    }

    const mode = hasOrderKeyParam(req) ? 'single' : 'list';
    const { handler, normalize } = entry[mode];

    log('fetchOrdersUnified: delegating to %s %s handler', platform, mode);
    const { statusCode, body } = await runHandlerCapturingResponse(handler, req);

    if (statusCode < 200 || statusCode >= 300) {
      // Pass the underlying handler's own error straight through, tagged with the platform
      // that produced it — it already went through that platform's own sendApiError sanitizing.
      log('fetchOrdersUnified: %s %s handler returned statusCode=%s', platform, mode, statusCode);
      return res.status(statusCode).json({ ...body, platform, mode });
    }

    const normalized = normalize(body);
    const extra = normalized.extra
      ? Object.fromEntries(Object.entries(normalized.extra).filter(([, v]) => v !== undefined))
      : {};

    const successLog = JSON.stringify({
      level: 'INFO',
      platform,
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'fetchOrdersUnified',
      operation: `Order(s) fetched successfully via unified endpoint (${mode} mode)`,
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      result: mode === 'single' && !normalized.orders ? { hasOrder: Boolean(normalized.order) } : { count: normalized.count },
      timestamp: new Date().toISOString(),
    });
    console.log(successLog);
    log('Success in fetchOrdersUnified: %s', successLog);

    if (mode === 'single' && !normalized.orders) {
      // One order by id/number — singular shape, no count/orders array.
      return res.status(200).json({
        success: true,
        platform,
        mode,
        order: normalized.order,
      });
    }

    // List mode, or Wix's single-mode batch (order_number sent as an array).
    return res.status(200).json({
      success: true,
      platform,
      mode,
      count: normalized.count,
      orders: normalized.orders,
      ...extra,
    });
  } catch (err) {
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: req.body?.platform || req.query?.platform || 'unknown',
      source: 'lambda',
      function: 'fetchOrdersUnified',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      message: `Failed to fetch orders via unified endpoint: ${err?.message || 'Unknown error'}`,
      timestamp: new Date().toISOString(),
    });
    console.error(errorJson);
    log('Formatted error in fetchOrdersUnified: %s', errorJson);
    return sendApiError(res, err);
  }
};
