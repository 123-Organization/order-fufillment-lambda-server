const axios = require('axios');
const FormData = require('form-data');
const finerworksService = require('../helpers/finerworks-service');
const { sendApiError } = require('../helpers/api-error');
const {
  getTiktokConnection,
  refreshTiktokTokenCore,
  isTiktokTokenExpiringSoon,
  generateTiktokSign,
  getTiktokAppKey,
  getTiktokAppSecret,
  TIKTOK_API_BASE,
} = require('./tiktok-auth');
const debug = require('debug');
const log = debug('app:tiktokProducts');

/**
 * TikTok Shop Product API — paths/shapes confirmed directly from TikTok's own official sample
 * server (github.com/tiktok/ttspc-server-sample, src/services/ttsApi.ts). Category assignment
 * is mandatory on every product, so this auto-recommends one from the product's own
 * title/description/images (POST .../categories/recommend) rather than requiring a manual
 * category mapping step — takes the top recommendation.
 */

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

function pickDescription(p) {
  const d = p?.description_long ?? p?.description_short ?? p?.description ?? null;
  if (typeof d !== 'string') return null;
  const t = d.trim();
  return t || null;
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

/** Same grouping convention as Square/Wix/Squarespace: rows sharing image_guid are one
 * product with multiple SKUs; rows without image_guid are each a single-SKU product. */
function isAlreadyOnTiktok(p) {
  return !!p?.third_party_integrations?.tiktok_product_id;
}

function buildSyncJobs(rawProducts) {
  const processedGuid = new Set();
  const jobs = [];
  for (const p of rawProducts) {
    if (isAlreadyOnTiktok(p)) continue;
    const g = String(p?.image_guid || '').trim();
    if (!g) {
      jobs.push({ kind: 'single', items: [p] });
      continue;
    }
    if (processedGuid.has(g)) continue;
    processedGuid.add(g);
    const items = rawProducts.filter(
      (q) => String(q?.image_guid || '').trim() === g && !isAlreadyOnTiktok(q)
    );
    if (!items.length) continue;
    jobs.push({ kind: items.length > 1 ? 'variants' : 'single', items, image_guid: g });
  }
  return jobs;
}

function summarizeTiktokHttpError(err) {
  const data = err?.response?.data;
  if (!data) return { message: err?.message || 'Unknown error' };
  return {
    code: data.code,
    message: data.message || err?.message || 'Unknown error',
    request_id: data.request_id,
    httpStatus: err?.response?.status,
  };
}

/** Signed call to a TikTok Open API path that needs shop_cipher — shared by every function below. */
async function tiktokShopCall({ method, path, accessToken, shopCipher, extraParams = {}, body = null, formData = null }) {
  const appKey = getTiktokAppKey();
  const appSecret = getTiktokAppSecret();
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { app_key: appKey, timestamp, shop_cipher: shopCipher, ...extraParams };
  const headers = formData
    ? { 'content-type': 'multipart/form-data' }
    : { 'content-type': 'application/json' };
  const sign = generateTiktokSign({ path, params, headers, body: formData ? null : body, appSecret });

  return axios({
    method,
    url: `${TIKTOK_API_BASE}${path}`,
    params: { ...params, sign },
    data: formData || body || undefined,
    headers: {
      'x-tts-access-token': accessToken,
      ...(formData ? formData.getHeaders() : { 'Content-Type': 'application/json' }),
    },
    timeout: 60000,
    validateStatus: () => true,
  });
}

/**
 * Resolves the TikTok credentials + shop to sync against for an account_key: the stored
 * connection's access_token (refreshed proactively if near expiry, same pattern as Square),
 * and either the single authorized shop or a caller-specified shop_cipher/shop_id when the
 * account has more than one.
 */
async function resolveTiktokShopAuth({ account_key, shop_cipher, shop_id }) {
  if (!account_key || !String(account_key).trim()) {
    const err = new Error('account_key is required');
    err.status = 400;
    throw err;
  }
  const trimmedKey = String(account_key).trim();
  let conn = await getTiktokConnection(trimmedKey);
  if (!conn) {
    const err = new Error('No TikTok Shop connection found for this account. Connect via GET /tiktok/auth first.');
    err.status = 400;
    throw err;
  }

  // Proactive refresh, mirroring resolveSquareAuth's isExpiringSoon check.
  if (isTiktokTokenExpiringSoon(conn.access_token_expires_at) && conn.refresh_token) {
    try {
      await refreshTiktokTokenCore(trimmedKey, conn);
      conn = await getTiktokConnection(trimmedKey);
    } catch (refreshErr) {
      log('resolveTiktokShopAuth: proactive refresh failed, continuing with existing token: %s', refreshErr?.message);
    }
  }

  const shops = Array.isArray(conn.shops) ? conn.shops : [];
  let shop = null;
  if (shop_cipher) {
    shop = shops.find((s) => s.cipher === shop_cipher) || { cipher: shop_cipher, id: shop_id || null };
  } else if (shop_id) {
    shop = shops.find((s) => String(s.id) === String(shop_id)) || null;
  } else if (shops.length === 1) {
    shop = shops[0];
  } else if (shops.length > 1) {
    const err = new Error(
      `This account has ${shops.length} authorized TikTok Shops; specify shop_cipher to pick one.`
    );
    err.status = 400;
    err.data = { shops: shops.map((s) => ({ id: s.id, name: s.name, cipher: s.cipher })) };
    throw err;
  }
  if (!shop?.cipher) {
    const err = new Error('No authorized TikTok Shop found for this account.');
    err.status = 400;
    throw err;
  }

  return { accessToken: conn.access_token, shopCipher: shop.cipher, shop };
}

async function getWarehouseId({ accessToken, shopCipher }) {
  const r = await tiktokShopCall({ method: 'GET', path: '/logistics/202309/warehouses', accessToken, shopCipher });
  if (r.status < 200 || r.status >= 300 || r.data?.code !== 0) return null;
  const warehouses = r.data?.data?.warehouses || [];
  // Prefer the default warehouse when the account has more than one.
  return warehouses.find((w) => w?.is_default)?.id || warehouses[0]?.id || null;
}

async function recommendCategoryId({ accessToken, shopCipher, title, description, imageUris }) {
  const r = await tiktokShopCall({
    method: 'POST',
    path: '/product/202309/categories/recommend',
    accessToken,
    shopCipher,
    body: {
      product_title: title,
      ...(description ? { product_description: description } : {}),
      ...(imageUris?.length ? { product_image_uris: imageUris } : {}),
      category_version: 'v2',
    },
  });
  if (r.status < 200 || r.status >= 300 || r.data?.code !== 0) {
    return { categoryId: null, error: summarizeTiktokHttpError({ response: r }) };
  }
  const top = r.data?.data?.categories?.[0] || null;
  return { categoryId: top?.id || null, category: top };
}

/** Downloads an image from its FinerWorks URL and uploads it to TikTok's media API, returning
 * the TikTok-hosted `uri` that product/SKU image fields reference — TikTok doesn't fetch
 * images by URL itself (unlike BigCommerce), same constraint Square's image upload has. */
async function uploadImageToTiktok({ accessToken, imageUrl }) {
  const dl = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 60000 });
  const form = new FormData();
  form.append('data', Buffer.from(dl.data), { filename: 'image.jpg' });
  form.append('use_case', 'MAIN_IMAGE');

  const appKey = getTiktokAppKey();
  const appSecret = getTiktokAppSecret();
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { app_key: appKey, timestamp };
  const sign = generateTiktokSign({
    path: '/product/202309/images/upload',
    params,
    headers: { 'content-type': 'multipart/form-data' },
    body: null,
    appSecret,
  });

  const r = await axios.post(`${TIKTOK_API_BASE}/product/202309/images/upload`, form, {
    params: { ...params, sign },
    headers: { 'x-tts-access-token': accessToken, ...form.getHeaders() },
    timeout: 60000,
    validateStatus: () => true,
  });
  if (r.status < 200 || r.status >= 300 || r.data?.code !== 0) {
    throw Object.assign(new Error('TikTok image upload failed'), { response: r });
  }
  return r.data?.data?.uri || null;
}

