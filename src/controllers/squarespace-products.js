const axios = require('axios');
const FormData = require('form-data');
const finerworksService = require('../helpers/finerworks-service');
const { sendApiError } = require('../helpers/api-error');
const debug = require('debug');
const log = debug('app:squarespaceProducts');

const STORE_PAGES_URL = 'https://api.squarespace.com/1.0/commerce/store_pages';
const API_BASE = 'https://api.squarespace.com/v2/commerce';

function extractImages(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.images)) return data.images;
  if (Array.isArray(data.list)) return data.list;
  if (Array.isArray(data.data)) return data.data;
  if (data.data && Array.isArray(data.data.images)) return data.data.images;
  if (data.result && Array.isArray(data.result.images)) return data.result.images;
  return [];
}

function imageGuidFromImage(image) {
  const guid = image?.guid ?? image?.image_guid ?? image?.imageGuid ?? image?.product_guid ?? null;
  return guid != null ? String(guid).trim() : '';
}

function previewUrlFromMatchedImage(image) {
  const u =
    image?.public_preview_uri ??
    image?.public_preview_url ??
    image?.preview_url ??
    image?.previewUrl ??
    image?.image_url ??
    image?.url ??
    null;
  if (typeof u !== 'string') return null;
  const t = u.trim();
  return /^https?:\/\//i.test(t) ? t : null;
}

function normalizeSku(sku) {
  if (sku == null) return null;
  const s = String(sku).trim();
  return s || null;
}

function buildVariantLabel(product) {
  const d =
    product?.price_details?.debug?.Description ||
    product?.price_details?.debug?.description ||
    null;
  if (d && typeof d === 'object') {
    const parts = [d.Media || d.media, d.Style || d.style, d.Size || d.size]
      .map((x) => String(x || '').trim())
      .filter(Boolean);
    if (parts.length) return parts.join(' : ');
  }
  return normalizeSku(product?.sku) || 'Variant';
}

/** Squarespace catalog price: only price_details.product_price (SS-SYNC-E02). */
function getSquarespaceSyncPrice(product) {
  const raw = product?.price_details?.product_price;
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function getQuantity(product) {
  if (typeof product?.quantity_in_stock === 'number') return product.quantity_in_stock;
  if (typeof product?.quantity === 'number') return product.quantity;
  return 10;
}

function buildBasePrice(currency, raw) {
  const n = Number(raw);
  const val = Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  return {
    currency: String(currency || 'USD')
      .trim()
      .toUpperCase(),
    value: val.toFixed(2),
  };
}

function slugify(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 96);
}

function firstHttpUrlFromPayload(item) {
  for (let i = 1; i <= 5; i++) {
    const u = item?.[`image_url_${i}`];
    if (typeof u === 'string' && /^https?:\/\//i.test(u.trim())) return u.trim();
  }
  return null;
}

function parseGroupByImageGuidFlag(value) {
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  return true;
}

function squarespaceErrorMessage(data, fallback = 'Squarespace API request failed') {
  if (!data || typeof data !== 'object') return fallback;
  if (typeof data.message === 'string' && data.message.trim()) return data.message.trim();
  if (typeof data.error === 'string' && data.error.trim()) return data.error.trim();
  return fallback;
}

function authorizationHint(data) {
  if (data?.type !== 'AUTHORIZATION_ERROR') return null;
  return (
    'Squarespace token lacks write permission or is invalid. Reconnect the store via OAuth with ' +
    'website.products and website.inventory scopes, or use a token with Products Read and Write access.'
  );
}

function buildVariantRow(src, currency, { includeAttributes = false } = {}) {
  const sku = normalizeSku(src?.sku);
  if (!sku) return null;

  const row = {
    sku,
    pricing: { basePrice: buildBasePrice(currency, getSquarespaceSyncPrice(src)) },
    stock: {
      quantity: Math.max(0, Math.round(Number(getQuantity(src) || 0))),
      unlimited: false,
    },
  };

  if (includeAttributes) {
    row.attributes = { Configuration: buildVariantLabel(src) };
  }

  return row;
}

/** Each group becomes one Squarespace product. simpleProduct => single variant, no Configuration attribute. */
function buildSyncGroups(rawProducts, groupByImageGuid) {
  if (!groupByImageGuid) {
    return rawProducts
      .map((p) => {
        const image_guid = String(p?.image_guid || '').trim();
        const sku = normalizeSku(p?.sku);
        if (!image_guid || !sku) return null;
        return {
          key: `${image_guid}:${sku}`,
          image_guid,
          items: [p],
          simpleProduct: true,
        };
      })
      .filter(Boolean);
  }

  const byGuid = new Map();
  for (const p of rawProducts) {
    const image_guid = String(p?.image_guid || '').trim();
    if (!image_guid) continue;
    if (!byGuid.has(image_guid)) byGuid.set(image_guid, []);
    byGuid.get(image_guid).push(p);
  }

  return Array.from(byGuid.entries()).map(([image_guid, items]) => ({
    key: image_guid,
    image_guid,
    items,
    simpleProduct: items.length === 1,
  }));
}

async function fetchStorePageId(headers, explicitStorePageId) {
  let cursor = null;
  const pages = [];
  for (let i = 0; i < 25; i++) {
    const url = cursor
      ? `${STORE_PAGES_URL}?cursor=${encodeURIComponent(cursor)}`
      : STORE_PAGES_URL;
    const r = await axios.get(url, { headers, validateStatus: () => true });
    if (r.status < 200 || r.status >= 300) {
      const err = new Error(
        squarespaceErrorMessage(r.data, 'Failed to list Squarespace store pages')
      );
      err.status = r.status || 502;
      err.response = { data: r.data, status: r.status };
      err.step = 'fetch_store_pages';
      throw err;
    }
    const data = r?.data || {};
    pages.push(...(Array.isArray(data.storePages) ? data.storePages : []));
    const p = data.pagination || {};
    if (!p.hasNextPage || !p.nextPageCursor) break;
    cursor = p.nextPageCursor;
  }

  if (explicitStorePageId) {
    const found = pages.find(
      (p) => String(p?.id || '').trim() === String(explicitStorePageId).trim()
    );
    return found?.id ? String(found.id).trim() : null;
  }

  const preferred = pages.find((p) => p?.isEnabled) || pages[0] || null;
  return preferred?.id ? String(preferred.id).trim() : null;
}

async function resolveStorePage(headers, explicitStorePageId) {
  let cursor = null;
  const pages = [];
  for (let i = 0; i < 25; i++) {
    const url = cursor
      ? `${STORE_PAGES_URL}?cursor=${encodeURIComponent(cursor)}`
      : STORE_PAGES_URL;
    const r = await axios.get(url, { headers, validateStatus: () => true });
    if (r.status < 200 || r.status >= 300) {
      const err = new Error(
        squarespaceErrorMessage(r.data, 'Failed to list Squarespace store pages')
      );
      err.status = r.status || 502;
      err.response = { data: r.data, status: r.status };
      err.step = 'fetch_store_pages';
      throw err;
    }
    const data = r?.data || {};
    pages.push(...(Array.isArray(data.storePages) ? data.storePages : []));
    const p = data.pagination || {};
    if (!p.hasNextPage || !p.nextPageCursor) break;
    cursor = p.nextPageCursor;
  }

  let selected = null;
  if (explicitStorePageId) {
    selected =
      pages.find((p) => String(p?.id || '').trim() === String(explicitStorePageId).trim()) || null;
    if (selected && selected.isEnabled === false) {
      log(
        'resolveStorePage: explicit storePageId %s is disabled on Squarespace',
        explicitStorePageId
      );
    }
  } else {
    selected =
      pages.find(
        (p) =>
          p?.isEnabled === true &&
          /shop|store|products/i.test(String(p?.urlSlug || p?.title || ''))
      ) ||
      pages.find((p) => p?.isEnabled === true) ||
      null;
  }

  return {
    storePageId: selected?.id && selected?.isEnabled !== false ? String(selected.id).trim() : null,
    storePageTitle: selected?.title || selected?.name || null,
    storePageUrlSlug: selected?.urlSlug || null,
    storePageEnabled: selected?.isEnabled ?? null,
    storePageSelectionWarning:
      selected && selected.isEnabled === false
        ? 'The selected store page is disabled. Products will not appear on your live store.'
        : !selected
          ? 'No enabled Squarespace store page was found. Pass storePageId in the request body.'
          : null,
    storePages: pages.map((p) => ({
      id: p?.id || null,
      title: p?.title || p?.name || null,
      urlSlug: p?.urlSlug || null,
      isEnabled: p?.isEnabled ?? null,
    })),
  };
}

async function fetchSquarespaceWebsiteInfo(headers) {
  const r = await axios.get('https://api.squarespace.com/1.0/authorization/website', {
    headers: {
      Authorization: headers.Authorization,
      'User-Agent': headers['User-Agent'],
    },
    timeout: 60000,
    validateStatus: () => true,
  });
  if (r.status < 200 || r.status >= 300) return null;
  return {
    id: r.data?.id || null,
    siteId: r.data?.siteId || null,
    title: r.data?.title || null,
    url: r.data?.url || null,
    currency: r.data?.currency || null,
  };
}

async function ensureSquarespaceProductVisible(productId, headers) {
  const id = String(productId || '').trim();
  if (!id) return { updated: false };
  const r = await axios.post(
    `${API_BASE}/products/${encodeURIComponent(id)}`,
    { isVisible: { present: true, value: true } },
    {
      headers: {
        Authorization: headers.Authorization,
        'User-Agent': headers['User-Agent'],
        'Content-Type': 'application/json',
      },
      timeout: 60000,
      validateStatus: () => true,
    }
  );
  return { updated: r.status >= 200 && r.status < 300, status: r.status };
}

async function findProductInSquarespaceCatalog(productId, headers, { query } = {}) {
  const params = new URLSearchParams();
  if (query) params.set('query', String(query));
  const r = await axios.get(
    `${API_BASE}/products${params.toString() ? `?${params.toString()}` : ''}`,
    {
      headers: {
        Authorization: headers.Authorization,
        'User-Agent': headers['User-Agent'],
      },
      timeout: 60000,
      validateStatus: () => true,
    }
  );
  if (r.status < 200 || r.status >= 300) {
    return { found: false, listStatus: r.status, products: [] };
  }
  const products = Array.isArray(r.data?.products) ? r.data.products : [];
  const product =
    products.find((p) => String(p?.id || '') === String(productId)) ||
    null;
  return {
    found: Boolean(product),
    product,
    listStatus: r.status,
    productsOnPage: products.length,
  };
}

async function finalizeSquarespaceProductForStore({
  productId,
  headers,
  expectedStorePageId,
  searchQuery,
  productHint = null,
}) {
  const [, product, catalogMatch] = await Promise.all([
    ensureSquarespaceProductVisible(productId, headers),
    productHint?.id ? Promise.resolve(productHint) : fetchSquarespaceProduct(productId, headers),
    findProductInSquarespaceCatalog(productId, headers, { query: searchQuery }),
  ]);

  if (!product?.id) {
    return {
      verified: false,
      product: null,
      catalogMatch,
      visibilityUpdate: null,
      warning:
        'Product id was returned by Squarespace but the product could not be loaded afterward.',
    };
  }

  const storePageMismatch =
    expectedStorePageId &&
    product.storePageId &&
    String(product.storePageId) !== String(expectedStorePageId);

  let warning = null;
  if (product.isVisible === false) {
    warning = 'Squarespace product exists but isVisible is false.';
  } else if (storePageMismatch) {
    warning = `Product storePageId (${product.storePageId}) does not match requested store page (${expectedStorePageId}).`;
  } else if (!catalogMatch.found) {
    warning =
      'Product was created and retrieved by id, but was not found in the Squarespace product list. Confirm you are viewing the same Squarespace site as the OAuth token and check Commerce > Inventory.';
  }

  return {
    verified: true,
    product,
    catalogMatch,
    warning,
    storePageMismatch,
  };
}

function buildSquarespaceProductSummary(product) {
  if (!product?.id) return null;
  return {
    id: product.id,
    name: product.name || null,
    url: product.url || null,
    urlSlug: product.urlSlug || null,
    isVisible: product.isVisible ?? null,
    storePageId: product.storePageId || null,
    variantCount: Array.isArray(product.variants) ? product.variants.length : 0,
    variants: Array.isArray(product.variants)
      ? product.variants.map((v) => ({
          id: v?.id || null,
          sku: normalizeSku(v?.sku),
        }))
      : [],
  };
}

async function uploadImageToProduct(productId, imageUrl, headers) {
  const dl = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 120000,
    validateStatus: (s) => s >= 200 && s < 300,
  });
  const form = new FormData();
  form.append('file', Buffer.from(dl.data), { filename: 'image.jpg', contentType: 'image/jpeg' });
  const up = await axios.post(
    `${API_BASE}/products/${encodeURIComponent(productId)}/images`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization: headers.Authorization,
        'User-Agent': headers['User-Agent'],
      },
      timeout: 120000,
      validateStatus: (s) => s === 200 || s === 201 || s === 202,
    }
  );
  return up?.data?.imageId || null;
}

