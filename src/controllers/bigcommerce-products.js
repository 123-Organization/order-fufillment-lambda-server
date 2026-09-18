const axios = require('axios');
const finerworksService = require('../helpers/finerworks-service');
const { sendApiError } = require('../helpers/api-error');
const { logIncomingRequest, redactAndTruncate } = require('../helpers/request-log');
const { getBigcommerceConnection, bigcommerceAuthHeaders, BIGCOMMERCE_API_BASE } = require('./bigcommerce-auth');
const debug = require('debug');
const log = debug('app:bigcommerceProducts');

/** BigCommerce caps product name at 250 chars, variant SKU at 255. */
const MAX_BC_PRODUCT_NAME_LEN = 250;
const MAX_BC_VARIANT_LABEL_LEN = 250;

function normalizeSku(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function pickName(p) {
  return (
    (p?.name && String(p.name).trim()) ||
    (p?.title && String(p.title).trim()) ||
    (p?.product_name && String(p.product_name).trim()) ||
    (p?.sku && String(p.sku).trim()) ||
    'Untitled'
  ).slice(0, MAX_BC_PRODUCT_NAME_LEN);
}

function pickDescription(p) {
  const d = p?.description_long ?? p?.description_short ?? p?.description ?? null;
  if (typeof d !== 'string') return '';
  return d.trim();
}

function pickPrice(p) {
  return Number(
    p?.asking_price ||
      p?.per_item_price ||
      p?.price_details?.product_price ||
      p?.price_details?.total_price ||
      p?.total_price ||
      0
  );
}

function pickQty(p) {
  const q = Number(p?.quantity_in_stock ?? p?.quantity ?? p?.inventory_quantity ?? 0);
  if (Number.isFinite(q) && q >= 0) return Math.round(q);
  return 0;
}

/**
 * BigCommerce requires `weight` on every physical product (used for shipping calculations),
 * but FinerWorks virtual-inventory rows don't carry one. Fall back to a nominal placeholder
 * rather than failing sync outright — real weight can be corrected in BigCommerce afterward.
 */
function pickWeight(p) {
  const w = Number(p?.weight ?? p?.shipping_weight ?? 0);
  return Number.isFinite(w) && w > 0 ? w : 0.1;
}

function pickImageUrls(p) {
  const urls = [];
  for (let i = 1; i <= 5; i++) {
    const u = p?.[`image_url_${i}`];
    if (typeof u === 'string') {
      const t = u.trim();
      if (/^https?:\/\//i.test(t)) urls.push(t);
    }
  }
  return [...new Set(urls)];
}

/** Same idea as Square/Wix/Squarespace: label each variant row for the option picker. */
function buildVariantLabel(product) {
  const d =
    product?.price_details?.debug?.Description || product?.price_details?.debug?.description || null;
  if (d && typeof d === 'object') {
    const parts = [d.Media || d.media, d.Style || d.style, d.Size || d.size]
      .map((x) => String(x || '').trim())
      .filter(Boolean);
    if (parts.length) return parts.join(' : ');
  }
  return normalizeSku(product?.sku) || 'Variant';
}

function truncateLabel(s) {
  return String(s || '').trim().slice(0, MAX_BC_VARIANT_LABEL_LEN);
}

/** Ensure variant option-value labels are unique within the product. */
function uniqueVariantLabels(items, labelFn) {
  const used = new Set();
  const out = [];
  for (let i = 0; i < items.length; i++) {
    let label = String(labelFn(items[i]) || '').trim();
    if (!label) label = normalizeSku(items[i]?.sku) || `Option ${i + 1}`;

    let candidate = truncateLabel(label);
    let n = 2;
    while (used.has(candidate)) {
      const suffix = ` (${n})`;
      const maxBase = MAX_BC_VARIANT_LABEL_LEN - suffix.length;
      candidate = truncateLabel(`${label.slice(0, Math.max(1, maxBase))}${suffix}`);
      n++;
    }
    used.add(candidate);
    out.push(candidate);
  }
  return out;
}

/**
 * Order-preserving jobs: items without `image_guid` are each a separate product; items
 * sharing the same `image_guid` are one product with multiple variants (same grouping Square/
 * Wix/Squarespace use).
 */
function isAlreadyOnBigcommerce(p) {
  const tpi = p?.third_party_integrations;
  return !!(tpi && tpi.bigcommerce_product_id);
}

function buildSyncJobs(rawProducts) {
  const processedGuid = new Set();
  const jobs = [];
  for (const p of rawProducts) {
    if (isAlreadyOnBigcommerce(p)) continue;
    const g = String(p?.image_guid || '').trim();
    if (!g) {
      jobs.push({ kind: 'single', items: [p] });
      continue;
    }
    if (processedGuid.has(g)) continue;
    processedGuid.add(g);
    const items = rawProducts.filter((q) => String(q?.image_guid || '').trim() === g && !isAlreadyOnBigcommerce(q));
    if (!items.length) continue;
    jobs.push(items.length <= 1 ? { kind: 'single', items, image_guid: g } : { kind: 'variants', items, image_guid: g });
  }
  return jobs;
}

function summarizeBigcommerceHttpError(r) {
  const payload = {};
  const d = r?.data;
  if (typeof d === 'string' && d.trim()) {
    payload.rawBody = d.trim().slice(0, 2000);
    payload.message = d.trim().slice(0, 500);
  } else if (d && typeof d === 'object') {
    payload.title = d.title || null;
    payload.message = d.title || d.detail || null;
    if (Array.isArray(d.errors) && d.errors.length && !payload.message) {
      payload.message = Object.values(d.errors).filter(Boolean).join(' | ').slice(0, 500);
    }
  }
  if (r?.status != null) payload.httpStatus = r.status;
  if (r?.statusText) payload.httpStatusText = r.statusText;
  return payload;
}

function buildImagesPayload(items) {
  const urls = [];
  for (const src of items) {
    for (const u of pickImageUrls(src)) {
      if (!urls.includes(u)) urls.push(u);
    }
  }
  return urls.map((image_url, idx) => ({ image_url, is_thumbnail: idx === 0, sort_order: idx }));
}

/** POST /v3/catalog/products — single-variant product; sku/price/inventory/images all inline. */
async function createSingleProduct({ storeHash, headers, item }) {
  const body = {
    name: pickName(item),
    type: 'physical',
    weight: pickWeight(item),
    price: pickPrice(item),
    sku: normalizeSku(item?.sku) || undefined,
    description: pickDescription(item),
    inventory_level: pickQty(item),
    inventory_tracking: 'product',
    images: buildImagesPayload([item]),
  };
  return axios.post(`${BIGCOMMERCE_API_BASE}/stores/${storeHash}/v3/catalog/products`, body, {
    headers,
    timeout: 60000,
    validateStatus: () => true,
  });
}

/** POST /v3/catalog/products — base product only; variants (with their own sku/price) follow. */
async function createVariantParentProduct({ storeHash, headers, items }) {
  const first = items[0];
  const body = {
    name: pickName(first),
    type: 'physical',
    weight: pickWeight(first),
    price: pickPrice(first),
    description: pickDescription(first),
    inventory_tracking: 'variant',
    images: buildImagesPayload(items),
  };
  return axios.post(`${BIGCOMMERCE_API_BASE}/stores/${storeHash}/v3/catalog/products`, body, {
    headers,
    timeout: 60000,
    validateStatus: () => true,
  });
}

/** POST /v3/catalog/products/{id}/options — one option carrying one value per variant row. */
async function createVariantOption({ storeHash, headers, productId, items }) {
  const labels = uniqueVariantLabels(items, buildVariantLabel);
  const body = {
    display_name: 'Variant',
    type: 'dropdown',
    option_values: labels.map((label, idx) => ({ label, sort_order: idx })),
  };
  const r = await axios.post(
    `${BIGCOMMERCE_API_BASE}/stores/${storeHash}/v3/catalog/products/${productId}/options`,
    body,
    { headers, timeout: 30000, validateStatus: () => true }
  );
  return { r, labels };
}

/** POST /v3/catalog/products/{id}/variants — one call per row, referencing the option value. */
async function createVariant({ storeHash, headers, productId, optionId, optionValueId, item }) {
  const body = {
    sku: normalizeSku(item?.sku) || undefined,
    price: pickPrice(item),
    weight: pickWeight(item),
    inventory_level: pickQty(item),
    option_values: [{ id: optionValueId, option_id: optionId }],
  };
  return axios.post(
    `${BIGCOMMERCE_API_BASE}/stores/${storeHash}/v3/catalog/products/${productId}/variants`,
    body,
    { headers, timeout: 30000, validateStatus: () => true }
  );
}

/**
 * Writes BigCommerce ids back into FinerWorks virtual inventory per SKU so the item is never
 * exported twice and order sync can map BigCommerce line items back to OFA (mirrors
 * updateVirtualInventoryWithSquareIds in square-products.js).
 */
async function updateVirtualInventoryWithBigcommerceIds(accountKey, items, productId, variantIdBySku) {
  const virtualInventoryUpdates = [];
  const virtualInventoryUpdateErrors = [];
  if (!productId || !accountKey) return { virtualInventoryUpdates, virtualInventoryUpdateErrors };

  for (const src of items) {
    const srcSku = normalizeSku(src?.sku);
    if (!srcSku) continue;
    const variantId = variantIdBySku.get(srcSku) || null;
    const viItem = {
      sku: srcSku,
      asking_price: pickPrice(src),
      name: pickName(src),
      description: pickDescription(src),
      quantity_in_stock: pickQty(src),
      track_inventory: true,
      third_party_integrations: {
        ...(src?.third_party_integrations || {}),
        bigcommerce_product_id: String(productId),
        ...(variantId ? { bigcommerce_variant_id: String(variantId) } : {}),
      },
    };
    try {
      const updateResult = await finerworksService.UPDATE_VIRTUAL_INVENTORY({
        virtual_inventory: [viItem],
        account_key: String(accountKey).trim(),
      });
      virtualInventoryUpdates.push({ sku: srcSku, result: updateResult });
    } catch (singleErr) {
      virtualInventoryUpdateErrors.push({ sku: srcSku, error: singleErr?.message || 'Unknown virtual inventory update error' });
    }
  }
  return { virtualInventoryUpdates, virtualInventoryUpdateErrors };
}

/**
 * Sync products from the OFA payload to a merchant's BigCommerce catalog.
 *
 * Mirrors Square/Wix/Squarespace:
 * - `productList` / `productsList` in body (same shapes as elsewhere), `account_key` required
 * - Rows sharing the same `image_guid` export as **one BigCommerce product** with multiple
 *   variants; rows without `image_guid` export as single-variant products
 * - BigCommerce ids are written back to FinerWorks virtual inventory
 *   (`third_party_integrations.bigcommerce_product_id` / `bigcommerce_variant_id`)
 *
 * Unlike Square, BigCommerce takes sku/price/inventory_level/images inline in one
 * POST /v3/catalog/products call for single-variant products — no separate inventory-adjustment
 * or multipart image-upload step needed. Multi-variant products need three calls (create the
 * product, create one option carrying a value per row, then one variant call per row).
 */
exports.syncBigcommerceProducts = async (req, res) => {
  try {
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'syncBigcommerceProducts',
      accountKey: req.body?.account_key || req.query?.account_key,
      body: req.body,
      query: req.query,
    });

    const account_key = req.body?.account_key || req.query?.account_key;
    const rawProducts =
      (Array.isArray(req.body?.productList) ? req.body.productList : null) ||
      (Array.isArray(req.body?.productsList) ? req.body.productsList : []);

    if (!account_key || !String(account_key).trim()) {
      return sendApiError(res, 400, 'account_key is required');
    }
    if (!Array.isArray(rawProducts) || !rawProducts.length) {
      return sendApiError(res, 400, 'productList / productsList must be a non-empty array');
    }

    const connection = await getBigcommerceConnection(account_key);
    if (!connection) {
      return sendApiError(
        res,
        400,
        'Missing BigCommerce auth. Connect BigCommerce for this account first (GET /bigcommerce/auth).'
      );
    }
    const headers = bigcommerceAuthHeaders(connection);
    const storeHash = connection.store_hash;

    const jobs = buildSyncJobs(rawProducts);
    if (!jobs.length) {
      return res.status(200).json({
        success: true,
        message: 'Nothing to sync (all products are already linked to BigCommerce)',
        created: 0,
        failed: 0,
        jobCount: 0,
        results: [],
      });
    }

    log('syncBigcommerceProducts: %d job(s) to process for account_key=%s', jobs.length, account_key);

    const results = [];
    let created = 0;
    let failed = 0;

    for (let ji = 0; ji < jobs.length; ji++) {
      const job = jobs[ji];
      const items = job.items;
      const guid = job.image_guid || null;
      const skuPreview = normalizeSku(items[0]?.sku);

      try {
        if (job.kind === 'single') {
          const r = await createSingleProduct({ storeHash, headers, item: items[0] });
          if (r.status < 200 || r.status >= 300) {
            failed += 1;
            results.push({
              success: false,
              jobIndex: ji,
              ...(guid ? { image_guid: guid } : {}),
              sku: skuPreview,
              status: r.status,
              bigcommerceError: summarizeBigcommerceHttpError(r),
            });
            continue;
          }

          const productId = r?.data?.data?.id || null;
          created += 1;
          const variantIdBySku = new Map();
          if (skuPreview) variantIdBySku.set(skuPreview, r?.data?.data?.variants?.[0]?.id || null);

          const resultEntry = {
            success: true,
            jobIndex: ji,
            ...(guid ? { image_guid: guid } : {}),
            variantCount: 1,
            sku: skuPreview,
            bigcommerceProductId: productId,
          };

          if (productId) {
            const viResult = await updateVirtualInventoryWithBigcommerceIds(account_key, items, productId, variantIdBySku);
            if (viResult.virtualInventoryUpdates.length) resultEntry.virtualInventoryUpdates = viResult.virtualInventoryUpdates;
            if (viResult.virtualInventoryUpdateErrors.length) resultEntry.virtualInventoryUpdateErrors = viResult.virtualInventoryUpdateErrors;
          }

          results.push(resultEntry);
          continue;
        }

        // kind === 'variants'
        const productResp = await createVariantParentProduct({ storeHash, headers, items });
        if (productResp.status < 200 || productResp.status >= 300) {
          failed += 1;
          results.push({
            success: false,
            jobIndex: ji,
            image_guid: guid,
            sku: skuPreview,
            status: productResp.status,
            bigcommerceError: summarizeBigcommerceHttpError(productResp),
          });
          continue;
        }
        const productId = productResp?.data?.data?.id;

        const { r: optionResp, labels } = await createVariantOption({ storeHash, headers, productId, items });
        if (optionResp.status < 200 || optionResp.status >= 300) {
          failed += 1;
          results.push({
            success: false,
            jobIndex: ji,
            image_guid: guid,
            sku: skuPreview,
            bigcommerceProductId: productId,
            status: optionResp.status,
            bigcommerceError: summarizeBigcommerceHttpError(optionResp),
            note: 'Product created but its variant option failed — product exists in BigCommerce without variants.',
          });
          continue;
        }
        const optionId = optionResp?.data?.data?.id;
        const optionValues = Array.isArray(optionResp?.data?.data?.option_values) ? optionResp.data.data.option_values : [];

        const variantIdBySku = new Map();
        const variantErrors = [];
        for (let vi = 0; vi < items.length; vi++) {
          const item = items[vi];
          const optionValueId = optionValues[vi]?.id;
          if (!optionValueId) {
            variantErrors.push({ sku: normalizeSku(item?.sku), error: `No matching option value for label "${labels[vi]}"` });
            continue;
          }
          const variantResp = await createVariant({ storeHash, headers, productId, optionId, optionValueId, item });
          if (variantResp.status < 200 || variantResp.status >= 300) {
            variantErrors.push({ sku: normalizeSku(item?.sku), error: summarizeBigcommerceHttpError(variantResp) });
            continue;
          }
          const sku = normalizeSku(item?.sku);
          if (sku) variantIdBySku.set(sku, variantResp?.data?.data?.id || null);
        }

        created += 1;
        const resultEntry = {
          success: variantErrors.length === 0,
          jobIndex: ji,
          image_guid: guid,
          variantCount: items.length,
          sku: skuPreview,
          bigcommerceProductId: productId,
          bigcommerceVariantIds: Object.fromEntries(variantIdBySku),
          ...(variantErrors.length ? { variantErrors } : {}),
        };

        const viResult = await updateVirtualInventoryWithBigcommerceIds(account_key, items, productId, variantIdBySku);
        if (viResult.virtualInventoryUpdates.length) resultEntry.virtualInventoryUpdates = viResult.virtualInventoryUpdates;
        if (viResult.virtualInventoryUpdateErrors.length) resultEntry.virtualInventoryUpdateErrors = viResult.virtualInventoryUpdateErrors;

        results.push(resultEntry);
      } catch (jobErr) {
        failed += 1;
        results.push({
          success: false,
          jobIndex: ji,
          ...(guid ? { image_guid: guid } : {}),
          sku: skuPreview,
          error: jobErr?.response?.data || jobErr?.message || 'Unknown error',
        });
      }
    }

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'bigcommerce',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'syncBigcommerceProducts',
      operation: 'BigCommerce products sync completed',
      account_key: String(account_key).trim(),
      result: { created, failed, jobCount: jobs.length, success: failed === 0 },
      timestamp: new Date().toISOString(),
    });
    console.log(successLog);
    log('Success in syncBigcommerceProducts: %s', successLog);

    return res.status(200).json({
      success: failed === 0,
      created,
      failed,
      jobCount: jobs.length,
      results,
    });
  } catch (err) {
    const isBigcommerceError =
      err?.response?.config?.url?.includes('bigcommerce.com') || err?.config?.url?.includes('bigcommerce.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'bigcommerce',
      source: isBigcommerceError ? 'bigcommerce_api' : 'lambda',
      function: 'syncBigcommerceProducts',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to sync BigCommerce products: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data ? redactAndTruncate(err.response.data, 1000) : null,
      timestamp: new Date().toISOString(),
    });
    console.error(errorJson);
    log('Formatted error in syncBigcommerceProducts: %s', errorJson);
    return sendApiError(res, err);
  }
};
