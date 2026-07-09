const axios = require('axios');
const crypto = require('crypto');
const FormData = require('form-data');
const finerworksService = require('../helpers/finerworks-service');
const { sendApiError } = require('../helpers/api-error');
const { putSquareAccount } = require('../helpers/square-accounts-dynamo');
const {
  getSquareBaseUrl,
  squareApiVersionHeader,
  refreshSquareTokensCore,
  getFinerworksSquareOAuthSnapshot,
} = require('./square-auth');
const debug = require('debug');
const log = debug('app:squareProducts');

/** Square caps CatalogItem.name at 512 chars and variation names at 255. */
const MAX_SQUARE_ITEM_NAME_LEN = 512;
const MAX_SQUARE_VARIATION_NAME_LEN = 255;

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
  );
}

function pickDescriptionHtml(p) {
  const d = p?.description_long ?? p?.description_short ?? p?.description ?? null;
  if (typeof d !== 'string') return null;
  const t = d.trim();
  if (!t) return null;
  if (/<[a-z][\s\S]*>/i.test(t)) return t;
  return `<p>${t.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
}

function pickPrice(p) {
  return (
    p?.asking_price ||
    p?.per_item_price ||
    p?.price_details?.product_price ||
    p?.price_details?.total_price ||
    p?.total_price ||
    0
  );
}

/** Square price_money.amount is an integer in the currency's smallest unit. */
function toCents(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x < 0) return 0;
  return Math.round(x * 100);
}

/**
 * Square requires an ISO 4217 code in price_money.currency. OFA rows carry a
 * `monetary_format` field, but it sometimes holds a unit like "ea" instead of a
 * currency — only trust it when it looks like a real 3-letter code.
 */
function pickCurrency(p, fallback) {
  const c = String(p?.monetary_format || '')
    .trim()
    .toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : fallback;
}

function pickQty(p) {
  const q = Number(p?.quantity_in_stock ?? p?.quantity ?? p?.inventory_quantity ?? 0);
  if (Number.isFinite(q) && q >= 0) return Math.round(q);
  return 0;
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

/** Same idea as Wix/Squarespace: label each variant row for the option picker. */
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

function truncateVariationName(s) {
  return String(s || '')
    .trim()
    .slice(0, MAX_SQUARE_VARIATION_NAME_LEN);
}

/** Ensure variation names are unique within the item (Square rejects duplicates). */
function uniqueVariationLabels(items, labelFn) {
  const used = new Set();
  const out = [];
  for (let i = 0; i < items.length; i++) {
    let label = String(labelFn(items[i]) || '').trim();
    if (!label) label = normalizeSku(items[i]?.sku) || `Option ${i + 1}`;

    let candidate = truncateVariationName(label);
    let n = 2;
    while (used.has(candidate)) {
      const suffix = ` (${n})`;
      const maxBase = MAX_SQUARE_VARIATION_NAME_LEN - suffix.length;
      candidate = truncateVariationName(`${label.slice(0, Math.max(1, maxBase))}${suffix}`);
      n++;
    }
    used.add(candidate);
    out.push(candidate);
  }
  return out;
}

/**
 * Order-preserving jobs: items without `image_guid` are each a separate product;
 * items sharing the same `image_guid` are one product with multiple variants
 * (same logic as the Wix/Squarespace sync).
 */
function isAlreadyOnSquare(p) {
  const tpi = p?.third_party_integrations;
  // square_item_id is the legacy field name from early exports.
  return !!(tpi && (tpi.square_product_id || tpi.square_item_id));
}

function buildSyncJobs(rawProducts) {
  const processedGuid = new Set();
  const jobs = [];
  for (const p of rawProducts) {
    // Already exported to Square once — do not create a duplicate item.
    if (isAlreadyOnSquare(p)) {
      continue;
    }
    const g = String(p?.image_guid || '').trim();
    if (!g) {
      jobs.push({ kind: 'single', items: [p] });
      continue;
    }
    if (processedGuid.has(g)) continue;
    processedGuid.add(g);
    const items = rawProducts.filter(
      (q) => String(q?.image_guid || '').trim() === g && !isAlreadyOnSquare(q)
    );
    if (!items.length) continue;
    if (items.length <= 1) {
      jobs.push({ kind: 'single', items, image_guid: g });
    } else {
      jobs.push({ kind: 'variants', items, image_guid: g });
    }
  }
  return jobs;
}

function summarizeSquareHttpError(r) {
  const payload = {};
  const d = r?.data;
  if (typeof d === 'string' && d.trim()) {
    const raw = d.trim();
    payload.rawBody = raw.slice(0, 2000);
    payload.message = raw.slice(0, 500);
  } else if (d && typeof d === 'object') {
    Object.assign(payload, d);
    if (Array.isArray(d.errors) && d.errors.length && !payload.message) {
      payload.message = d.errors
        .map((e) => [e?.code, e?.detail].filter(Boolean).join(': '))
        .filter(Boolean)
        .join(' | ')
        .slice(0, 500);
    }
  }
  if (r?.status != null) payload.httpStatus = r.status;
  if (r?.statusText) payload.httpStatusText = r.statusText;
  return payload;
}

function buildSquareHeaders(accessToken) {
  return {
    Authorization: `Bearer ${String(accessToken).trim()}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...squareApiVersionHeader(),
  };
}

