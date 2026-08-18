const axios = require('axios');
const crypto = require('crypto');
const { sendApiError, ApiError } = require('../helpers/api-error');
const debug = require('debug');
const log = debug('app:checkLinkForExternalSource');
const finerworksService = require('../helpers/finerworks-service');

// third_party_integrations fields owned by each source, scoped so a check against one platform
// never touches another platform's link. Etsy has no variant id in the schema (see
// virtual-inventory.js's UpdateVirtualInventorySchema).
const SOURCE_ID_FIELDS = {
  squarespace: ['squarespace_product_id', 'squarespace_variant_id'],
  square: ['square_product_id', 'square_variant_id'],
  wix: ['wix_product_id', 'wix_variant_id'],
  etsy: ['etsy_product_id'],
};

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
const { normalizeShopDomain } = require('./shopify-orders');

const SUPPORTED_SOURCES = ['squarespace', 'square', 'wix', 'etsy'];

// FinerWorks `connections[].name` -> the platform key used in checkSkuExists' response. Shippo is
// deliberately omitted from this map — it's a shipping/label service, not a sales channel with
// products/SKUs, so it's excluded from the per-platform SKU check regardless of connection state.
const CONNECTION_NAME_TO_SOURCE = {
  Square: 'square',
  Squarespace: 'squarespace',
  Wix: 'wix',
  Shopify: 'shopify',
  WooCommerce: 'woocommerce',
};

/**
 * Squarespace has no dedicated SKU-search endpoint (Commerce API v2). We reuse the same
 * `GET /v2/commerce/products?query=` text search already used for product sync
 * (squarespace-products.js `findProductInSquarespaceCatalog`), then confirm an exact SKU match
 * against the returned variants — `query` is full-text, not an exact filter.
 */
