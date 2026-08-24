const debug = require('debug');
const log = debug('app:unifiedProductSync');
const { ApiError } = require('../helpers/api-error');
const finerworksService = require('../helpers/finerworks-service');

// Deliberately requires the same standalone (req, res) handlers the individual
// /square/sync-products, /wix/sync-products, /squarespace/sync-products-v2, /shopify/sync-products
// routes use — nothing in those files is modified or forked for this endpoint. Each is invoked
// below through a minimal mock req/res so this stays a pure fan-out layer on top of the existing,
// untouched APIs rather than a parallel reimplementation of their logic.
const { syncSquareProducts } = require('./square-products');
const { syncWixProducts } = require('./wix-products');
const { syncSquarespaceProductsV2 } = require('./squarespace-products');
const { syncShopifyProducts } = require('./shopify-orders');

const SUPPORTED_SOURCES = ['square', 'wix', 'squarespace', 'shopify'];

// FinerWorks `connections[].name` -> the source key used in this endpoint's payload/response,
// same mapping check-link-for-external-source.js uses.
const CONNECTION_NAME_TO_SOURCE = {
  Square: 'square',
  Squarespace: 'squarespace',
  Wix: 'wix',
  Shopify: 'shopify',
};

/** Accepts either a single value or an array, trims/lowercases/dedupes, drops empties. */
function normalizeSourceList(raw) {
  return [...new Set(
    (Array.isArray(raw) ? raw : [raw])
      .filter((v) => v != null && String(v).trim() !== '')
      .map((v) => String(v).trim().toLowerCase())
  )];
}

function parseConnectionData(conn) {
  try {
    return typeof conn?.data === 'string'
      ? JSON.parse(conn.data)
      : conn?.data && typeof conn.data === 'object'
        ? conn.data
        : {};
  } catch (_) {
    return {};
  }
}

/**
 * Squarespace and Shopify have no account_key-based auth resolver built into their sync handler
 * (unlike Square/Wix's resolveSquareAuth/resolveWixAuth, which already look up stored tokens
 * internally) — this resolves their stored access_token (+ Shopify's shop domain) from the
 * FinerWorks `connections` row for this account, the same way check-link-for-external-source.js's
 * checkShopifySku/checkAndUpdatePlatformFields already do.
 */
async function getConnectionData(account_key, source) {
  const info = await finerworksService.GET_INFO({ account_key });
  const connections = Array.isArray(info?.user_account?.connections) ? info.user_account.connections : [];
  const conn = connections.find((c) => CONNECTION_NAME_TO_SOURCE[c?.name] === source);
  return conn ? parseConnectionData(conn) : null;
}

/** Minimal Express req/res mock so the untouched standalone handlers can be called directly and
 *  their res.status().json() output captured, instead of duplicating their logic here. */
function buildMockReqRes(body) {
  let statusCode = 200;
  let body_ = null;
  const req = { method: 'POST', originalUrl: '/sync-products', body, query: {}, headers: {} };
  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(payload) {
      body_ = payload;
      return res;
    },
  };
  return { req, res, read: () => ({ statusCode, body: body_ }) };
}

/** Invokes one of the existing standalone (req,res) handlers with `body` and returns its captured
 *  { statusCode, body } — throws ApiError for statusCode >= 400 so the caller's per-platform
 *  isolation (Promise.allSettled) treats it the same as any other platform failure. */
async function invokeHandler(handler, body) {
  const { req, res, read } = buildMockReqRes(body);
  await handler(req, res);
  const { statusCode, body: responseBody } = read();
  if (statusCode >= 400) {
    throw new ApiError(statusCode, responseBody?.message || 'Sync failed', responseBody?.data || responseBody);
  }
  return responseBody;
}

/**
 * Runs one platform's sync by calling its existing standalone route handler with account_key +
 * productsList — every other input each handler itself resolves or defaults when omitted (Square
 * location_id, Wix/Square access_token via their own account_key-based auth resolvers). The one
 * exception is Squarespace's `session_id`: unlike every OAuth token used elsewhere here, it isn't
 * a FinerWorks `connections` credential and there is no login/mint API in this codebase to derive
 * it from account_key alone — so it's accepted as-is from the caller when given, same requirement
 * /squarespace/sync-products-v2 already has.
 */