function isExpiringSoon(expires_at) {
  if (!expires_at) return false;
  const t = Date.parse(expires_at);
  if (!Number.isFinite(t)) return false;
  // Refresh proactively when less than 5 minutes of validity remain.
  return Date.now() + 5 * 60_000 >= t;
}

/** Best-effort mirror of refreshed tokens into the square-accounts DynamoDB row. */
async function syncSquareTokensToDynamo(account_key, tokenData, fallbackRefreshToken) {
  try {
    await putSquareAccount({
      id: crypto.randomUUID(),
      account_key,
      merchant_id: tokenData.merchant_id || null,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || fallbackRefreshToken || null,
      expires_at: tokenData.expires_at ?? null,
      token_type: tokenData.token_type ?? null,
      needs_reauth: false,
    });
  } catch (dynamoErr) {
    log('syncSquareTokensToDynamo failed', { account_key, message: dynamoErr?.message });
  }
}

/**
 * Resolve Square access token: request override first, otherwise the FinerWorks
 * `connections` Square entry (refreshing proactively when the token is near expiry).
 */
async function resolveSquareAuth({ account_key, access_token }) {
  if (access_token && String(access_token).trim()) {
    return {
      accessToken: String(access_token).trim(),
      refreshToken: null,
      source: 'request',
    };
  }

  if (!account_key || !String(account_key).trim()) return null;

  const snap = await getFinerworksSquareOAuthSnapshot(String(account_key).trim());
  if (!snap || !snap.access_token) return null;

  if (snap.refresh_token && isExpiringSoon(snap.expires_at)) {
    try {
      const tokenData = await refreshSquareTokensCore(account_key, snap.refresh_token);
      await syncSquareTokensToDynamo(account_key, tokenData, snap.refresh_token);
      return {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || snap.refresh_token,
        source: 'connections_refresh',
      };
    } catch (refreshErr) {
      log('proactive Square token refresh failed; falling back to stored token', {
        account_key,
        message: refreshErr?.message,
      });
    }
  }

  return {
    accessToken: snap.access_token,
    refreshToken: snap.refresh_token || null,
    source: 'connections',
  };
}

/**
 * Build the UpsertCatalogObject request for one job. Each job becomes one Square
 * ITEM; each source row becomes one ITEM_VARIATION carrying its own SKU + price.
 */
function buildCatalogUpsertBody({ items, currency }) {
  const first = items[0];
  const name = pickName(first).slice(0, MAX_SQUARE_ITEM_NAME_LEN);
  const descHtml = pickDescriptionHtml(first);
  const multiVariant = items.length > 1;
  const labels = multiVariant ? uniqueVariationLabels(items, buildVariantLabel) : null;

  const variations = items.map((p, idx) => {
    const sku = normalizeSku(p?.sku);
    return {
      type: 'ITEM_VARIATION',
      id: `#variation-${idx}`,
      present_at_all_locations: true,
      item_variation_data: {
        item_id: '#item',
        name: multiVariant ? labels[idx] : 'Regular',
        ...(sku ? { sku } : {}),
        pricing_type: 'FIXED_PRICING',
        price_money: { amount: toCents(pickPrice(p)), currency: pickCurrency(p, currency) },
        track_inventory: true,
        sellable: true,
        stockable: true,
      },
    };
  });

  return {
    idempotency_key: crypto.randomUUID(),
    object: {
      type: 'ITEM',
      id: '#item',
      present_at_all_locations: true,
      item_data: {
        name,
        ...(descHtml ? { description_html: descHtml } : {}),
        product_type: 'REGULAR',
        variations,
      },
    },
  };
}