async function waitImageReady(productId, imageId, headers, { maxAttempts = 45, delayMs = 800 } = {}) {
  if (!imageId) return;
  const statusUrl = `${API_BASE}/products/${encodeURIComponent(productId)}/images/${encodeURIComponent(imageId)}/status`;
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      const r = await axios.get(statusUrl, { headers, timeout: 30000, validateStatus: () => true });
      const st = r?.data?.status;
      if (st === 'READY' || st === 'ERROR') return;
    } catch (_) {
      // retry
    }
    if (i < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function associateVariantImage(productId, variantId, imageId, headers) {
  if (!productId || !variantId || !imageId) return false;
  const url = `${API_BASE}/products/${encodeURIComponent(productId)}/variants/${encodeURIComponent(variantId)}/image`;
  const tryBodies = [{ imageId: { present: true, value: imageId } }, { imageId }];
  for (const body of tryBodies) {
    const r = await axios.post(url, body, {
      headers: {
        Authorization: headers.Authorization,
        'User-Agent': headers['User-Agent'],
        'Content-Type': 'application/json',
      },
      timeout: 60000,
      validateStatus: () => true,
    });
    if (r.status === 200 || r.status === 201 || r.status === 204) return true;
  }
  return false;
}

function getSquarespaceLinkFromItem(src) {
  const tpi = src?.third_party_integrations || {};
  const productId =
    tpi.squarespace_product_id != null ? String(tpi.squarespace_product_id).trim() : '';
  const variantId =
    tpi.squarespace_variant_id != null ? String(tpi.squarespace_variant_id).trim() : '';
  return {
    squarespace_product_id: productId || null,
    squarespace_variant_id: variantId || null,
  };
}

function resolveGroupProductId(items) {
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    const { squarespace_product_id } = getSquarespaceLinkFromItem(item);
    if (squarespace_product_id) return squarespace_product_id;
  }
  return null;
}

/**
 * @returns {'fully_linked'|'needs_vi_only'|'needs_squarespace_and_vi'}
 */
function classifySkuSyncState(item, groupProductId, simpleProduct) {
  const link = getSquarespaceLinkFromItem(item);
  const productId = link.squarespace_product_id || groupProductId || null;

  if (simpleProduct) {
    return productId ? 'needs_vi_only' : 'needs_squarespace_and_vi';
  }

  if (link.squarespace_variant_id) return 'needs_vi_only';
  if (productId && !link.squarespace_variant_id) return 'needs_squarespace_and_vi';
  return 'needs_squarespace_and_vi';
}

function shouldVerifySquarespaceProduct() {
  const v = process.env.SQUARESPACE_SYNC_VERIFY_PRODUCT;
  return v === 'true' || v === '1';
}

function shouldCompensateOnViFailure() {
  const v = process.env.SQUARESPACE_SYNC_COMPENSATE_ON_VI_FAILURE;
  return v === 'true' || v === '1';
}

function parseSquarespaceProductRecord(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.id && (Array.isArray(data.variants) || data.name != null || data.type != null)) {
    return data;
  }
  const products = Array.isArray(data.products) ? data.products : [];
  return products.find((p) => p?.id) || products[0] || null;
}

function mergeVariantIdsFromProductData(variantIdBySku, productData) {
  const map = variantIdBySku instanceof Map ? variantIdBySku : new Map();
  const product = parseSquarespaceProductRecord(productData) || productData;
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  for (const v of variants) {
    const sku = normalizeSku(v?.sku);
    if (sku && v?.id) map.set(sku, v.id);
  }
  return map;
}