/** Writes TikTok ids back into FinerWorks virtual inventory per SKU, same convention as the
 * other platforms' `third_party_integrations.<platform>_product_id` fields. */
async function updateVirtualInventoryWithTiktokIds(accountKey, items, productId, skuIdBySeller) {
  const updates = [];
  const errors = [];
  for (const src of items) {
    const sku = normalizeSku(src?.sku);
    if (!sku) continue;
    const tiktokSkuId = skuIdBySeller.get(sku) || null;
    const viItem = {
      sku,
      asking_price: pickPrice(src),
      name: pickName(src),
      description: pickDescription(src) || '',
      quantity_in_stock: pickQty(src),
      track_inventory: true,
      third_party_integrations: {
        ...(src?.third_party_integrations || {}),
        tiktok_product_id: String(productId),
        ...(tiktokSkuId ? { tiktok_sku_id: String(tiktokSkuId) } : {}),
      },
    };
    try {
      const result = await finerworksService.UPDATE_VIRTUAL_INVENTORY({
        virtual_inventory: [viItem],
        account_key: String(accountKey).trim(),
      });
      updates.push({ sku, result });
    } catch (e) {
      errors.push({ sku, error: e?.message || 'Unknown virtual inventory update error' });
    }
  }
  return { updates, errors };
}

