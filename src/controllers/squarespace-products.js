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

async function waitImageReady(productId, imageId, headers) {
  if (!imageId) return;
  const statusUrl = `${API_BASE}/products/${encodeURIComponent(productId)}/images/${encodeURIComponent(imageId)}/status`;
  for (let i = 0; i < 45; i++) {
    try {
      const r = await axios.get(statusUrl, { headers, timeout: 30000, validateStatus: () => true });
      const st = r?.data?.status;
      if (st === 'READY' || st === 'ERROR') return;
    } catch (_) {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
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

async function verifySquarespaceProductExists(productId, headers) {
  const id = String(productId || '').trim();
  if (!id) return false;
  const r = await axios.get(`${API_BASE}/products/${encodeURIComponent(id)}`, {
    headers,
    timeout: 60000,
    validateStatus: () => true,
  });
  return r.status >= 200 && r.status < 300;
}

async function fetchVariantIdBySku(productId, headers) {
  const variantIdBySku = new Map();
  const id = String(productId || '').trim();
  if (!id) return variantIdBySku;

  try {
    const pr = await axios.get(`${API_BASE}/products/${encodeURIComponent(id)}`, {
      headers,
      timeout: 60000,
      validateStatus: () => true,
    });
    if (pr.status < 200 || pr.status >= 300) return variantIdBySku;
    const sqVariants = Array.isArray(pr?.data?.variants) ? pr.data.variants : [];
    for (const v of sqVariants) {
      const sku = normalizeSku(v?.sku);
      if (sku) variantIdBySku.set(sku, v?.id || null);
    }
  } catch (_) {
    // non-fatal
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
}) {
  const skuFilter = skusForImages ? new Set(skusForImages) : null;
  const mainImageUrl = previewUrlFromMatchedImage(matched) || firstHttpUrlFromPayload(first);
  const uploadedByUrl = new Map();
  const variantImageAssociations = [];

  if (mainImageUrl) {
    try {
      const imageId = await uploadImageToProduct(productId, mainImageUrl, headers);
      if (imageId) uploadedByUrl.set(mainImageUrl, imageId);
    } catch (_) {
      // non-fatal
    }
  }

  const variantImageUrlBySku = new Map();
  for (const src of srcVariants) {
    const sku = normalizeSku(src?.sku);
    if (!sku || (skuFilter && !skuFilter.has(sku))) continue;
    const vUrl = firstHttpUrlFromPayload(src);
    if (vUrl) variantImageUrlBySku.set(sku, vUrl);
  }

  for (const vUrl of new Set(Array.from(variantImageUrlBySku.values()))) {
    if (uploadedByUrl.has(vUrl)) continue;
    try {
      const imageId = await uploadImageToProduct(productId, vUrl, headers);
      if (imageId) uploadedByUrl.set(vUrl, imageId);
    } catch (_) {
      // non-fatal
    }
  }

  const variantIdBySku = await fetchVariantIdBySku(productId, headers);
  for (const [sku, vUrl] of variantImageUrlBySku.entries()) {
    const variantId = variantIdBySku.get(sku);
    const imageId = uploadedByUrl.get(vUrl);
    if (!variantId || !imageId) continue;
    await waitImageReady(productId, imageId, headers);
    const ok = await associateVariantImage(productId, variantId, imageId, headers);
    variantImageAssociations.push({ sku, variantId, imageId, associated: ok });
  }

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

module.exports = { syncSquarespaceProducts };