async function fetchSquarespaceProduct(productId, headers) {
  const id = String(productId || '').trim();
  if (!id) return null;
  const pr = await axios.get(`${API_BASE}/products/${encodeURIComponent(id)}`, {
    headers,
    timeout: 60000,
    validateStatus: () => true,
  });
  if (pr.status < 200 || pr.status >= 300) return null;
  return parseSquarespaceProductRecord(pr.data);
}

async function verifySquarespaceProductExists(productId, headers) {
  const product = await fetchSquarespaceProduct(productId, headers);
  return Boolean(product?.id);
}

async function fetchVariantIdBySku(productId, headers, { retries = 3, delayMs = 600 } = {}) {
  const variantIdBySku = new Map();
  const id = String(productId || '').trim();
  if (!id) return variantIdBySku;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const product = await fetchSquarespaceProduct(id, headers);
      const sqVariants = Array.isArray(product?.variants) ? product.variants : [];
      for (const v of sqVariants) {
        const sku = normalizeSku(v?.sku);
        if (sku) variantIdBySku.set(sku, v?.id || null);
      }
      if (variantIdBySku.size > 0 || attempt === retries - 1) break;
    } catch (_) {
      if (attempt === retries - 1) break;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
  }

  return variantIdBySku;
}

async function deleteSquarespaceProduct(productId, headers) {
  const id = String(productId || '').trim();
  if (!id) return { deleted: false };
  const r = await axios.delete(`${API_BASE}/products/${encodeURIComponent(id)}`, {
    headers: {
      Authorization: headers.Authorization,
      'User-Agent': headers['User-Agent'],
    },
    timeout: 60000,
    validateStatus: (status) => status === 204 || status === 404,
  });
  return { deleted: r.status === 204 || r.status === 404, status: r.status };
}

async function createSquarespaceVariant(productId, variantRow, headers) {
  const r = await axios.post(
    `${API_BASE}/products/${encodeURIComponent(productId)}/variants`,
    variantRow,
    { headers, timeout: 120000, validateStatus: () => true }
  );
  if (r.status < 200 || r.status >= 300) {
    const err = new Error(squarespaceErrorMessage(r.data, 'Failed to create Squarespace variant'));
    err.response = { data: r.data, status: r.status };
    throw err;
  }
  const variantId = r?.data?.id ?? r?.data?.variant?.id ?? null;
  const sku = normalizeSku(variantRow?.sku);
  return { variantId, sku };
}

function applyViResultToEntry(resultEntry, viResult) {
  const { virtualInventoryUpdates = [], virtualInventoryUpdateErrors = [] } = viResult || {};
  if (virtualInventoryUpdates.length) {
    resultEntry.virtualInventoryUpdates = virtualInventoryUpdates;
  }
  if (virtualInventoryUpdateErrors.length) {
    resultEntry.virtualInventoryUpdateErrors = virtualInventoryUpdateErrors;
  }
  if (virtualInventoryUpdateErrors.length) {
    resultEntry.success = false;
    if (
      !resultEntry.action ||
      resultEntry.action === 'created' ||
      resultEntry.action === 'variants_added'
    ) {
      resultEntry.action = 'partial';
    }
  }
  return resultEntry;
}

function buildSyncSummary(results) {
  const summary = {
    total: results.length,
    uploaded: 0,
    repaired: 0,
    variantsAdded: 0,
    failed: 0,
    partial: 0,
    skipped: 0,
  };

  for (const r of results) {
    if (!r.success) {
      summary.failed += 1;
      continue;
    }
    const action = r.action || '';
    if (action === 'created') summary.uploaded += 1;
    else if (action === 'repaired_vi' || action === 'skipped_vi_only') {
      summary.repaired += 1;
      if (action === 'skipped_vi_only') summary.skipped += 1;
    } else if (action === 'variants_added') {
      summary.uploaded += 1;
      summary.variantsAdded += Number(r.variantsCreatedOnSquarespace || 0);
    } else if (action === 'partial') summary.partial += 1;
  }

  return summary;
}

async function uploadAndAssociateImages({
  productId,
  srcVariants,
  matched,
  first,
  headers,
  skusForImages = null,
  variantIdBySkuSeed = null,
  fast = false,
}) {
  const skuFilter = skusForImages ? new Set(skusForImages) : null;
  const mainImageUrl = previewUrlFromMatchedImage(matched) || firstHttpUrlFromPayload(first);
  const uploadedByUrl = new Map();
  const variantImageAssociations = [];
  const waitOpts = fast ? { maxAttempts: 10, delayMs: 250 } : undefined;
  const variantFetchOpts = fast ? { retries: 1, delayMs: 0 } : undefined;

  const urlsToUpload = [];
  if (mainImageUrl) urlsToUpload.push(mainImageUrl);

  const variantImageUrlBySku = new Map();
  for (const src of srcVariants) {
    const sku = normalizeSku(src?.sku);
    if (!sku || (skuFilter && !skuFilter.has(sku))) continue;
    const vUrl = firstHttpUrlFromPayload(src);
    if (vUrl) variantImageUrlBySku.set(sku, vUrl);
  }
  for (const vUrl of new Set(Array.from(variantImageUrlBySku.values()))) {
    if (!urlsToUpload.includes(vUrl)) urlsToUpload.push(vUrl);
  }

  await Promise.all(
    urlsToUpload.map(async (url) => {
      try {
        const imageId = await uploadImageToProduct(productId, url, headers);
        if (imageId) uploadedByUrl.set(url, imageId);
      } catch (_) {
        // non-fatal
      }
    })
  );

  let variantIdBySku =
    variantIdBySkuSeed instanceof Map && variantIdBySkuSeed.size
      ? new Map(variantIdBySkuSeed)
      : await fetchVariantIdBySku(productId, headers, variantFetchOpts);
  if (variantIdBySku.size === 0) {
    variantIdBySku = await fetchVariantIdBySku(productId, headers, variantFetchOpts);
  }

  await Promise.all(
    Array.from(variantImageUrlBySku.entries()).map(async ([sku, vUrl]) => {
      const variantId = variantIdBySku.get(sku);
      const imageId = uploadedByUrl.get(vUrl);
      if (!variantId || !imageId) return;
      await waitImageReady(productId, imageId, headers, waitOpts);
      const ok = await associateVariantImage(productId, variantId, imageId, headers);
      variantImageAssociations.push({ sku, variantId, imageId, associated: ok });
    })
  );

  return { variantIdBySku, variantImageAssociations, uploadedByUrl };
}

