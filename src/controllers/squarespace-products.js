const axios = require('axios');
const FormData = require('form-data');
const finerworksService = require('../helpers/finerworks-service');

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
  const d = product?.price_details?.debug?.Description || product?.price_details?.debug?.description || null;
  if (d && typeof d === 'object') {
    const parts = [d.Media || d.media, d.Style || d.style, d.Size || d.size]
      .map((x) => String(x || '').trim())
      .filter(Boolean);
    if (parts.length) return parts.join(' : ');
  }
  return normalizeSku(product?.sku) || 'Variant';
}

function getPrice(product) {
  return (
    product?.asking_price ||
    product?.per_item_price ||
    product?.price_details?.product_price ||
    product?.price_details?.total_price ||
    product?.total_price ||
    0
  );
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
    currency: String(currency || 'USD').trim().toUpperCase(),
    value: val.toFixed(2)
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

async function fetchStorePageId(headers, explicitStorePageId) {
  let cursor = null;
  const pages = [];
  for (let i = 0; i < 25; i++) {
    const url = cursor ? `${STORE_PAGES_URL}?cursor=${encodeURIComponent(cursor)}` : STORE_PAGES_URL;
    const r = await axios.get(url, { headers });
    const data = r?.data || {};
    pages.push(...(Array.isArray(data.storePages) ? data.storePages : []));
    const p = data.pagination || {};
    if (!p.hasNextPage || !p.nextPageCursor) break;
    cursor = p.nextPageCursor;
  }

  if (explicitStorePageId) {
    const found = pages.find((p) => String(p?.id || '').trim() === String(explicitStorePageId).trim());
    return found?.id ? String(found.id).trim() : null;
  }

  const preferred = pages.find((p) => p?.isEnabled) || pages[0] || null;
  return preferred?.id ? String(preferred.id).trim() : null;
}

async function uploadImageToProduct(productId, imageUrl, headers) {
  const dl = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 120000,
    validateStatus: (s) => s >= 200 && s < 300
  });
  const form = new FormData();
  form.append('file', Buffer.from(dl.data), { filename: 'image.jpg', contentType: 'image/jpeg' });
  const up = await axios.post(`${API_BASE}/products/${encodeURIComponent(productId)}/images`, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: headers.Authorization,
      'User-Agent': headers['User-Agent']
    },
    timeout: 120000,
    validateStatus: (s) => s === 200 || s === 201 || s === 202
  });
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
        'Content-Type': 'application/json'
      },
      timeout: 60000,
      validateStatus: () => true
    });
    if (r.status === 200 || r.status === 201 || r.status === 204) return true;
  }
  return false;
}

