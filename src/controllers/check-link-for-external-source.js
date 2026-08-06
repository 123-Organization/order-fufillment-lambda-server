const axios = require('axios');
const { sendApiError, ApiError } = require('../helpers/api-error');
const debug = require('debug');
const log = debug('app:checkLinkForExternalSource');

const {
  resolveSquareAuth,
  buildSquareHeaders,
} = require('./square-products');
const { getSquareBaseUrl } = require('./square-auth');
const {
  resolveWixAuth,
  buildAuthHeaders: buildWixAuthHeaders,
  summarizeWixHttpError,
} = require('./wix-products');

const SUPPORTED_SOURCES = ['squarespace', 'square', 'wix', 'etsy'];

/**
 * Squarespace has no dedicated SKU-search endpoint (Commerce API v2). We reuse the same
 * `GET /v2/commerce/products?query=` text search already used for product sync
 * (squarespace-products.js `findProductInSquarespaceCatalog`), then confirm an exact SKU match
 * against the returned variants — `query` is full-text, not an exact filter.
 */
async function checkSquarespaceSku({ req, sku }) {
  let accessToken = req.body?.access_token || req.headers['x-squarespace-access-token'];
  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  if (!accessToken && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    accessToken = authHeader.slice(7).trim();
  }
  if (!accessToken) {
    throw new ApiError(400, 'Missing required parameter: access_token', { platform: 'squarespace' });
  }

  const params = new URLSearchParams({ query: sku });
  const r = await axios.get(`https://api.squarespace.com/v2/commerce/products?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': process.env.SQUARESPACE_USER_AGENT || 'ofa-node',
    },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (r.status < 200 || r.status >= 300) {
    throw new ApiError(r.status >= 400 && r.status < 600 ? r.status : 502, 'Squarespace product search failed', {
      platform: 'squarespace',
      httpStatus: r.status,
    });
  }

  const products = Array.isArray(r.data?.products) ? r.data.products : [];
  const skuNormalized = sku.toLowerCase();
  const isExist = products.some(
    (p) =>
      Array.isArray(p?.variants) &&
      p.variants.some((v) => String(v?.sku || '').trim().toLowerCase() === skuNormalized)
  );
  return { isExist };
}

/**
 * Square Catalog API's SearchCatalogObjects supports an exact_query filter on the `sku`
 * attribute of ITEM_VARIATION objects — this is a real exact-match lookup, unlike Squarespace/Wix.
 * https://developer.squareup.com/reference/square/catalog-api/search-catalog-objects
 */
async function checkSquareSku({ account_key, access_token, sku }) {
  const auth = await resolveSquareAuth({ account_key, access_token });
  if (!auth?.accessToken) {
    throw new ApiError(
      400,
      'Unable to resolve Square access token (provide access_token, or account_key for a connected store)',
      { platform: 'square' }
    );
  }

  const baseUrl = getSquareBaseUrl();
  const r = await axios.post(
    `${baseUrl}/v2/catalog/search`,
    {
      object_types: ['ITEM_VARIATION'],
      query: { exact_query: { attribute_name: 'sku', attribute_value: sku } },
      limit: 1,
    },
    {
      headers: buildSquareHeaders(auth.accessToken),
      timeout: 30000,
      validateStatus: () => true,
    }
  );

  if (r.status < 200 || r.status >= 300) {
    throw new ApiError(r.status >= 400 && r.status < 600 ? r.status : 502, 'Square catalog search failed', {
      platform: 'square',
      httpStatus: r.status,
    });
  }

  const objects = Array.isArray(r.data?.objects) ? r.data.objects : [];
  return { isExist: objects.length > 0 };
}

const WIX_VARIANTS_PAGE_LIMIT = 1000; // max allowed per Query Variants call
// Bounds worst-case scan to 20,000 variants; Wix has no exact-match SKU filter/search (see below).
const WIX_MAX_VARIANT_PAGES_TO_SCAN = 20;

/**
 * Wix Stores Catalog V3 has no reliable way to search variants by SKU, confirmed live against the
 * actual API through three dead ends:
 *  1. Search/Query Products' `filter` rejects `$eq` on `variantsInfo.variants.sku` outright
 *     ("non allowed operator").
 *  2. Search Products' full-text `search.expression` scoped to that field looked promising, but is
 *     fuzzy, not exact — it returned a "hit" for a made-up, guaranteed-nonexistent SKU in testing,
 *     so a non-empty result cannot be trusted as a real match.
 *  3. Even if it could be trusted, Search Products never includes variant data in its response
 *     under any `fields` option ("This method does not return variant data" — Wix's own docs), so
 *     there's nothing to verify an exact match against anyway.
 *  4. Read-Only Variants' Query Variants only allows filtering on `_id`/`variantId`/
 *     `productData.productId` — sku is returned but not filterable there either.
 * So: page through every variant via Query Variants (which does return real `sku` values, up to
 * 1,000 per call) and check for an exact match client-side. Bounded since there's no way to narrow
 * the scan server-side.
 * https://dev.wix.com/docs/api-reference/business-solutions/stores/catalog-v3/read-only-variants-v3/query-variants
 */
async function checkWixSku({ account_key, access_token, sku }) {
  const wixAuth = await resolveWixAuth({ account_key, access_token });
  if (!wixAuth?.accessToken) {
    throw new ApiError(
      400,
      'Unable to resolve Wix access token (provide access_token, or account_key for a connected site)',
      { platform: 'wix' }
    );
  }

  const headers = buildWixAuthHeaders(wixAuth);
  const skuNormalized = sku.toLowerCase();
  let cursor;

  for (let page = 0; page < WIX_MAX_VARIANT_PAGES_TO_SCAN; page++) {
    const r = await axios.post(
      'https://www.wixapis.com/stores/v3/products/query-variants',
      {
        fields: [],
        query: { cursorPaging: { limit: WIX_VARIANTS_PAGE_LIMIT, cursor } },
      },
      { headers, timeout: 30000, validateStatus: () => true }
    );

    if (r.status < 200 || r.status >= 300) {
      const summary = summarizeWixHttpError(r);
      throw new ApiError(r.status >= 400 && r.status < 600 ? r.status : 502, summary.message || 'Wix variant lookup failed', {
        platform: 'wix',
        httpStatus: r.status,
      });
    }

    const variants = Array.isArray(r.data?.variants) ? r.data.variants : [];
    if (variants.some((v) => String(v?.sku || '').trim().toLowerCase() === skuNormalized)) {
      return { isExist: true };
    }

    cursor = r.data?.pagingMetadata?.cursors?.next;
    if (!r.data?.pagingMetadata?.hasNext || !cursor) break;
  }

  return { isExist: false };
}

const ETSY_API_BASE = 'https://openapi.etsy.com/v3/application';
const ETSY_LISTINGS_PAGE_LIMIT = 100;
// Etsy's API has no direct "find listing by SKU" endpoint — SKUs live on each listing's
// inventory record, not on the listing search/list response. We page through active listings
// (with `includes=Inventory` to get SKUs in the same call, avoiding an N+1 per-listing fetch)
// and stop at the first match. Bounded to avoid scanning a very large shop's entire catalog on
// every call; a real SKU in a shop's active listings is expected to be found well within this.
const ETSY_MAX_PAGES_TO_SCAN = 20; // 20 * 100 = up to 2000 listings scanned

/**
 * No Etsy OAuth/account storage exists in this codebase yet (no etsy-auth.js, no accounts table),
 * unlike Square/Wix/Squarespace. Caller must supply a valid Etsy OAuth access_token and shop_id
 * directly, same convention already used for Squarespace. ETSY_API_KEY (the app's keystring) is
 * required on every Etsy Open API v3 request in addition to the OAuth bearer token.
 */
async function checkEtsySku({ access_token, shop_id, sku }) {
  if (!access_token) {
    throw new ApiError(400, 'Missing required parameter: access_token', { platform: 'etsy' });
  }
  if (!shop_id) {
    throw new ApiError(400, 'Missing required parameter: shop_id', { platform: 'etsy' });
  }
  const apiKey = process.env.ETSY_API_KEY;
  if (!apiKey) {
    throw new ApiError(500, 'ETSY_API_KEY is not configured', { platform: 'etsy' });
  }

  const headers = {
    Authorization: `Bearer ${String(access_token).trim()}`,
    'x-api-key': apiKey,
  };
  const skuNormalized = sku.toLowerCase();

  let offset = 0;
  for (let page = 0; page < ETSY_MAX_PAGES_TO_SCAN; page++) {
    const r = await axios.get(`${ETSY_API_BASE}/shops/${encodeURIComponent(shop_id)}/listings/active`, {
      headers,
      params: { limit: ETSY_LISTINGS_PAGE_LIMIT, offset, includes: 'Inventory' },
      timeout: 30000,
      validateStatus: () => true,
    });

    if (r.status < 200 || r.status >= 300) {
      throw new ApiError(r.status >= 400 && r.status < 600 ? r.status : 502, 'Etsy listings lookup failed', {
        platform: 'etsy',
        httpStatus: r.status,
      });
    }

    const results = Array.isArray(r.data?.results) ? r.data.results : [];
    for (const listing of results) {
      const inventory = listing?.inventory || listing?.Inventory;
      const products = Array.isArray(inventory?.products) ? inventory.products : [];
      if (products.some((p) => String(p?.sku || '').trim().toLowerCase() === skuNormalized)) {
        return { isExist: true };
      }
    }

    offset += results.length;
    const total = Number(r.data?.count) || 0;
    if (results.length === 0 || offset >= total) break;
  }

  return { isExist: false };
}

/**
 * Common cross-platform "does this SKU exist on the connected store" check.
 * POST body: { source: 'squarespace'|'square'|'wix'|'etsy', sku, account_key?, access_token?,
 * shop_id? (etsy only) }.
 */
exports.checkLinkForExternalSource = async (req, res) => {
  const source = String(req.body?.source || req.query?.source || '').trim().toLowerCase();
  const skuRaw = req.body?.sku ?? req.query?.sku;
  const sku = skuRaw != null ? String(skuRaw).trim() : '';
  const account_key = req.body?.account_key || req.query?.account_key;
  const access_token = req.body?.access_token || req.query?.access_token;
  const shop_id = req.body?.shop_id || req.query?.shop_id;

  try {
    if (!source) {
      return sendApiError(res, 400, 'Missing required parameter: source');
    }
    if (!SUPPORTED_SOURCES.includes(source)) {
      return sendApiError(res, 400, `Unsupported source: ${source}. Expected one of: ${SUPPORTED_SOURCES.join(', ')}`);
    }
    if (!sku) {
      return sendApiError(res, 400, 'Missing required parameter: sku');
    }

    let result;
    if (source === 'squarespace') {
      result = await checkSquarespaceSku({ req, sku });
    } else if (source === 'square') {
      result = await checkSquareSku({ account_key, access_token, sku });
    } else if (source === 'wix') {
      result = await checkWixSku({ account_key, access_token, sku });
    } else {
      result = await checkEtsySku({ access_token, shop_id, sku });
    }

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: source,
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'checkLinkForExternalSource',
      operation: 'External source SKU check completed',
      result: { sku, isExist: result.isExist },
      timestamp: new Date().toISOString(),
    });
    console.log('Success in checkLinkForExternalSource: %s', successLog);
    log('Success in checkLinkForExternalSource: %s', successLog);

    return res.status(200).json({
      success: true,
      source,
      sku,
      isExist: result.isExist,
    });
  } catch (err) {
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: source || 'unknown',
      source: 'external_platform_api',
      function: 'checkLinkForExternalSource',
      httpStatus: err?.response?.status || err?.statusCode || null,
      message: `Failed to check SKU for external source: ${err?.message || 'Unknown error'}`,
      timestamp: new Date().toISOString(),
    });
    console.error(errorJson);
    log('Formatted error in checkLinkForExternalSource: %s', errorJson);
    return sendApiError(res, err);
  }
};