async function processSyncGroup({
  group,
  accountKey,
  currency,
  storePageId,
  headers,
  matchedByGuid,
  counters,
}) {
  const { key, image_guid: guid, items: srcVariants, simpleProduct } = group;
  const matched = matchedByGuid.get(guid) || null;
  const first = srcVariants[0];
  const productName =
    (matched?.title && String(matched.title).trim()) ||
    (first?.name && String(first.name).trim()) ||
    'Untitled';
  const description =
    (matched?.description && String(matched.description).trim()) ||
    first?.description_long ||
    first?.description_short ||
    '';

  const useVariantAttributes = !simpleProduct && srcVariants.length > 1;
  const variantRows = srcVariants
    .map((src) => buildVariantRow(src, currency, { includeAttributes: useVariantAttributes }))
    .filter(Boolean);

  if (!variantRows.length) {
    return {
      success: false,
      action: 'failed',
      image_guid: guid,
      groupKey: key,
      error: 'No valid variants (missing SKU)',
    };
  }

  const productMode = simpleProduct ? 'simple' : useVariantAttributes ? 'multi_variant' : 'simple';
  const groupProductId = resolveGroupProductId(srcVariants);

  // --- Simple product: VI-only when already linked on Squarespace ---
  if (simpleProduct) {
    let productId = groupProductId;
    if (productId && shouldVerifySquarespaceProduct()) {
      const exists = await verifySquarespaceProductExists(productId, headers);
      if (!exists) productId = null;
    }

    if (productId) {
      const variantIdBySku = await fetchVariantIdBySku(productId, headers);
      const resultEntry = {
        success: true,
        action: 'repaired_vi',
        image_guid: guid,
        groupKey: key,
        productMode,
        squarespaceProductId: productId,
        variantCount: variantRows.length,
        skusSynced: srcVariants.map((s) => normalizeSku(s?.sku)).filter(Boolean),
      };

      const viResult = await updateVirtualInventoryWithSquarespaceIds(
        accountKey,
        srcVariants,
        productId,
        variantIdBySku
      );
      applyViResultToEntry(resultEntry, viResult);
      if (resultEntry.success) counters.repaired += 1;
      else counters.partial += 1;
      return resultEntry;
    }
  }

  // --- Multi-variant: partial per-SKU sync on existing product ---
  if (!simpleProduct && groupProductId) {
    let productId = groupProductId;
    if (shouldVerifySquarespaceProduct()) {
      const exists = await verifySquarespaceProductExists(productId, headers);
      if (!exists) productId = null;
    }

    if (productId) {
      const variantIdBySku = await fetchVariantIdBySku(productId, headers);
      const skusNeedingSquarespace = [];
      const skusViOnly = [];

      for (const src of srcVariants) {
        const sku = normalizeSku(src?.sku);
        if (!sku) continue;
        const state = classifySkuSyncState(src, productId, false);
        const existingVariantId =
          getSquarespaceLinkFromItem(src).squarespace_variant_id || variantIdBySku.get(sku);

        if (state === 'needs_vi_only' && existingVariantId) {
          variantIdBySku.set(sku, existingVariantId);
          skusViOnly.push(src);
        } else if (variantIdBySku.has(sku) && variantIdBySku.get(sku)) {
          skusViOnly.push(src);
        } else {
          skusNeedingSquarespace.push(src);
        }
      }

      let variantsCreatedOnSquarespace = 0;
      const variantCreateErrors = [];

      for (const src of skusNeedingSquarespace) {
        const row = buildVariantRow(src, currency, { includeAttributes: true });
        if (!row) continue;
        try {
          const { variantId, sku } = await createSquarespaceVariant(productId, row, headers);
          if (sku && variantId) {
            variantIdBySku.set(sku, variantId);
            variantsCreatedOnSquarespace += 1;
            counters.variantsAdded += 1;
          }
        } catch (err) {
          variantCreateErrors.push({
            sku: normalizeSku(src?.sku),
            error: err?.message || 'Failed to create variant',
          });
        }
      }

      const skusForImages = skusNeedingSquarespace.map((s) => normalizeSku(s?.sku)).filter(Boolean);
      let variantImageAssociations = [];
      if (skusForImages.length) {
        const img = await uploadAndAssociateImages({
          productId,
          srcVariants,
          matched,
          first,
          headers,
          skusForImages,
        });
        variantImageAssociations = img.variantImageAssociations;
        for (const [sku, vid] of img.variantIdBySku.entries()) {
          if (vid) variantIdBySku.set(sku, vid);
        }
      }

      const allForVi = srcVariants;
      const resultEntry = {
        success: true,
        action: variantsCreatedOnSquarespace > 0 ? 'variants_added' : 'repaired_vi',
        image_guid: guid,
        groupKey: key,
        productMode,
        squarespaceProductId: productId,
        variantCount: variantRows.length,
        variantsCreatedOnSquarespace,
        skusViOnly: skusViOnly.map((s) => normalizeSku(s?.sku)).filter(Boolean),
        skusAddedOnSquarespace: skusNeedingSquarespace
          .map((s) => normalizeSku(s?.sku))
          .filter(Boolean),
        variantImageAssociations,
        ...(variantCreateErrors.length ? { variantCreateErrors } : {}),
      };

      const viResult = await updateVirtualInventoryWithSquarespaceIds(
        accountKey,
        allForVi,
        productId,
        variantIdBySku
      );
      applyViResultToEntry(resultEntry, viResult);

      if (variantCreateErrors.length && resultEntry.success) {
        resultEntry.action = 'partial';
        resultEntry.success = false;
      }

      if (resultEntry.success) {
        if (variantsCreatedOnSquarespace > 0) counters.uploaded += 1;
        else counters.repaired += 1;
      } else {
        counters.partial += 1;
      }
      return resultEntry;
    }
  }

  // --- Full create: new Squarespace product (simple unlinked or multi without product id) ---
  const slugSeed = simpleProduct
    ? `${productName}-${normalizeSku(first?.sku) || guid}`
    : `${productName}-${guid}`;

  const createPayload = {
    name: productName,
    description,
    type: 'PHYSICAL',
    isVisible: true,
    storePageId,
    urlSlug: slugify(slugSeed) || `product-${Date.now()}`,
    ...(useVariantAttributes ? { variantAttributes: ['Configuration'] } : {}),
    variants: variantRows,
  };

  const createResp = await axios.post(`${API_BASE}/products`, createPayload, {
    headers,
    validateStatus: () => true,
  });

  if (createResp.status < 200 || createResp.status >= 300) {
    const data = createResp.data;
    counters.failed += 1;
    return {
      success: false,
      action: 'failed',
      image_guid: guid,
      groupKey: key,
      productMode,
      error: squarespaceErrorMessage(data, 'Failed to create Squarespace product'),
      ...(authorizationHint(data) ? { hint: authorizationHint(data) } : {}),
      ...(data && typeof data === 'object' ? { squarespaceError: data } : {}),
    };
  }

  const productId = createResp?.data?.id || null;
  if (!productId) {
    counters.failed += 1;
    return {
      success: false,
      action: 'failed',
      image_guid: guid,
      error: 'Squarespace product id missing in response',
    };
  }

  const newlyCreatedThisRequest = true;
  counters.mainProductsCreated += 1;
  counters.variantsAdded += variantRows.length;

  const { variantIdBySku, variantImageAssociations } = await uploadAndAssociateImages({
    productId,
    srcVariants,
    matched,
    first,
    headers,
  });

  const resultEntry = {
    success: true,
    action: 'created',
    image_guid: guid,
    groupKey: key,
    productMode,
    squarespaceProductId: productId,
    variantCount: variantRows.length,
    variantImageAssociations,
  };

  const viResult = await updateVirtualInventoryWithSquarespaceIds(
    accountKey,
    srcVariants,
    productId,
    variantIdBySku
  );
  applyViResultToEntry(resultEntry, viResult);

  if (!resultEntry.success && newlyCreatedThisRequest && shouldCompensateOnViFailure()) {
    const allViFailed =
      viResult.virtualInventoryUpdateErrors.length > 0 &&
      viResult.virtualInventoryUpdates.length === 0;
    if (allViFailed) {
      try {
        resultEntry.compensation = await deleteSquarespaceProduct(productId, headers);
      } catch (compErr) {
        resultEntry.compensation = {
          deleted: false,
          error: compErr?.message || 'Compensation delete failed',
        };
      }
      resultEntry.action = 'failed';
    }
  }

  if (resultEntry.success) counters.uploaded += 1;
  else counters.partial += 1;

  return resultEntry;
}

function pickVirtualInventoryName(src, fallback = 'Untitled') {
  return (
    (src?.name && String(src.name).trim()) ||
    (src?.title && String(src.title).trim()) ||
    (src?.product_name && String(src.product_name).trim()) ||
    normalizeSku(src?.sku) ||
    fallback
  );
}

async function updateVirtualInventoryWithSquarespaceIds(
  accountKey,
  srcVariants,
  productId,
  variantIdBySku
) {
  const virtualInventoryUpdates = [];
  const virtualInventoryUpdateErrors = [];

  if (!productId || !accountKey || !String(accountKey).trim()) {
    return { virtualInventoryUpdates, virtualInventoryUpdateErrors };
  }

  const squarespaceProductId = String(productId);

  for (const src of srcVariants) {
    const srcSku = normalizeSku(src?.sku);
    if (!srcSku) continue;

    const squarespaceVariantId = variantIdBySku.get(srcSku) || null;
    const viItem = {
      sku: srcSku,
      asking_price:
        typeof src?.asking_price === 'number' && Number.isFinite(src.asking_price)
          ? src.asking_price
          : getSquarespaceSyncPrice(src),
      name: pickVirtualInventoryName(src),
      description: src?.description_long ?? src?.description_short ?? '',
      quantity_in_stock: Math.max(0, Math.round(Number(getQuantity(src) || 0))),
      track_inventory: true,
      third_party_integrations: {
        ...(src?.third_party_integrations || {}),
        squarespace_product_id: squarespaceProductId,
        ...(squarespaceVariantId ? { squarespace_variant_id: String(squarespaceVariantId) } : {}),
      },
    };

    try {
      const updateResult = await finerworksService.UPDATE_VIRTUAL_INVENTORY({
        virtual_inventory: [viItem],
        account_key: String(accountKey).trim(),
      });
      virtualInventoryUpdates.push({ sku: srcSku, result: updateResult });
    } catch (singleErr) {
      virtualInventoryUpdateErrors.push({
        sku: srcSku,
        error: singleErr?.message || 'Unknown virtual inventory update error',
      });
    }
  }

  return { virtualInventoryUpdates, virtualInventoryUpdateErrors };
}