/** Map temp client ids (#item / #variation-N) to the real catalog object ids. */
function extractIdMappings(responseData) {
  const map = new Map();
  const mappings = Array.isArray(responseData?.id_mappings) ? responseData.id_mappings : [];
  for (const m of mappings) {
    if (m?.client_object_id && m?.object_id) map.set(m.client_object_id, m.object_id);
  }
  // Fallback: read ids straight off the returned catalog_object tree.
  const obj = responseData?.catalog_object;
  if (obj?.id && !map.has('#item')) map.set('#item', obj.id);
  const vars = obj?.item_data?.variations || [];
  vars.forEach((v, idx) => {
    const key = `#variation-${idx}`;
    if (v?.id && !map.has(key)) map.set(key, v.id);
  });
  return map;
}

/**
 * Set starting stock for each variation via PHYSICAL_COUNT at the resolved location.
 * Quantities are strings per the Inventory API contract.
 */
async function setInventoryCounts({ baseUrl, headers, locationId, counts }) {
  if (!locationId || !counts.length) return { ok: true, skipped: !locationId };
  const occurredAt = new Date().toISOString();
  const body = {
    idempotency_key: crypto.randomUUID(),
    changes: counts.map(({ variationId, quantity }) => ({
      type: 'PHYSICAL_COUNT',
      physical_count: {
        catalog_object_id: variationId,
        state: 'IN_STOCK',
        location_id: locationId,
        quantity: String(Math.max(0, Math.round(Number(quantity) || 0))),
        occurred_at: occurredAt,
      },
    })),
  };
  const r = await axios.post(`${baseUrl}/v2/inventory/changes/batch-create`, body, {
    headers,
    timeout: 60000,
    validateStatus: () => true,
  });
  if (r.status < 200 || r.status >= 300) {
    return { ok: false, error: summarizeSquareHttpError(r) };
  }
  return { ok: true };
}

/**
 * Upload one image URL to the Square catalog and attach it to the item.
 * Multipart: `request` JSON part + `image_file` binary part.
 */
async function uploadImageToSquareItem({ baseUrl, headers, itemId, imageUrl, isPrimary, name }) {
  const dl = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 120000,
    validateStatus: (s) => s >= 200 && s < 300,
  });

  const requestJson = {
    idempotency_key: crypto.randomUUID(),
    object_id: itemId,
    image: {
      type: 'IMAGE',
      id: '#image',
      image_data: {
        name: String(name || 'Product image').slice(0, 255),
      },
    },
    is_primary: !!isPrimary,
  };

  const form = new FormData();
  form.append('request', JSON.stringify(requestJson), { contentType: 'application/json' });
  form.append('image_file', Buffer.from(dl.data), {
    filename: 'image.jpg',
    contentType: dl.headers?.['content-type'] || 'image/jpeg',
  });

  const up = await axios.post(`${baseUrl}/v2/catalog/images`, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: headers.Authorization,
      ...squareApiVersionHeader(),
    },
    timeout: 120000,
    validateStatus: () => true,
  });
  if (up.status < 200 || up.status >= 300) {
    return { ok: false, error: summarizeSquareHttpError(up) };
  }
  return { ok: true, imageId: up?.data?.image?.id || null };
}

async function uploadJobImages({ baseUrl, headers, itemId, items }) {
  const urls = [];
  for (const src of items) {
    for (const u of pickImageUrls(src)) {
      if (!urls.includes(u)) urls.push(u);
    }
  }
  const uploads = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const r = await uploadImageToSquareItem({
        baseUrl,
        headers,
        itemId,
        imageUrl: urls[i],
        isPrimary: i === 0,
        name: pickName(items[0]),
      });
      uploads.push({ url: urls[i], ...r });
    } catch (imgErr) {
      uploads.push({ url: urls[i], ok: false, error: imgErr?.message || 'Image upload failed' });
    }
  }
  return uploads;
}

/**
 * Write the Square ids back into FinerWorks virtual inventory per SKU so the item
 * is never exported twice and order sync can map Square line items back to OFA.
 */