const syncSquarespaceProducts = async (req, res) => {
  try {
    const accessToken = req.body?.access_token || req.headers['x-squarespace-access-token'];
    const accountKey = req.body?.account_key || req.body?.accountKey;
    const siteId = req.body?.site_id ?? req.body?.siteId ?? process.env.FINERWORKS_SITE_ID ?? 2;
    const sessionId = req.body?.session_id || req.body?.sessionId || process.env.FINERWORKS_SESSION_ID || null;
    const currency = req.body?.currency || 'USD';
    const rawProducts = Array.isArray(req.body?.productsList) ? req.body.productsList : [];
    const explicitStorePageId = req.body?.storePageId || req.body?.store_page_id || null;

    if (!accessToken) return res.status(400).json({ success: false, message: 'access_token is required' });
    if (!accountKey || !String(accountKey).trim()) {
      return res.status(400).json({ success: false, message: 'account_key is required' });
    }
    if (!sessionId || !String(sessionId).trim()) {
      return res.status(400).json({ success: false, message: 'session_id is required' });
    }
    if (!rawProducts.length) {
      return res.status(400).json({ success: false, message: 'productsList must be a non-empty array' });
    }

    const uniqueImageGuids = [...new Set(rawProducts.map((p) => String(p?.image_guid || '').trim()).filter(Boolean))];

    const fwData = await finerworksService.LIST_IMAGES({
      library: {
        account_key: String(accountKey).trim(),
        site_id: Number(siteId),
        session_id: String(sessionId).trim()
      }
    });
    const allImages = extractImages(fwData);
    const guidSet = new Set(uniqueImageGuids);
    const matchedImages = allImages.filter((img) => guidSet.has(imageGuidFromImage(img)));
    const matchedByGuid = new Map();
    for (const img of matchedImages) {
      const g = imageGuidFromImage(img);
      if (g && !matchedByGuid.has(g)) matchedByGuid.set(g, img);
    }

    const productsByGuid = new Map();
    for (const p of rawProducts) {
      const g = String(p?.image_guid || '').trim();
      if (!g) continue;
      if (!productsByGuid.has(g)) productsByGuid.set(g, []);
      productsByGuid.get(g).push(p);
    }

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': process.env.SQUARESPACE_USER_AGENT || 'ofa-node'
    };
    const storePageId = await fetchStorePageId(headers, explicitStorePageId);
    if (!storePageId) {
      return res.status(400).json({ success: false, message: 'No valid Squarespace store page id found' });
    }

    const results = [];
    let mainProductsCreated = 0;
    let variantsAdded = 0;
    const unmatchedImageGuids = uniqueImageGuids.filter((g) => !matchedByGuid.has(g));

    for (const guid of uniqueImageGuids) {
      const srcVariants = productsByGuid.get(guid) || [];
      if (!srcVariants.length) continue;

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

      const variantRows = srcVariants
        .map((src) => {
          const sku = normalizeSku(src?.sku);
          if (!sku) return null;
          return {
            sku,
            pricing: { basePrice: buildBasePrice(currency, getPrice(src)) },
            attributes: { Configuration: buildVariantLabel(src) },
            stock: {
              quantity: Math.max(0, Math.round(Number(getQuantity(src) || 0))),
              unlimited: false
            }
          };
        })
        .filter(Boolean);

      if (!variantRows.length) {
        results.push({ success: false, image_guid: guid, error: 'No valid variants (missing SKU)' });
        continue;
      }

      try {
        const createPayload = {
          name: productName,
          description,
          type: 'PHYSICAL',
          isVisible: true,
          storePageId,
          urlSlug: slugify(`${productName}-${guid}`) || `product-${Date.now()}`,
          ...(variantRows.length > 1 ? { variantAttributes: ['Configuration'] } : {}),
          variants: variantRows
        };
        const createResp = await axios.post(`${API_BASE}/products`, createPayload, { headers });
        const productId = createResp?.data?.id || null;
        if (!productId) {
          results.push({ success: false, image_guid: guid, error: 'Squarespace product id missing in response' });
          continue;
        }
        mainProductsCreated += 1;
        variantsAdded += variantRows.length;

        // Upload main image from matchedImages.public_preview_uri first.
        const mainImageUrl = previewUrlFromMatchedImage(matched) || firstHttpUrlFromPayload(first);
        const uploadedByUrl = new Map();
        if (mainImageUrl) {
          try {
            const imageId = await uploadImageToProduct(productId, mainImageUrl, headers);
            if (imageId) uploadedByUrl.set(mainImageUrl, imageId);
          } catch (_) {
            // non-fatal
          }
        }

        // Upload each variant image URL once and associate by SKU.
        const variantImageUrlBySku = new Map();
        for (const src of srcVariants) {
          const sku = normalizeSku(src?.sku);
          const vUrl = firstHttpUrlFromPayload(src);
          if (sku && vUrl) variantImageUrlBySku.set(sku, vUrl);
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

        // Load product variants to map sku -> variantId.
        const variantIdBySku = new Map();
        try {
          const pr = await axios.get(`${API_BASE}/products/${encodeURIComponent(productId)}`, { headers });
          const sqVariants = Array.isArray(pr?.data?.variants) ? pr.data.variants : [];
          for (const v of sqVariants) {
            const sku = normalizeSku(v?.sku);
            if (sku) variantIdBySku.set(sku, v?.id || null);
          }
        } catch (_) {
          // non-fatal
        }

        const variantImageAssociations = [];
        for (const [sku, vUrl] of variantImageUrlBySku.entries()) {
          const variantId = variantIdBySku.get(sku);
          const imageId = uploadedByUrl.get(vUrl);
          if (!variantId || !imageId) continue;
          await waitImageReady(productId, imageId, headers);
          const ok = await associateVariantImage(productId, variantId, imageId, headers);
          variantImageAssociations.push({ sku, variantId, imageId, associated: ok });
        }

        results.push({
          success: true,
          image_guid: guid,
          squarespaceProductId: productId,
          variantCount: variantRows.length,
          variantImageAssociations
        });
      } catch (err) {
        const data = err?.response?.data;
        results.push({
          success: false,
          image_guid: guid,
          error:
            (typeof data?.message === 'string' && data.message) ||
            (typeof data?.error === 'string' && data.error) ||
            err?.message ||
            'Failed to create Squarespace product',
          ...(data && typeof data === 'object' ? { squarespaceError: data } : {})
        });
      }
    }

    return res.status(200).json({
      success: results.every((r) => r.success),
      uniqueImageGuidCount: uniqueImageGuids.length,
      uniqueImageGuids,
      totalImages: allImages.length,
      matchedImageCount: matchedImages.length,
      matchedImages,
      unmatchedImageGuidCount: unmatchedImageGuids.length,
      unmatchedImageGuids,
      mainProductsCreated,
      variantsAdded,
      results
    });
  } catch (err) {
    const status = err?.response?.status || 500;
    const data = err?.response?.data;
    return res.status(status).json({
      success: false,
      message: 'Failed to sync Squarespace products',
      error:
        (typeof data?.message === 'string' && data.message) ||
        (typeof data?.error === 'string' && data.error) ||
        err?.message ||
        'Unknown error',
      ...(data && typeof data === 'object' ? { details: data } : {})
    });
  }
};

module.exports = { syncSquarespaceProducts };