const syncSquarespaceProducts = async (req, res) => {
  try {
    const accessToken = req.body?.access_token || req.headers['x-squarespace-access-token'];
    const accountKey = req.body?.account_key || req.body?.accountKey;
    const siteId = req.body?.site_id ?? req.body?.siteId ?? process.env.FINERWORKS_SITE_ID ?? 2;
    const sessionId =
      req.body?.session_id || req.body?.sessionId || process.env.FINERWORKS_SESSION_ID || null;
    const currency = req.body?.currency || 'USD';
    const rawProducts = Array.isArray(req.body?.productsList) ? req.body.productsList : [];
    const explicitStorePageId = req.body?.storePageId || req.body?.store_page_id || null;
    const groupByImageGuid = parseGroupByImageGuidFlag(
      req.body?.groupByImageGuid ?? req.body?.group_by_image_guid ?? true
    );

    if (!accessToken)
      return sendApiError(res, 400, 'access_token is required');
    if (!accountKey || !String(accountKey).trim()) {
      return sendApiError(res, 400, 'account_key is required');
    }
    if (!sessionId || !String(sessionId).trim()) {
      return sendApiError(res, 400, 'session_id is required');
    }
    if (!rawProducts.length) {
      return sendApiError(res, 400, 'productsList must be a non-empty array');
    }

    const uniqueImageGuids = [
      ...new Set(rawProducts.map((p) => String(p?.image_guid || '').trim()).filter(Boolean)),
    ];
    const syncGroups = buildSyncGroups(rawProducts, groupByImageGuid);

    if (!syncGroups.length) {
      return sendApiError(res, 400, 'No valid products to sync (each item needs image_guid and sku)');
    }

    let fwData;
    try {
      fwData = await finerworksService.LIST_IMAGES({
        library: {
          account_key: String(accountKey).trim(),
          site_id: Number(siteId),
          session_id: String(sessionId).trim(),
        },
      });
    } catch (err) {
      const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
      const errorJson = JSON.stringify({
        level: 'ERROR',
        platform: 'squarespace',
        source: isFinerworksError ? 'finerworks_api' : 'lambda',
        function: 'syncSquarespaceProducts',
        account_key: accountKey || 'unknown',
        httpStatus: err?.response?.status || null,
        message: `Failed to fetch FinerWorks images for Squarespace sync: ${err?.message || 'Unknown error'}`,
        detail: err?.response?.data?.message || null,
        timestamp: new Date().toISOString()
      });
      console.error(errorJson);
      log('Formatted error in syncSquarespaceProducts (LIST_IMAGES): %s', errorJson);
      return sendApiError(res, err);
    }
    const allImages = extractImages(fwData);
    const guidSet = new Set(uniqueImageGuids);
    const matchedImages = allImages.filter((img) => guidSet.has(imageGuidFromImage(img)));
    const matchedByGuid = new Map();
    for (const img of matchedImages) {
      const g = imageGuidFromImage(img);
      if (g && !matchedByGuid.has(g)) matchedByGuid.set(g, img);
    }

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': process.env.SQUARESPACE_USER_AGENT || 'ofa-node',
    };

    let storePageId;
    try {
      storePageId = await fetchStorePageId(headers, explicitStorePageId);
    } catch (err) {
      const errorJson = JSON.stringify({
        level: 'ERROR',
        platform: 'squarespace',
        source: 'squarespace_api',
        function: 'syncSquarespaceProducts',
        account_key: accountKey || 'unknown',
        httpStatus: err?.response?.status || err?.status || null,
        message: `Failed to fetch Squarespace store pages: ${err?.message || 'Unknown error'}`,
        detail: err?.response?.data?.message || null,
        timestamp: new Date().toISOString()
      });
      console.error(errorJson);
      log('Formatted error in syncSquarespaceProducts (fetchStorePageId): %s', errorJson);
      return sendApiError(res, err);
    }

    if (!storePageId) {
      return sendApiError(res, 400, 'No valid Squarespace store page id found');
    }

    const results = [];
    const counters = {
      mainProductsCreated: 0,
      variantsAdded: 0,
      uploaded: 0,
      repaired: 0,
      failed: 0,
      partial: 0,
    };
    const unmatchedImageGuids = uniqueImageGuids.filter((g) => !matchedByGuid.has(g));

    for (const group of syncGroups) {
      if (!group.items?.length) continue;
      try {
        const resultEntry = await processSyncGroup({
          group,
          accountKey,
          currency,
          storePageId,
          headers,
          matchedByGuid,
          counters,
        });
        results.push(resultEntry);
      } catch (err) {
        counters.failed += 1;
        const data = err?.response?.data;
        const isSquarespaceErr = err?.response?.config?.url?.includes('squarespace') || err?.config?.url?.includes('squarespace') || err?.step === 'fetch_store_pages';
        const isFinerworksErr = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
        const groupErrorJson = JSON.stringify({
          level: 'ERROR',
          platform: 'squarespace',
          source: isSquarespaceErr ? 'squarespace_api' : (isFinerworksErr ? 'finerworks_api' : 'lambda'),
          function: 'syncSquarespaceProducts',
          account_key: accountKey || 'unknown',
          image_guid: group.image_guid || null,
          groupKey: group.key || null,
          httpStatus: err?.response?.status || err?.status || null,
          message: `Failed to sync Squarespace product group: ${err?.message || 'Unknown error'}`,
          detail: squarespaceErrorMessage(data, null),
          timestamp: new Date().toISOString()
        });
        console.error(groupErrorJson);
        log('Formatted error in syncSquarespaceProducts (group sync): %s', groupErrorJson);
        results.push({
          success: false,
          action: 'failed',
          image_guid: group.image_guid,
          groupKey: group.key,
          error: squarespaceErrorMessage(
            data,
            err?.message || 'Failed to sync Squarespace product'
          ),
          ...(authorizationHint(data) ? { hint: authorizationHint(data) } : {}),
          ...(data && typeof data === 'object' ? { squarespaceError: data } : {}),
        });
      }
    }

    const summary = buildSyncSummary(results);
    const allSuccess = results.every(
      (r) => r.success && !(r.virtualInventoryUpdateErrors && r.virtualInventoryUpdateErrors.length)
    );

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'squarespace',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'syncSquarespaceProducts',
      operation: allSuccess ? 'Squarespace product sync completed successfully' : 'Squarespace product sync completed with partial failures',
      account_key: accountKey || 'unknown',
      result: {
        allSuccess,
        totalGroups: syncGroups.length,
        uploaded: summary.uploaded,
        repaired: summary.repaired,
        variantsAdded: summary.variantsAdded,
        failed: summary.failed,
        partial: summary.partial,
        skipped: summary.skipped,
        matchedImageCount: matchedImages.length,
        unmatchedImageGuidCount: unmatchedImageGuids.length,
      },
      timestamp: new Date().toISOString()
    });
    console.log(successLog);
    log('Success in syncSquarespaceProducts: %s', successLog);

    return res.status(200).json({
      success: allSuccess,
      groupByImageGuid,
      uniqueImageGuidCount: uniqueImageGuids.length,
      uniqueImageGuids,
      totalImages: allImages.length,
      matchedImageCount: matchedImages.length,
      matchedImages,
      unmatchedImageGuidCount: unmatchedImageGuids.length,
      unmatchedImageGuids,
      mainProductsCreated: counters.mainProductsCreated,
      variantsAdded: counters.variantsAdded,
      report: {
        total: summary.total,
        uploaded: summary.uploaded,
        repaired: summary.repaired,
        variantsAdded: summary.variantsAdded,
        failed: summary.failed,
        partial: summary.partial,
        skipped: summary.skipped,
      },
      results,
    });
  } catch (err) {
    const isSquarespaceError = err?.response?.config?.url?.includes('squarespace') || err?.config?.url?.includes('squarespace');
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'squarespace',
      source: isSquarespaceError ? 'squarespace_api' : (isFinerworksError ? 'finerworks_api' : 'lambda'),
      function: 'syncSquarespaceProducts',
      account_key: req.body?.account_key || req.body?.accountKey || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Unexpected error in Squarespace product sync: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in syncSquarespaceProducts: %s', errorJson);
    return sendApiError(res, err);
  }
};