async function checkSquarespaceSku({ req, sku }) {
  console.log('Checking Squarespace SKU: %s', sku);
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
  console.log('Squarespace product search response: %s', JSON.stringify({ status: r.status, data: r.data }));
  if (r.status < 200 || r.status >= 300) {
    throw new ApiError(r.status >= 400 && r.status < 600 ? r.status : 502, 'Squarespace product search failed', {
      platform: 'squarespace',
      httpStatus: r.status,
    });
  }

  const products = Array.isArray(r.data?.products) ? r.data.products : [];
  const skuNormalized = sku.toLowerCase();
  let matched = null;
  for (const p of products) {
    const variant = Array.isArray(p?.variants)
      ? p.variants.find((v) => String(v?.sku || '').trim().toLowerCase() === skuNormalized)
      : null;
    if (variant) {
      matched = { productId: p.id, variantId: variant.id };
      break;
    }
  }
  return { isExist: Boolean(matched), matched, accessToken };
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
  const matched = objects[0] || null;
  return { isExist: Boolean(matched), matched, accessToken: auth.accessToken };
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
    const match = variants.find((v) => String(v?.sku || '').trim().toLowerCase() === skuNormalized);
    if (match) {
      return {
        isExist: true,
        matched: {
          productId: match.productData?.productId || match.productId || null,
          variantId: match.variantId || match._id || match.id || null,
        },
        wixAuth,
      };
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
 * Shopify's GraphQL Admin API productVariants query filtered by `sku:` is a real exact-match lookup
 * — same query shape as fetchExistingSkusInShop/syncShopifyProducts uses. Called directly here
 * (rather than reusing that helper) because it swallows per-SKU request failures internally,
 * treating an expired/invalid access_token the same as "not found" — confirmed live during testing:
 * a genuinely revoked token returned a real 401, but the shared helper reported isExist:false with
 * no indication anything was wrong. This endpoint needs to tell those two cases apart.
 */
async function checkShopifySku({ connectionData, sku }) {
  const accessToken = connectionData?.access_token || connectionData?.accessToken;
  const shopRaw =
    connectionData?.shop ||
    connectionData?.shop_domain ||
    connectionData?.shopDomain ||
    connectionData?.storeName ||
    connectionData?.myshopify_domain;
  if (!accessToken || !shopRaw) {
    throw new ApiError(400, 'Shopify connection is missing access_token or shop domain', { platform: 'shopify' });
  }

  const shopDomain = normalizeShopDomain(String(shopRaw));
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2025-10';
  const r = await axios.post(
    `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
    {
      query: `
        query productVariantsBySku($query: String!) {
          productVariants(first: 1, query: $query) {
            edges { node { sku } }
          }
        }
      `,
      variables: { query: `sku:${sku.replace(/"/g, '\\"')}` },
    },
    {
      headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
      timeout: 30000,
      validateStatus: () => true,
    }
  );

  if (r.status < 200 || r.status >= 300 || r.data?.errors) {
    const message = typeof r.data?.errors === 'string' ? r.data.errors : 'Shopify product search failed';
    throw new ApiError(r.status >= 400 && r.status < 600 ? r.status : 502, message, {
      platform: 'shopify',
      httpStatus: r.status,
    });
  }

  const edges = r.data?.data?.productVariants?.edges;
  return { isExist: Array.isArray(edges) && edges.length > 0 };
}

/**
 * WooCommerce has no live "search by SKU" capability integrated in this codebase: the WooCommerce
 * side is a custom FinerWorks WordPress plugin (wp-json/finerworks-media/v1/*) that only exposes
 * import/order endpoints, not a product search/lookup one, and no generic WooCommerce REST API
 * (consumer key/secret) credentials are stored per account either. So instead of a live check, this
 * reports whether the SKU is *linked* to a WooCommerce product in our own virtual inventory record
 * (third_party_integrations.woocommerce_product_id / _variant_id) — the same signal
 * clearStaleVirtualInventoryLink already relies on for the other endpoint in this file. This is
 * "known to have been synced to WooCommerce", not "currently verified present on the live store".
 */
async function checkWoocommerceLinkExists({ account_key, sku }) {
  const listResult = await finerworksService.LIST_VIRTUAL_INVENTORY({ sku_filter: [sku], account_key });
  if (!listResult?.status?.success) {
    throw new ApiError(502, 'Failed to look up virtual inventory for WooCommerce link check', { platform: 'woocommerce' });
  }

  const skuNormalized = sku.trim().toLowerCase();
  const product = (Array.isArray(listResult?.products) ? listResult.products : []).find(
    (p) => String(p?.sku || '').trim().toLowerCase() === skuNormalized
  );
  const integrations = product?.third_party_integrations || {};
  const isExist = Boolean(integrations.woocommerce_product_id) || Boolean(integrations.woocommerce_variant_id);
  return { isExist };
}

/**
 * Renames an existing Squarespace product variant's sku via a partial update. Confirmed live
 * against the real API: the { present, value } wrapper some docs describe for this field does
 * NOT apply here — Squarespace rejects it ("The value at JSON path 'sku' did not match the
 * required type") and expects a plain string instead.
 * https://developers.squarespace.com/commerce-apis/update-product-variant
 */
async function renameSquarespaceSku({ accessToken, productId, variantId, newSku }) {
  const r = await axios.post(
    `https://api.squarespace.com/v2/commerce/products/${productId}/variants/${variantId}`,
    { sku: newSku },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': process.env.SQUARESPACE_USER_AGENT || 'ofa-node',
        'Content-Type': 'application/json',
      },
      timeout: 30000,
      validateStatus: () => true,
    }
  );
  if (r.status < 200 || r.status >= 300) {
    throw new ApiError(r.status >= 400 && r.status < 600 ? r.status : 502, 'Failed to rename Squarespace variant sku', {
      platform: 'squarespace',
      httpStatus: r.status,
      detail: r.data?.message || null,
    });
  }
  return { newSku };
}

/**
 * Renames an existing Square ITEM_VARIATION's sku via UpsertCatalogObject. Square uses
 * full-replacement semantics for this endpoint (any field left off the object is treated as an
 * intentional clear), so the complete object retrieved from the search in checkSquareSku —
 * including its current id/version — is resent with only item_variation_data.sku changed.
 * https://developer.squareup.com/reference/square/catalog-api/upsert-catalog-object
 */
async function renameSquareSku({ account_key, access_token, matched, newSku }) {
  const auth = await resolveSquareAuth({ account_key, access_token });
  const baseUrl = getSquareBaseUrl();
  const updatedObject = {
    ...matched,
    item_variation_data: {
      ...matched.item_variation_data,
      sku: newSku,
    },
  };

  const r = await axios.post(
    `${baseUrl}/v2/catalog/object`,
    { idempotency_key: crypto.randomUUID(), object: updatedObject },
    { headers: buildSquareHeaders(auth.accessToken), timeout: 30000, validateStatus: () => true }
  );
  if (r.status < 200 || r.status >= 300) {
    throw new ApiError(r.status >= 400 && r.status < 600 ? r.status : 502, 'Failed to rename Square variation sku', {
      platform: 'square',
      httpStatus: r.status,
    });
  }
  return { newSku };
}

/**
 * Renames one variant's sku on a Wix product. Wix's Update Product endpoint requires the full
 * variantsInfo.variants array on every call (a partial array overwrites, it doesn't merge) plus
 * the product's current `revision` for optimistic concurrency — neither is returned by
 * query-variants (checkWixSku's source), so this fetches the product fresh right before writing.
 * https://dev.wix.com/docs/api-reference/business-solutions/stores/catalog-v3/products-v3/update-product
 */
async function renameWixSku({ wixAuth, productId, variantId, newSku }) {
  const headers = buildWixAuthHeaders(wixAuth);

  const productResp = await axios.get(`https://www.wixapis.com/stores/v3/products/${productId}`, {
    headers,
    timeout: 30000,
    validateStatus: () => true,
  });
  if (productResp.status < 200 || productResp.status >= 300) {
    throw new ApiError(
      productResp.status >= 400 && productResp.status < 600 ? productResp.status : 502,
      'Failed to fetch Wix product for sku rename',
      { platform: 'wix', httpStatus: productResp.status }
    );
  }

  const product = productResp.data?.product;
  const variants = Array.isArray(product?.variantsInfo?.variants) ? product.variantsInfo.variants : [];
  const updatedVariants = variants.map((v) => (v.id === variantId ? { ...v, sku: newSku } : v));

  const r = await axios.patch(
    `https://www.wixapis.com/stores/v3/products/${productId}`,
    { product: { id: productId, revision: product?.revision, variantsInfo: { variants: updatedVariants } } },
    { headers, timeout: 30000, validateStatus: () => true }
  );
  if (r.status < 200 || r.status >= 300) {
    throw new ApiError(r.status >= 400 && r.status < 600 ? r.status : 502, 'Failed to rename Wix variant sku', {
      platform: 'wix',
      httpStatus: r.status,
    });
  }
  return { newSku };
}

/**
 * Clears the third_party_integrations fields owned by `source` (SOURCE_ID_FIELDS) on the Virtual
 * Inventory record for `sku`, when they're set. Used after a live rename on the platform side
 * (checkLinkForExternalSource) so a link tied to a sku that no longer means the same thing on that
 * platform doesn't linger. Returns { cleared: false } when there's nothing to do (SKU not found in
 * virtual inventory, or none of that source's id fields are currently set).
 */
async function clearStaleVirtualInventoryLink({ source, sku, account_key }) {
  const idFields = SOURCE_ID_FIELDS[source];
  if (!idFields) return { cleared: false };

  const listResult = await finerworksService.LIST_VIRTUAL_INVENTORY({ sku_filter: [sku], account_key });
  if (!listResult?.status?.success) {
    throw new ApiError(502, 'Failed to look up virtual inventory for stale link cleanup', { platform: 'finerworks' });
  }

  const skuNormalized = sku.trim().toLowerCase();
  const product = (Array.isArray(listResult?.products) ? listResult.products : []).find(
    (p) => String(p?.sku || '').trim().toLowerCase() === skuNormalized
  );
  if (!product) return { cleared: false };

  const integrations = product.third_party_integrations || {};
  const fieldsToClear = idFields.filter((field) => integrations[field] != null && integrations[field] !== '');
  if (!fieldsToClear.length) return { cleared: false };

  const clearedIntegrations = { ...integrations };
  for (const field of fieldsToClear) {
    clearedIntegrations[field] = null;
  }

  const updateResult = await finerworksService.UPDATE_VIRTUAL_INVENTORY({
    virtual_inventory: [
      {
        sku: product.sku,
        asking_price: product.asking_price ?? 0,
        name: product.name ?? 'Untitled',
        description: product.description ?? '',
        quantity_in_stock: product.quantity_in_stock ?? 0,
        track_inventory: product.track_inventory ?? true,
        third_party_integrations: clearedIntegrations,
      },
    ],
    account_key,
  });
  if (!updateResult?.status?.success) {
    throw new ApiError(502, 'Failed to clear stale virtual inventory link', { platform: 'finerworks' });
  }

  return { cleared: true, fields: fieldsToClear };
}

/**
 * Cross-platform SKU quarantine — no `source` param: checks `sku` against every platform
 * connected to `account_key` (squarespace/square/wix; shopify/woocommerce/shippo are skipped —
 * no live rename capability is built for those here). Wherever the sku is found live on a
 * platform, that platform's own listing is renamed to `${sku}X` so it stops being an active
 * duplicate of the original sku, then this account's corresponding third_party_integrations
 * fields for that platform are cleared in FinerWorks — Virtual Inventory's own sku is never
 * touched, only the platform-side listing and the link fields pointing at it.
 * POST body: { sku, account_key }.
 */
exports.checkLinkForExternalSource = async (req, res) => {
  const skuRaw = req.body?.sku ?? req.query?.sku;
  const sku = skuRaw != null ? String(skuRaw).trim() : '';
  const account_key = req.body?.account_key || req.query?.account_key;
  const newSku = sku ? `${sku}X` : '';

  const platforms = {};

  try {
    if (!sku) {
      return sendApiError(res, 400, 'Missing required parameter: sku');
    }
    if (!account_key) {
      return sendApiError(res, 400, 'Missing required parameter: account_key');
    }

    const info = await finerworksService.GET_INFO({ account_key });
    const connections = Array.isArray(info?.user_account?.connections) ? info.user_account.connections : [];

    for (const conn of connections) {
      const connName = conn?.name;
      const platformKey = connName ? CONNECTION_NAME_TO_SOURCE[connName] : null;
      if (!platformKey || !SUPPORTED_SOURCES.includes(platformKey)) continue; // shopify/woocommerce/shippo: no rename path here

      let connectionData = {};
      try {
        connectionData =
          typeof conn.data === 'string'
            ? JSON.parse(conn.data)
            : conn.data && typeof conn.data === 'object'
              ? conn.data
              : {};
      } catch (_) {
        connectionData = {};
      }

      try {
        let checkResult;
        if (platformKey === 'squarespace') {
          const accessToken = connectionData?.access_token;
          if (!accessToken) {
            throw new ApiError(400, 'Squarespace connection is missing access_token', { platform: 'squarespace' });
          }
          checkResult = await checkSquarespaceSku({ req: { body: { access_token: accessToken }, headers: {} }, sku });
        } else if (platformKey === 'square') {
          checkResult = await checkSquareSku({ account_key, sku });
        } else {
          checkResult = await checkWixSku({ account_key, sku });
        }

        if (!checkResult.isExist) {
          platforms[platformKey] = { isExist: false };
          continue;
        }

        let renameResult;
        if (platformKey === 'squarespace') {
          renameResult = await renameSquarespaceSku({
            accessToken: checkResult.accessToken,
            productId: checkResult.matched.productId,
            variantId: checkResult.matched.variantId,
            newSku,
          });
        } else if (platformKey === 'square') {
          renameResult = await renameSquareSku({ account_key, matched: checkResult.matched, newSku });
        } else {
          renameResult = await renameWixSku({
            wixAuth: checkResult.wixAuth,
            productId: checkResult.matched.productId,
            variantId: checkResult.matched.variantId,
            newSku,
          });
        }

        const cleanup = await clearStaleVirtualInventoryLink({ source: platformKey, sku, account_key });

        platforms[platformKey] = {
          isExist: true,
          renamedTo: renameResult.newSku,
          clearedLinkFields: cleanup.cleared ? cleanup.fields : [],
        };
      } catch (platformErr) {
        console.error(JSON.stringify({
          level: 'ERROR',
          platform: platformKey,
          function: 'checkLinkForExternalSource',
          message: `Failed to process ${platformKey} for sku ${sku}: ${platformErr?.message || 'Unknown error'}`,
          timestamp: new Date().toISOString(),
        }));
        log('checkLinkForExternalSource platform=%s failed: %s', platformKey, platformErr?.message);
        platforms[platformKey] = { error: platformErr?.message || 'Check failed' };
      }
    }

    const successLog = JSON.stringify({
      level: 'INFO',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'checkLinkForExternalSource',
      operation: 'Cross-platform sku quarantine completed',
      account_key,
      result: { sku, newSku, platforms: Object.keys(platforms) },
      timestamp: new Date().toISOString(),
    });
    console.log('Success in checkLinkForExternalSource: %s', successLog);
    log('Success in checkLinkForExternalSource: %s', successLog);

    return res.status(200).json({
      success: true,
      sku,
      newSku,
      ...platforms,
    });
  } catch (err) {
    const errorJson = JSON.stringify({
      level: 'ERROR',
      source: 'finerworks_api',
      function: 'checkLinkForExternalSource',
      account_key: account_key || 'unknown',
      httpStatus: err?.response?.status || err?.statusCode || null,
      message: `Failed to check SKU across connected platforms: ${err?.message || 'Unknown error'}`,
      timestamp: new Date().toISOString(),
    });
    console.error(errorJson);
    log('Formatted error in checkLinkForExternalSource: %s', errorJson);
    return sendApiError(res, err);
  }
};
/**
 * Runs the SKU-existence check for one already-known-connected platform. Returns isExist:false
 * (with an `error` note) rather than throwing on a per-platform failure — one platform's connection
 * problem (e.g. an expired Squarespace site billing) shouldn't block results for the others.
 */
async function checkSkuForConnection({ platformKey, connectionData, account_key, sku }) {
  try {
    let result;
    if (platformKey === 'squarespace') {
      const accessToken = connectionData?.access_token;
      if (!accessToken) {
        throw new ApiError(400, 'Squarespace connection is missing access_token', { platform: 'squarespace' });
      }
      result = await checkSquarespaceSku({ req: { body: { access_token: accessToken }, headers: {} }, sku });
    } else if (platformKey === 'square') {
      result = await checkSquareSku({ account_key, sku });
    } else if (platformKey === 'wix') {
      result = await checkWixSku({ account_key, sku });
    } else if (platformKey === 'shopify') {
      result = await checkShopifySku({ connectionData, sku });
    } else {
      result = await checkWoocommerceLinkExists({ account_key, sku });
    }
    return { isExist: result.isExist };
  } catch (platformErr) {
    log('SKU existence check failed for %s (account_key %s): %s', platformKey, account_key, platformErr?.message);
    return { isExist: false, error: platformErr?.message || 'Check failed' };
  }
}

/**
 * Checks a SKU against every platform connected to this account_key (per the `connections` array
 * on get-info), skipping Shippo (not a sales channel) and any connection type this endpoint doesn't
 * recognize. Response shape: { <platform>: { isConected: "true", isExist: boolean }, ... } — only
 * platforms actually present in `connections` appear (so isConected is always "true" today; the
 * field is kept, matching the requested response shape, for when disconnected entries are added).
 */
exports.checkSkuExists = async (req, res) => {
  const skuRaw = req.body?.sku ?? req.query?.sku;
  const sku = skuRaw != null ? String(skuRaw).trim() : '';
  const account_key = req.body?.account_key || req.query?.account_key;

  try {
    if (!sku) {
      return sendApiError(res, 400, 'Missing required parameter: sku');
    }
    if (!account_key) {
      return sendApiError(res, 400, 'Missing required parameter: account_key');
    }

    const info = await finerworksService.GET_INFO({ account_key });
    const connections = Array.isArray(info?.user_account?.connections) ? info.user_account.connections : [];

    const platforms = {};
    for (const conn of connections) {
      const connName = conn?.name;
      const platformKey = connName ? CONNECTION_NAME_TO_SOURCE[connName] : null;
      if (!platformKey) continue; // Shippo, or a connection type this endpoint doesn't check

      let connectionData = {};
      try {
        connectionData =
          typeof conn.data === 'string'
            ? JSON.parse(conn.data)
            : conn.data && typeof conn.data === 'object'
              ? conn.data
              : {};
      } catch (_) {
        connectionData = {};
      }

      const { isExist, error } = await checkSkuForConnection({ platformKey, connectionData, account_key, sku });
      platforms[platformKey] = {
        isConected: 'true',
        isExist,
        ...(error ? { error } : {}),
      };
    }

    const successLog = JSON.stringify({
      level: 'INFO',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'checkSkuExists',
      operation: 'SKU existence checked across connected platforms',
      account_key,
      result: { sku, platforms: Object.keys(platforms) },
      timestamp: new Date().toISOString(),
    });
    console.log('Success in checkSkuExists: %s', successLog);
    log('Success in checkSkuExists: %s', successLog);

    return res.status(200).json({
      success: true,
      sku,
      ...platforms,
    });
  } catch (err) {
    const errorJson = JSON.stringify({
      level: 'ERROR',
      source: 'finerworks_api',
      function: 'checkSkuExists',
      account_key: account_key || 'unknown',
      httpStatus: err?.response?.status || err?.statusCode || null,
      message: `Failed to check SKU across connected platforms: ${err?.message || 'Unknown error'}`,
      timestamp: new Date().toISOString(),
    });
    console.error(errorJson);
    log('Formatted error in checkSkuExists: %s', errorJson);
    return sendApiError(res, err);
  }
};