/**
 * Sync products from the OFA payload to the TikTok Shop catalog.
 *
 * Mirrors Square/Wix/Squarespace: `productList`/`productsList` in body, `account_key`
 * required, rows sharing `image_guid` export as one product with multiple SKUs. TikTok-specific
 * steps this adds: auto-recommending a category (mandatory on every product), uploading images
 * to TikTok's media API first (TikTok doesn't fetch by URL), and resolving a warehouse_id for
 * SKU inventory. TikTok ids are written back to FinerWorks virtual inventory
 * (`third_party_integrations.tiktok_product_id` / `tiktok_sku_id`).
 */
const syncTiktokProducts = async (req, res) => {
  try {
    const account_key = req.body?.account_key || req.query?.account_key;
    const shop_cipher = req.body?.shop_cipher || req.query?.shop_cipher;
    const shop_id = req.body?.shop_id || req.query?.shop_id;
    const rawProducts =
      (Array.isArray(req.body?.productList) ? req.body.productList : null) ||
      (Array.isArray(req.body?.productsList) ? req.body.productsList : []);

    if (!Array.isArray(rawProducts) || !rawProducts.length) {
      return sendApiError(res, 400, 'productList / productsList must be a non-empty array');
    }

    const { accessToken, shopCipher } = await resolveTiktokShopAuth({ account_key, shop_cipher, shop_id });
    const warehouseId = await getWarehouseId({ accessToken, shopCipher });
    if (!warehouseId) {
      return sendApiError(res, 400, 'No TikTok Shop warehouse found for this shop; set one up in Seller Center first.');
    }

    const jobs = buildSyncJobs(rawProducts);
    if (!jobs.length) {
      return res.status(200).json({
        success: true,
        message: 'Nothing to sync (all products are already linked to TikTok Shop)',
        created: 0,
        failed: 0,
        jobCount: 0,
        results: [],
      });
    }

    const results = [];
    let created = 0;
    let failed = 0;

    for (let ji = 0; ji < jobs.length; ji++) {
      const job = jobs[ji];
      const items = job.items;
      const guid = job.image_guid || null;
      const skuPreview = normalizeSku(items[0]?.sku);
      const name = pickName(items[0]);

      try {
        const imageUrls = [...new Set(items.flatMap((it) => pickImageUrls(it)))];
        if (!imageUrls.length) {
          failed += 1;
          results.push({ success: false, jobIndex: ji, ...(guid ? { image_guid: guid } : {}), sku: skuPreview, error: 'No image_url_1..5 found; TikTok requires at least one product image' });
          continue;
        }

        const uploadedUris = [];
        for (const u of imageUrls) {
          try {
            const uri = await uploadImageToTiktok({ accessToken, imageUrl: u });
            if (uri) uploadedUris.push(uri);
          } catch (imgErr) {
            log('syncTiktokProducts: image upload failed for %s: %s', u, imgErr?.message);
          }
        }
        if (!uploadedUris.length) {
          failed += 1;
          results.push({ success: false, jobIndex: ji, ...(guid ? { image_guid: guid } : {}), sku: skuPreview, error: 'All image uploads to TikTok failed' });
          continue;
        }

        const { categoryId, category, error: catError } = await recommendCategoryId({
          accessToken,
          shopCipher,
          title: name,
          description: pickDescription(items[0]),
          imageUris: uploadedUris,
        });
        if (!categoryId) {
          failed += 1;
          results.push({ success: false, jobIndex: ji, ...(guid ? { image_guid: guid } : {}), sku: skuPreview, error: 'Could not resolve a TikTok category', detail: catError });
          continue;
        }

        const skus = items.map((it) => ({
          seller_sku: normalizeSku(it.sku) || undefined,
          price: { amount: String(pickPrice(it)), currency: req.body?.currency || 'USD' },
          inventory: [{ warehouse_id: warehouseId, quantity: pickQty(it) }],
          ...(items.length > 1
            ? {
              sales_attributes: [
                {
                  name: 'Configuration',
                  value_name: normalizeSku(it.sku) || `Option ${items.indexOf(it) + 1}`,
                  sku_img: { uri: uploadedUris[0] },
                },
              ],
            }
            : {}),
        }));

        const createResp = await tiktokShopCall({
          method: 'POST',
          path: '/product/202309/products',
          accessToken,
          shopCipher,
          body: {
            title: name.slice(0, 255),
            description: pickDescription(items[0]) || name,
            category_id: categoryId,
            main_images: [{ uri: uploadedUris[0] }],
            skus,
          },
        });

        if (createResp.status >= 200 && createResp.status < 300 && createResp.data?.code === 0) {
          created += 1;
          const data = createResp.data.data;
          const productId = data?.product_id || null;
          const skuIdBySeller = new Map();
          for (const s of data?.skus || []) {
            if (s?.seller_sku && s?.id) skuIdBySeller.set(s.seller_sku, s.id);
          }

          const resultEntry = {
            success: true,
            jobIndex: ji,
            ...(guid ? { image_guid: guid } : {}),
            variantCount: items.length,
            sku: skuPreview,
            tiktokProductId: productId,
            tiktokCategoryId: categoryId,
            tiktokCategoryName: category?.local_display_name || category?.name || null,
          };

          if (productId) {
            const viResult = await updateVirtualInventoryWithTiktokIds(account_key, items, productId, skuIdBySeller);
            if (viResult.updates.length) resultEntry.virtualInventoryUpdates = viResult.updates;
            if (viResult.errors.length) resultEntry.virtualInventoryUpdateErrors = viResult.errors;
          }

          results.push(resultEntry);
        } else {
          failed += 1;
          results.push({
            success: false,
            jobIndex: ji,
            ...(guid ? { image_guid: guid } : {}),
            sku: skuPreview,
            status: createResp.status,
            tiktokError: summarizeTiktokHttpError({ response: createResp }),
          });
        }
      } catch (err) {
        failed += 1;
        results.push({
          success: false,
          jobIndex: ji,
          ...(guid ? { image_guid: guid } : {}),
          sku: skuPreview,
          error: summarizeTiktokHttpError(err),
        });
      }
    }

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'tiktok',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'syncTiktokProducts',
      operation: 'TikTok Shop products sync completed',
      account_key: String(account_key).trim(),
      result: { created, failed, jobCount: jobs.length, shopCipher, success: failed === 0 },
      timestamp: new Date().toISOString(),
    });
    console.log(successLog);
    log('Success in syncTiktokProducts: %s', successLog);

    return res.status(200).json({
      success: failed === 0,
      shopCipher,
      warehouseId,
      created,
      failed,
      jobCount: jobs.length,
      results,
    });
  } catch (err) {
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'tiktok',
      source: err?.response ? 'tiktok_api' : 'lambda',
      function: 'syncTiktokProducts',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || err?.status || null,
      message: `Failed to sync TikTok Shop products: ${err?.message || 'Unknown error'}`,
      detail: err?.data || summarizeTiktokHttpError(err),
      timestamp: new Date().toISOString(),
    });
    console.error(errorJson);
    log('Formatted error in syncTiktokProducts: %s', errorJson);
    return sendApiError(res, err?.status || 500, err?.message || 'Unknown error', err?.data);
  }
};

module.exports = {
  syncTiktokProducts,
  buildSyncJobs,
  resolveTiktokShopAuth,
  tiktokShopCall,
  summarizeTiktokHttpError,
};