function parseVariantFlag(value) {
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  return false;
}

function buildVariantLabelForV2(product) {
  const fromDescription = buildVariantLabel(product);
  if (fromDescription && fromDescription !== 'Variant') return fromDescription;
  const name = product?.name != null ? String(product.name).trim() : '';
  if (name) return name;
  return normalizeSku(product?.sku) || 'Variant';
}

function buildVariantRowV2(src, currency, { includeAttributes = false } = {}) {
  const sku = normalizeSku(src?.sku);
  if (!sku) return null;

  const row = {
    sku,
    pricing: { basePrice: buildBasePrice(currency, getSquarespaceSyncPrice(src)) },
    stock: {
      quantity: Math.max(0, Math.round(Number(getQuantity(src) || 0))),
      unlimited: false,
    },
  };

  if (includeAttributes) {
    row.attributes = { Configuration: buildVariantLabelForV2(src) };
  }

  return row;
}

/**
 * variant=false: one Squarespace product per productsList item.
 * variant=true: group by image_guid; primaryItem=true is the main product, others are variants.
 */
function buildSyncGroupsV2(rawProducts, variantMode) {
  if (!variantMode) {
    return rawProducts
      .map((p) => {
        const sku = normalizeSku(p?.sku);
        if (!sku) return null;
        const image_guid = String(p?.image_guid || '').trim() || sku;
        return {
          key: sku,
          image_guid,
          items: [p],
          simpleProduct: true,
          variantMode: false,
        };
      })
      .filter(Boolean);
  }

  const byGuid = new Map();
  for (const p of rawProducts) {
    const image_guid = String(p?.image_guid || '').trim();
    if (!image_guid) continue;
    if (!byGuid.has(image_guid)) byGuid.set(image_guid, []);
    byGuid.get(image_guid).push(p);
  }

  return Array.from(byGuid.entries())
    .map(([image_guid, items]) => {
      const sorted = [...items].sort((a, b) => {
        const aPrimary = a?.primaryItem === true ? 0 : 1;
        const bPrimary = b?.primaryItem === true ? 0 : 1;
        return aPrimary - bPrimary;
      });
      const withSku = sorted.filter((p) => normalizeSku(p?.sku));
      if (!withSku.length) return null;
      const primaryItem = withSku.find((p) => p?.primaryItem === true) || withSku[0];
      return {
        key: image_guid,
        image_guid,
        items: withSku,
        primaryItem,
        simpleProduct: withSku.length === 1,
        variantMode: true,
      };
    })
    .filter(Boolean);
}

async function updateVirtualInventoryV2(accountKey, items, productId, variantIdBySku, variantMode) {
  const virtualInventoryUpdates = [];
  const virtualInventoryUpdateErrors = [];

  if (!productId || !accountKey || !String(accountKey).trim()) {
    return { virtualInventoryUpdates, virtualInventoryUpdateErrors };
  }

  const squarespaceProductId = String(productId);
  const trimmedAccountKey = String(accountKey).trim();

  const results = await Promise.all(
    items.map(async (src) => {
      const srcSku = normalizeSku(src?.sku);
      if (!srcSku) return null;

      const isPrimary = src?.primaryItem === true;
      const squarespaceVariantId = variantIdBySku.get(srcSku) || null;
      const integrations = { ...(src?.third_party_integrations || {}) };
      integrations.squarespace_product_id = squarespaceProductId;

      if (variantMode && !isPrimary && squarespaceVariantId) {
        integrations.squarespace_variant_id = String(squarespaceVariantId);
      }

      const viItem = {
        sku: srcSku,
        asking_price:
          typeof src?.asking_price === 'number' && Number.isFinite(src.asking_price)
            ? src.asking_price
            : getSquarespaceSyncPrice(src),
        name: pickVirtualInventoryName(src),
        description: src?.description_long ?? src?.description_short ?? '',
        quantity_in_stock: Math.max(0, Math.round(Number(getQuantity(src) || 0))),
        track_inventory: true,
        third_party_integrations: integrations,
      };

      try {
        const updateResult = await finerworksService.UPDATE_VIRTUAL_INVENTORY({
          virtual_inventory: [viItem],
          account_key: trimmedAccountKey,
        });
        return {
          ok: true,
          sku: srcSku,
          isPrimary: variantMode ? isPrimary : null,
          squarespace_product_id: squarespaceProductId,
          squarespace_variant_id:
            variantMode && !isPrimary && squarespaceVariantId ? String(squarespaceVariantId) : null,
          result: updateResult,
        };
      } catch (singleErr) {
        return {
          ok: false,
          sku: srcSku,
          error: singleErr?.message || 'Unknown virtual inventory update error',
        };
      }
    })
  );

  for (const entry of results) {
    if (!entry) continue;
    if (entry.ok) {
      virtualInventoryUpdates.push({
        sku: entry.sku,
        isPrimary: entry.isPrimary,
        squarespace_product_id: entry.squarespace_product_id,
        squarespace_variant_id: entry.squarespace_variant_id,
        result: entry.result,
      });
    } else {
      virtualInventoryUpdateErrors.push({ sku: entry.sku, error: entry.error });
    }
  }

  return { virtualInventoryUpdates, virtualInventoryUpdateErrors };
}

function isUrlSlugUnavailableError(data) {
  return (
    data?.subtype === 'URL_SLUG_UNAVAILABLE' ||
    (typeof data?.message === 'string' &&
      /url slug is already in use/i.test(data.message))
  );
}

function uniqueUrlSlug(baseSlug) {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const base = String(baseSlug || 'product')
    .replace(/-+$/g, '')
    .slice(0, Math.max(1, 96 - suffix.length - 1));
  return `${base}-${suffix}`;
}

async function createSquarespaceProductWithSlugRetry(createPayload, headers, { maxAttempts = 3 } = {}) {
  let payload = { ...createPayload };
  let lastResp = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) {
      payload = {
        ...payload,
        urlSlug: uniqueUrlSlug(createPayload.urlSlug),
      };
    }

    const createResp = await axios.post(`${API_BASE}/products`, payload, {
      headers,
      validateStatus: () => true,
    });
    lastResp = createResp;

    if (createResp.status >= 200 && createResp.status < 300) {
      return { createResp, urlSlug: payload.urlSlug, attempts: attempt + 1 };
    }

    if (!isUrlSlugUnavailableError(createResp.data) || attempt === maxAttempts - 1) {
      return { createResp, urlSlug: payload.urlSlug, attempts: attempt + 1 };
    }
  }

  return { createResp: lastResp, urlSlug: payload.urlSlug, attempts: maxAttempts };
}