async function updateVirtualInventoryWithSquareIds(accountKey, items, itemId, variationIdBySku) {
  const virtualInventoryUpdates = [];
  const virtualInventoryUpdateErrors = [];

  if (!itemId || !accountKey || !String(accountKey).trim()) {
    return { virtualInventoryUpdates, virtualInventoryUpdateErrors };
  }

  for (const src of items) {
    const srcSku = normalizeSku(src?.sku);
    if (!srcSku) continue;

    const variationId = variationIdBySku.get(srcSku) || null;
    const viItem = {
      sku: srcSku,
      asking_price:
        src?.asking_price ??
        src?.per_item_price ??
        src?.price_details?.product_price ??
        src?.total_price ??
        0,
      name: pickName(src),
      description: src?.description_long ?? src?.description_short ?? '',
      quantity_in_stock: pickQty(src),
      track_inventory: true,
      third_party_integrations: {
        ...(src?.third_party_integrations || {}),
        square_product_id: String(itemId),
        ...(variationId ? { square_variant_id: String(variationId) } : {}),
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

/**
 * Sync products from the OFA payload to the Square catalog.
 *
 * Mirrors Wix/Squarespace:
 * - `productList` / `productsList` in body (same shapes as elsewhere)
 * - `account_key` from body or query; optional `access_token` override
 * - Rows sharing the same `image_guid` export as **one Square item** with multiple
 *   variations; rows without `image_guid` export as single-variation items
 * - Each variation carries its SKU and price; quantities are pushed to the Square
 *   Inventory API at the resolved location (`location_id` override supported)
 * - Square ids are written back to FinerWorks virtual inventory
 *   (`third_party_integrations.square_product_id` / `square_variant_id`)
 */
const syncSquareProducts = async (req, res) => {
  try {
    const account_key =
      req.body?.account_key ||
      req.body?.accountKey ||
      req.query?.account_key ||
      req.query?.accountKey;

    const rawProducts =
      (Array.isArray(req.body?.productList) ? req.body.productList : null) ||
      (Array.isArray(req.body?.productsList) ? req.body.productsList : []);

    const currency = String(req.body?.currency || 'USD')
      .trim()
      .toUpperCase();

    const access_token =
      req.query?.access_token || req.body?.access_token || req.headers['x-square-access-token'];

    const explicitLocationId = req.body?.location_id || req.body?.locationId || null;

    if (!account_key || !String(account_key).trim()) {
      return sendApiError(res, 400, 'account_key is required');
    }
    if (!Array.isArray(rawProducts) || !rawProducts.length) {
      return sendApiError(res, 400, 'productList / productsList must be a non-empty array');
    }

    let squareAuth = await resolveSquareAuth({ account_key, access_token });
    if (!squareAuth) {
      return sendApiError(
        res,
        400,
        'Missing Square auth. Connect Square for this account or provide access_token in the request.'
      );
    }

    const baseUrl = getSquareBaseUrl();
    let headers = buildSquareHeaders(squareAuth.accessToken);

    const jobs = buildSyncJobs(rawProducts);
    if (!jobs.length) {
      return res.status(200).json({
        success: true,
        message: 'Nothing to sync (all products are already linked to Square)',
        created: 0,
        failed: 0,
        jobCount: 0,
        results: [],
      });
    }

    // One retry with a refreshed token if Square rejects the stored access token.
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
          log('mid-sync Square token refresh failed', {
            account_key,
            message: refreshErr?.message,
          });
        }
      }
      return r;
    };

    let locationId = null;
    let locationError = null;
    try {
      const locResp = await withAuthRetry((h) =>
        axios.get(`${baseUrl}/v2/locations`, { headers: h, timeout: 30000, validateStatus: () => true })
      );
      if (locResp.status >= 200 && locResp.status < 300) {
        const locations = Array.isArray(locResp?.data?.locations) ? locResp.data.locations : [];
        if (explicitLocationId) {
          locationId =
            locations.find((l) => String(l?.id || '') === String(explicitLocationId).trim())?.id ||
            null;
          if (!locationId) {
            return sendApiError(res, 400, `Square location_id ${explicitLocationId} not found`);
          }
        } else {
          const preferred = locations.find((l) => l?.status === 'ACTIVE') || locations[0] || null;
          locationId = preferred?.id || null;
        }
      } else {
        locationError = summarizeSquareHttpError(locResp);
      }
    } catch (locErr) {
      locationError = { message: locErr?.message || 'Failed to list Square locations' };
    }

    const results = [];
    let created = 0;
    let failed = 0;

    for (let ji = 0; ji < jobs.length; ji++) {
      const job = jobs[ji];
      const items = job.items;
      const guid = job.image_guid || null;
      const skuPreview = normalizeSku(items[0]?.sku);

      try {
        const body = buildCatalogUpsertBody({ items, currency });

        const r = await withAuthRetry((h) =>
          axios.post(`${baseUrl}/v2/catalog/object`, body, {
            headers: h,
            timeout: 60000,
            validateStatus: () => true,
          })
        );

        if (r.status >= 200 && r.status < 300) {
          created += 1;
          const idMap = extractIdMappings(r.data);
          const squareItemId = idMap.get('#item') || null;

          const variationIdBySku = new Map();
          const inventoryCounts = [];
          items.forEach((src, idx) => {
            const sku = normalizeSku(src?.sku);
            const variationId = idMap.get(`#variation-${idx}`) || null;
            if (sku && variationId) variationIdBySku.set(sku, variationId);
            if (variationId) {
              inventoryCounts.push({ variationId, quantity: pickQty(src) });
            }
          });

          const resultEntry = {
            success: true,
            jobIndex: ji,
            ...(guid ? { image_guid: guid } : {}),
            variantCount: items.length,
            sku: skuPreview,
            squareItemId,
            squareVariationIds: Object.fromEntries(variationIdBySku),
          };

          // Push starting quantities to the Inventory API (non-fatal on failure).
          if (locationId) {
            const inv = await setInventoryCounts({
              baseUrl,
              headers,
              locationId,
              counts: inventoryCounts,
            });
            if (!inv.ok) resultEntry.inventoryError = inv.error;
          } else {
            resultEntry.inventorySkipped =
              'No Square location available; quantities were not pushed';
            if (locationError) resultEntry.locationError = locationError;
          }

          // Attach product images to the Square item (non-fatal on failure).
          if (squareItemId) {
            const imageUploads = await uploadJobImages({ baseUrl, headers, itemId: squareItemId, items });
            if (imageUploads.length) resultEntry.imageUploads = imageUploads;
          }

          // Write Square ids back into FinerWorks virtual inventory per SKU.
          if (squareItemId) {
            const viResult = await updateVirtualInventoryWithSquareIds(
              account_key,
              items,
              squareItemId,
              variationIdBySku
            );
            if (viResult.virtualInventoryUpdates.length) {
              resultEntry.virtualInventoryUpdates = viResult.virtualInventoryUpdates;
            }
            if (viResult.virtualInventoryUpdateErrors.length) {
              resultEntry.virtualInventoryUpdateErrors = viResult.virtualInventoryUpdateErrors;
            }
          }

          results.push(resultEntry);
        } else {
          failed += 1;
          results.push({
            success: false,
            jobIndex: ji,
            ...(guid ? { image_guid: guid } : {}),
            sku: skuPreview,
            status: r.status,
            squareError: summarizeSquareHttpError(r),
          });
        }
      } catch (err) {
        failed += 1;
        results.push({
          success: false,
          jobIndex: ji,
          ...(guid ? { image_guid: guid } : {}),
          sku: skuPreview,
          error: err?.response?.data || err?.message || 'Unknown error',
        });
      }
    }

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'square',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'syncSquareProducts',
      operation: 'Square products sync completed',
      account_key: String(account_key).trim(),
      result: { created, failed, jobCount: jobs.length, locationId, success: failed === 0 },
      timestamp: new Date().toISOString(),
    });
    console.log(successLog);
    log('Success in syncSquareProducts: %s', successLog);

    return res.status(200).json({
      success: failed === 0,
      squareAuthSource: squareAuth.source,
      squareLocationId: locationId,
      ...(locationError ? { locationError } : {}),
      created,
      failed,
      jobCount: jobs.length,
      results,
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
      source: isSquareError ? 'square_api' : isFinerworksError ? 'finerworks_api' : 'lambda',
      function: 'syncSquareProducts',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to sync Square products: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.errors?.[0]?.detail || null,
      timestamp: new Date().toISOString(),
    });
    console.error(errorJson);
    log('Formatted error in syncSquareProducts: %s', errorJson);
    return sendApiError(res, err);
  }
};

module.exports = {
  syncSquareProducts,
  buildSyncJobs,
  buildCatalogUpsertBody,
  extractIdMappings,
  // Shared Square helpers (used by square-orders)
  resolveSquareAuth,
  buildSquareHeaders,
  summarizeSquareHttpError,
  syncSquareTokensToDynamo,
};