async function runOnePlatform(source, { account_key, productsList, session_id }) {
  switch (source) {
    case 'square':
      return invokeHandler(syncSquareProducts, { account_key, productsList, currency: 'USD' });

    case 'wix':
      return invokeHandler(syncWixProducts, { account_key, productsList, currency: 'USD' });

    case 'squarespace': {
      const connectionData = await getConnectionData(account_key, 'squarespace');
      const access_token = connectionData?.access_token;
      if (!access_token) {
        throw new ApiError(400, 'No Squarespace connection found for this account_key. Connect Squarespace first.');
      }
      return invokeHandler(syncSquarespaceProductsV2, { access_token, account_key, productsList, currency: 'USD', session_id });
    }

    case 'shopify': {
      const connectionData = await getConnectionData(account_key, 'shopify');
      const access_token = connectionData?.access_token || connectionData?.accessToken;
      const storeName =
        connectionData?.shop ||
        connectionData?.shop_domain ||
        connectionData?.shopDomain ||
        connectionData?.storeName ||
        connectionData?.myshopify_domain;
      if (!access_token || !storeName) {
        throw new ApiError(400, 'No Shopify connection found for this account_key. Connect Shopify first.');
      }
      return invokeHandler(syncShopifyProducts, { access_token, storeName, productsList, account_key });
    }

    default:
      throw new ApiError(400, `Unsupported source: ${source}`);
  }
}

/**
 * Fan one product-sync request out to Square, Wix, Squarespace, and/or Shopify in a single call,
 * instead of the caller hitting each platform's standalone /square/sync-products,
 * /wix/sync-products, /squarespace/sync-products-v2, /shopify/sync-products endpoint separately.
 * Those four endpoints and their controllers are untouched — this only calls them.
 *
 * Payload is deliberately minimal: account_key, source, productsList — plus session_id, but only
 * required when squarespace is one of the requested sources (see runOnePlatform above for why
 * that one field can't be resolved internally the way everything else is).
 *
 * Each requested source is attempted independently and best-effort: one platform failing (bad
 * auth, no connection, upstream API error) is reported under `results.<source>` with
 * `success: false` and doesn't stop the others from running — mirrors the per-platform isolation
 * already used for the Virtual Inventory sync hooks in check-link-for-external-source.js.
 *
 * POST body: { account_key: string, source: string | string[] ('square'|'wix'|'squarespace'|'shopify'), productsList: object[], session_id?: string }
 */
exports.syncProductsAllPlatforms = async (req, res) => {
  const account_key = req.body?.account_key || req.query?.account_key;
  const productsList = Array.isArray(req.body?.productsList) ? req.body.productsList : [];
  const session_id = req.body?.session_id || req.body?.sessionId || req.query?.session_id;
  const requestedSources = normalizeSourceList(req.body?.source ?? req.query?.source);

  if (!account_key || !String(account_key).trim()) {
    return res.status(400).json({ status: false, message: 'account_key is required' });
  }
  if (!productsList.length) {
    return res.status(400).json({ status: false, message: 'productsList must be a non-empty array' });
  }
  if (!requestedSources.length) {
    return res.status(400).json({
      status: false,
      message: `Missing required parameter: source. Expected one or more of: ${SUPPORTED_SOURCES.join(', ')}`,
    });
  }
  const invalidSources = requestedSources.filter((s) => !SUPPORTED_SOURCES.includes(s));
  if (invalidSources.length) {
    return res.status(400).json({
      status: false,
      message: `Unsupported source(s): ${invalidSources.join(', ')}. Expected one or more of: ${SUPPORTED_SOURCES.join(', ')}`,
    });
  }

  const settled = await Promise.allSettled(
    requestedSources.map((source) => runOnePlatform(source, { account_key, productsList, session_id }))
  );

  const results = {};
  const errors = {};
  requestedSources.forEach((source, i) => {
    const outcome = settled[i];
    if (outcome.status === 'fulfilled') {
      results[source] = outcome.value;
    } else {
      const err = outcome.reason;
      const httpStatus = err instanceof ApiError ? err.statusCode : (err?.response?.status || null);
      const message = err?.message || 'Sync failed';
      const detail = err instanceof ApiError ? err.data : (err?.response?.data?.message || null);
      log('syncProductsAllPlatforms source=%s failed: %s', source, message);
      console.error(JSON.stringify({
        level: 'ERROR',
        platform: source,
        function: 'syncProductsAllPlatforms',
        message: `Failed to sync products to ${source}: ${message}`,
        httpStatus,
        detail,
        timestamp: new Date().toISOString(),
      }));
      errors[source] = { message, ...(httpStatus ? { httpStatus } : {}), ...(detail ? { detail } : {}) };
      results[source] = { success: false, error: message, ...(httpStatus ? { httpStatus } : {}) };
    }
  });

  const success = requestedSources.every((source) => results[source]?.success);

  const successLog = JSON.stringify({
    level: 'INFO',
    method: req.method,
    api: req.originalUrl || req.url,
    function: 'syncProductsAllPlatforms',
    operation: 'Unified product sync completed',
    account_key,
    result: { sources: requestedSources, success },
    timestamp: new Date().toISOString(),
  });
  console.log(successLog);
  log('Success in syncProductsAllPlatforms: %s', successLog);

  return res.status(200).json({
    success,
    source: requestedSources,
    results,
    ...(Object.keys(errors).length ? { errors } : {}),
  });
};