async function processSyncGroupV2({
  group,
  accountKey,
  currency,
  storePageId,
  headers,
  matchedByGuid,
}) {
  const { items, simpleProduct, variantMode, image_guid: guid, key } = group;
  const primary = variantMode ? group.primaryItem || items[0] : items[0];
  const matched = matchedByGuid.get(guid) || null;

  const productName =
    (primary?.name && String(primary.name).trim()) ||
    (matched?.title && String(matched.title).trim()) ||
    normalizeSku(primary?.sku) ||
    'Untitled';
  const description =
    (matched?.description && String(matched.description).trim()) ||
    primary?.description_long ||
    primary?.description_short ||
    '';

  const useVariantAttributes = variantMode && !simpleProduct && items.length > 1;
  const variantRows = items
    .map((src) => buildVariantRowV2(src, currency, { includeAttributes: useVariantAttributes }))
    .filter(Boolean);

  if (!variantRows.length) {
    return {
      success: false,
      action: 'failed',
      image_guid: guid,
      groupKey: key,
      variantMode,
      error: 'No valid variants (missing SKU)',
    };
  }

  const productMode = simpleProduct ? 'simple' : 'multi_variant';

  // Skip create when squarespace_product_id is already set on the primary (or any group item).
  let existingProductId =
    getSquarespaceLinkFromItem(primary).squarespace_product_id ||
    resolveGroupProductId(items);

  if (existingProductId) {
    const exists = await verifySquarespaceProductExists(existingProductId, headers);
    if (!exists) {
      existingProductId = null;
    }
  }

  if (existingProductId) {
    const variantIdBySku = await fetchVariantIdBySku(existingProductId, headers, {
      retries: 2,
      delayMs: 300,
    });
    const skusNeedingSquarespace = [];
    const variantCreateErrors = [];

    for (const src of items) {
      const sku = normalizeSku(src?.sku);
      if (!sku) continue;
      const link = getSquarespaceLinkFromItem(src);
      const existingVariantId = link.squarespace_variant_id || variantIdBySku.get(sku);
      if (existingVariantId) {
        variantIdBySku.set(sku, existingVariantId);
      } else if (!simpleProduct || items.length > 1) {
        skusNeedingSquarespace.push(src);
      } else {
        const onlyVariantId = variantIdBySku.get(sku);
        if (onlyVariantId) variantIdBySku.set(sku, onlyVariantId);
      }
    }

    const variantCreateResults = await Promise.all(
      skusNeedingSquarespace.map(async (src) => {
        const row = buildVariantRowV2(src, currency, { includeAttributes: useVariantAttributes });
        if (!row) return { created: false };
        try {
          const { variantId, sku } = await createSquarespaceVariant(existingProductId, row, headers);
          if (sku && variantId) {
            variantIdBySku.set(sku, variantId);
            return { created: true };
          }
          return { created: false };
        } catch (err) {
          variantCreateErrors.push({
            sku: normalizeSku(src?.sku),
            error: err?.message || 'Failed to create variant',
          });
          return { created: false };
        }
      })
    );
    const variantsCreatedOnSquarespace = variantCreateResults.filter((r) => r.created).length;

    let variantImageAssociations = [];
    const skusForImages = skusNeedingSquarespace.map((s) => normalizeSku(s?.sku)).filter(Boolean);
    if (skusForImages.length) {
      const img = await uploadAndAssociateImages({
        productId: existingProductId,
        srcVariants: items,
        matched,
        first: primary,
        headers,
        skusForImages,
        variantIdBySkuSeed: variantIdBySku,
        fast: true,
      });
      variantImageAssociations = img.variantImageAssociations;
      for (const [sku, vid] of img.variantIdBySku.entries()) {
        if (vid) variantIdBySku.set(sku, vid);
      }
    } else if (!variantIdBySku.size) {
      const refreshed = await fetchVariantIdBySku(existingProductId, headers, {
        retries: 2,
        delayMs: 300,
      });
      for (const [sku, vid] of refreshed.entries()) {
        if (vid) variantIdBySku.set(sku, vid);
      }
    }

    const resultEntry = {
      success: true,
      action: variantsCreatedOnSquarespace > 0 ? 'variants_added' : 'skipped_existing',
      image_guid: guid,
      groupKey: key,
      variantMode,
      productMode,
      squarespaceProductId: existingProductId,
      variantCount: variantRows.length,
      variantsCreatedOnSquarespace,
      skusSynced: items.map((s) => normalizeSku(s?.sku)).filter(Boolean),
      variantImageAssociations,
      ...(variantCreateErrors.length ? { variantCreateErrors } : {}),
    };

    const finalized = await finalizeSquarespaceProductForStore({
      productId: existingProductId,
      headers,
      expectedStorePageId: storePageId,
      searchQuery: normalizeSku(primary?.sku),
    });
    if (finalized?.product) {
      resultEntry.squarespaceProduct = buildSquarespaceProductSummary(finalized.product);
      mergeVariantIdsFromProductData(variantIdBySku, finalized.product);
      if (finalized.warning) resultEntry.storeVisibilityWarning = finalized.warning;
      resultEntry.catalogVerified = finalized.catalogMatch?.found ?? null;
    }

    const viResult = await updateVirtualInventoryV2(
      accountKey,
      items,
      existingProductId,
      variantIdBySku,
      variantMode
    );
    applyViResultToEntry(resultEntry, viResult);

    if (variantCreateErrors.length && resultEntry.success) {
      resultEntry.action = 'partial';
      resultEntry.success = false;
    }

    return resultEntry;
  }

  const slugSeed = simpleProduct
    ? `${productName}-${normalizeSku(primary?.sku) || guid}`
    : `${productName}-${guid}`;

  const createPayload = {
    name: productName,
    description,
    type: 'PHYSICAL',
    isVisible: true,
    storePageId,
    urlSlug: slugify(slugSeed) || `product-${Date.now()}`,
    ...(useVariantAttributes ? { variantAttributes: ['Configuration'] } : {}),
    variants: variantRows,
  };

  const { createResp, urlSlug, attempts } = await createSquarespaceProductWithSlugRetry(
    createPayload,
    headers,
    { maxAttempts: 3 }
  );

  if (createResp.status < 200 || createResp.status >= 300) {
    const data = createResp.data;
    return {
      success: false,
      action: 'failed',
      image_guid: guid,
      groupKey: key,
      variantMode,
      productMode,
      urlSlug,
      createAttempts: attempts,
      error: squarespaceErrorMessage(data, 'Failed to create Squarespace product'),
      ...(authorizationHint(data) ? { hint: authorizationHint(data) } : {}),
      ...(data && typeof data === 'object' ? { squarespaceError: data } : {}),
    };
  }

  const productId = createResp?.data?.id || null;
  if (!productId) {
    return {
      success: false,
      action: 'failed',
      image_guid: guid,
      groupKey: key,
      variantMode,
      error: 'Squarespace product id missing in response',
    };
  }

  let variantIdBySku = mergeVariantIdsFromProductData(new Map(), createResp.data);
  const { variantIdBySku: uploadedVariantIds, variantImageAssociations } =
    await uploadAndAssociateImages({
      productId,
      srcVariants: items,
      matched,
      first: primary,
      headers,
      variantIdBySkuSeed: variantIdBySku,
      fast: true,
    });
  for (const [sku, vid] of uploadedVariantIds.entries()) {
    if (vid) variantIdBySku.set(sku, vid);
  }
  if (variantIdBySku.size < variantRows.length) {
    const fetchedIds = await fetchVariantIdBySku(productId, headers, {
      retries: 2,
      delayMs: 300,
    });
    for (const [sku, vid] of fetchedIds.entries()) {
      if (vid) variantIdBySku.set(sku, vid);
    }
  }

  const finalized = await finalizeSquarespaceProductForStore({
    productId,
    headers,
    expectedStorePageId: storePageId,
    searchQuery: normalizeSku(primary?.sku),
    productHint: parseSquarespaceProductRecord(createResp.data),
  });
  if (!finalized.product?.id) {
    return {
      success: false,
      action: 'failed',
      image_guid: guid,
      groupKey: key,
      variantMode,
      productMode,
      squarespaceProductId: productId,
      urlSlug,
      createAttempts: attempts,
      error:
        'Squarespace returned a product id but the product could not be retrieved. Confirm the OAuth token matches the store you are viewing and that storePageId is correct.',
    };
  }

  const squarespaceProductRecord = finalized.product;
  mergeVariantIdsFromProductData(variantIdBySku, squarespaceProductRecord);

  const resultEntry = {
    success: true,
    action: 'created',
    image_guid: guid,
    groupKey: key,
    variantMode,
    productMode,
    squarespaceProductId: productId,
    squarespaceProduct: buildSquarespaceProductSummary(squarespaceProductRecord),
    urlSlug: squarespaceProductRecord.urlSlug || urlSlug,
    createAttempts: attempts,
    variantCount: variantRows.length,
    skusSynced: items.map((s) => normalizeSku(s?.sku)).filter(Boolean),
    variantImageAssociations,
    catalogVerified: finalized.catalogMatch?.found ?? null,
    ...(finalized.warning ? { storeVisibilityWarning: finalized.warning } : {}),
  };

  const viResult = await updateVirtualInventoryV2(
    accountKey,
    items,
    productId,
    variantIdBySku,
    variantMode
  );
  applyViResultToEntry(resultEntry, viResult);

  return resultEntry;
}

const syncSquarespaceProductsV2 = async (req, res) => {
  try {
    const accessToken = req.body?.access_token || req.headers['x-squarespace-access-token'];
    const accountKey = req.body?.account_key || req.body?.accountKey;
    const siteId = req.body?.site_id ?? req.body?.siteId ?? process.env.FINERWORKS_SITE_ID ?? 2;
    const sessionId =
      req.body?.session_id || req.body?.sessionId || process.env.FINERWORKS_SESSION_ID || null;
    const currency = req.body?.currency || 'USD';
    const rawProducts = Array.isArray(req.body?.productsList) ? req.body.productsList : [];
    const explicitStorePageId = req.body?.storePageId || req.body?.store_page_id || null;
    const variantMode = parseVariantFlag(req.body?.variant);

    if (!accessToken) return sendApiError(res, 400, 'access_token is required');
    if (!accountKey || !String(accountKey).trim()) {
      return sendApiError(res, 400, 'account_key is required');
    }
    if (!sessionId || !String(sessionId).trim()) {
      return sendApiError(res, 400, 'session_id is required');
    }
    if (!rawProducts.length) {
      return sendApiError(res, 400, 'productsList must be a non-empty array');
    }

    const syncGroups = buildSyncGroupsV2(rawProducts, variantMode);

    if (!syncGroups.length) {
      const message = variantMode
        ? 'No valid products to sync (variant mode requires image_guid and sku on each item)'
        : 'No valid products to sync (each item needs sku)';
      return sendApiError(res, 400, message);
    }

    const uniqueImageGuids = [
      ...new Set(rawProducts.map((p) => String(p?.image_guid || '').trim()).filter(Boolean)),
    ];

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': process.env.SQUARESPACE_USER_AGENT || 'ofa-node',
    };

    let fwData;
    let storePageMeta = null;
    let squarespaceWebsite = null;
    try {
      const [listImagesResult, storePageResult, websiteResult] = await Promise.allSettled([
        finerworksService.LIST_IMAGES({
          library: {
            account_key: String(accountKey).trim(),
            site_id: Number(siteId),
            session_id: String(sessionId).trim(),
          },
        }),
        resolveStorePage(headers, explicitStorePageId),
        fetchSquarespaceWebsiteInfo(headers),
      ]);

      if (listImagesResult.status !== 'fulfilled') {
        throw listImagesResult.reason;
      }
      fwData = listImagesResult.value;

      if (storePageResult.status === 'fulfilled') {
        storePageMeta = storePageResult.value;
      } else {
        throw storePageResult.reason;
      }

      if (websiteResult.status === 'fulfilled') {
        squarespaceWebsite = websiteResult.value;
      }
    } catch (err) {
      const isFinerworksError =
        err?.response?.config?.url?.includes('finerworks.com') ||
        err?.config?.url?.includes('finerworks.com');
      const errorJson = JSON.stringify({
        level: 'ERROR',
        platform: 'squarespace',
        source: isFinerworksError ? 'finerworks_api' : 'lambda',
        function: 'syncSquarespaceProductsV2',
        account_key: accountKey || 'unknown',
        httpStatus: err?.response?.status || null,
        message: `Failed to prepare Squarespace sync: ${err?.message || 'Unknown error'}`,
        detail: err?.response?.data?.message || null,
        timestamp: new Date().toISOString(),
      });
      console.error(errorJson);
      log('Formatted error in syncSquarespaceProductsV2 (prepare): %s', errorJson);
      return sendApiError(res, err);
    }

    const allImages = extractImages(fwData);
    const guidSet = new Set(uniqueImageGuids);
    const matchedImages = allImages.filter((img) => guidSet.has(imageGuidFromImage(img)));
    const matchedByGuid = new Map();
    for (const img of matchedImages) {
      const g = imageGuidFromImage(img);
      if (g && !matchedByGuid.has(g)) matchedByGuid.set(g, img);
    }

    const storePageId = storePageMeta?.storePageId || null;

    if (!storePageId) {
      const message =
        storePageMeta?.storePageSelectionWarning ||
        'No enabled Squarespace store page found. Pass storePageId in the request body.';
      return sendApiError(res, 400, message, {
        storePages: storePageMeta?.storePages || [],
      });
    }

    const results = [];
    let uploaded = 0;
    let skippedExisting = 0;
    let failed = 0;
    let partial = 0;
    const unmatchedImageGuids = uniqueImageGuids.filter((g) => !matchedByGuid.has(g));

    for (const group of syncGroups) {
      if (!group.items?.length) continue;
      try {
        const resultEntry = await processSyncGroupV2({
          group,
          accountKey,
          currency,
          storePageId,
          headers,
          matchedByGuid,
        });
        results.push(resultEntry);
        if (resultEntry.success) {
          if (resultEntry.virtualInventoryUpdateErrors?.length) partial += 1;
          else if (resultEntry.action === 'skipped_existing') skippedExisting += 1;
          else uploaded += 1;
        } else {
          failed += 1;
        }
      } catch (err) {
        failed += 1;
        const data = err?.response?.data;
        const groupErrorJson = JSON.stringify({
          level: 'ERROR',
          platform: 'squarespace',
          source: 'squarespace_api',
          function: 'syncSquarespaceProductsV2',
          account_key: accountKey || 'unknown',
          image_guid: group.image_guid || null,
          groupKey: group.key || null,
          httpStatus: err?.response?.status || err?.status || null,
          message: `Failed to sync Squarespace product group: ${err?.message || 'Unknown error'}`,
          detail: squarespaceErrorMessage(data, null),
          timestamp: new Date().toISOString(),
        });
        console.error(groupErrorJson);
        log('Formatted error in syncSquarespaceProductsV2 (group sync): %s', groupErrorJson);
        results.push({
          success: false,
          action: 'failed',
          image_guid: group.image_guid,
          groupKey: group.key,
          variantMode,
          error: squarespaceErrorMessage(data, err?.message || 'Failed to sync Squarespace product'),
          ...(authorizationHint(data) ? { hint: authorizationHint(data) } : {}),
          ...(data && typeof data === 'object' ? { squarespaceError: data } : {}),
        });
      }
    }

    const allSuccess = results.every(
      (r) => r.success && !(r.virtualInventoryUpdateErrors && r.virtualInventoryUpdateErrors.length)
    );

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'squarespace',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'syncSquarespaceProductsV2',
      operation: allSuccess
        ? 'Squarespace product sync v2 completed successfully'
        : 'Squarespace product sync v2 completed with partial failures',
      account_key: accountKey || 'unknown',
      result: {
        allSuccess,
        variantMode,
        totalGroups: syncGroups.length,
        uploaded,
        skippedExisting,
        failed,
        partial,
        matchedImageCount: matchedImages.length,
        unmatchedImageGuidCount: unmatchedImageGuids.length,
      },
      timestamp: new Date().toISOString(),
    });
    console.log(successLog);
    log('Success in syncSquarespaceProductsV2: %s', successLog);

    return res.status(200).json({
      success: allSuccess,
      variantMode,
      squarespaceWebsite,
      storePageId,
      storePageTitle: storePageMeta?.storePageTitle || null,
      storePageUrlSlug: storePageMeta?.storePageUrlSlug || null,
      storePageEnabled: storePageMeta?.storePageEnabled ?? null,
      storePageSelectionWarning: storePageMeta?.storePageSelectionWarning || null,
      storePages: storePageMeta?.storePages || [],
      uniqueImageGuidCount: uniqueImageGuids.length,
      uniqueImageGuids,
      totalImages: allImages.length,
      matchedImageCount: matchedImages.length,
      matchedImages,
      unmatchedImageGuidCount: unmatchedImageGuids.length,
      unmatchedImageGuids,
      report: {
        total: results.length,
        uploaded,
        skippedExisting,
        failed,
        partial,
      },
      results,
    });
  } catch (err) {
    const isSquarespaceError =
      err?.response?.config?.url?.includes('squarespace') ||
      err?.config?.url?.includes('squarespace');
    const isFinerworksError =
      err?.response?.config?.url?.includes('finerworks.com') ||
      err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'squarespace',
      source: isSquarespaceError ? 'squarespace_api' : isFinerworksError ? 'finerworks_api' : 'lambda',
      function: 'syncSquarespaceProductsV2',
      account_key: req.body?.account_key || req.body?.accountKey || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Unexpected error in Squarespace product sync v2: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || null,
      timestamp: new Date().toISOString(),
    });
    console.error(errorJson);
    log('Formatted error in syncSquarespaceProductsV2: %s', errorJson);
    return sendApiError(res, err);
  }
};

module.exports = { syncSquarespaceProducts, syncSquarespaceProductsV2 };