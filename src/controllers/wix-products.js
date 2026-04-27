const axios = require('axios');
const finerworksService = require('../helpers/finerworks-service');

function normalizeSku(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function toAmountString(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '0';
  // Wix expects a string amount; keep it simple.
  return String(Math.round(x * 100) / 100);
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
  const d =
    p?.description_long ??
    p?.description_short ??
    p?.description ??
    null;
  if (typeof d !== 'string') return null;
  const t = d.trim();
  if (!t) return null;
  // Wix expects valid HTML when using plainDescription. Wrap raw text.
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

async function resolveWixAuth({ account_key, access_token, site_id }) {
  if (access_token && site_id) {
    return { apiKey: String(access_token).trim(), siteId: String(site_id).trim(), source: 'request' };
  }

  // Prefer tenant connection if available.
  if (account_key) {
    const info = await finerworksService.GET_INFO({ account_key: String(account_key).trim() });
    const connections = info?.user_account?.connections || [];
    const wixConn = Array.isArray(connections) ? connections.find((c) => c && c.name === 'Wix') : null;
    if (wixConn) {
      let data = {};
      try {
        data = typeof wixConn.data === 'string' ? JSON.parse(wixConn.data) : (wixConn.data || {});
      } catch (_) {
        data = {};
      }
      const apiKey = String(data?.access_token || wixConn.id || '').trim();
      const siteId = String(data?.site_id || '').trim();
      if (apiKey && siteId) return { apiKey, siteId, source: 'connections' };
    }
  }

  // Fallback to env.
  const apiKey = String(process.env.WIX_API_KEY || '').trim();
  const siteId = String(process.env.WIX_SITE_ID || '').trim();
  if (apiKey && siteId) return { apiKey, siteId, source: 'env' };

  return null;
}

/**
 * Sync products from Finerworks payload to Wix Stores Catalog V3.
 *
 * Mirrors existing pattern used by Shopify/Squarespace sync endpoints:
 * - Accepts `productsList` from caller
 * - Uses `account_key` to resolve stored Wix connection in `connections`
 *
 * Body:
 * - account_key (required)
 * - productsList (required array)
 * - currency (optional, default "USD")
 * - access_token (optional override; otherwise taken from connections/env)
 * - site_id (optional override; otherwise taken from connections/env)
 */
const syncWixProducts = async (req, res) => {
  try {
    const account_key =
      req.body?.account_key ||
      req.body?.accountKey ||
      req.query?.account_key ||
      req.query?.accountKey;

    const rawProducts = Array.isArray(req.body?.productsList) ? req.body.productsList : [];
    const currency = String(req.body?.currency || 'USD').trim().toUpperCase();

    if (!account_key || !String(account_key).trim()) {
      return res.status(400).json({ success: false, message: 'account_key is required' });
    }
    if (!rawProducts.length) {
      return res.status(400).json({ success: false, message: 'productsList must be a non-empty array' });
    }

    const wixAuth = await resolveWixAuth({
      account_key,
      access_token: req.body?.access_token || req.headers['x-wix-access-token'],
      site_id: req.body?.site_id || req.body?.siteId || req.headers['x-wix-site-id']
    });

    if (!wixAuth) {
      return res.status(400).json({
        success: false,
        message: 'Missing Wix auth. Connect Wix first or provide access_token + site_id.'
      });
    }

    const headers = {
      Authorization: wixAuth.apiKey,
      'wix-site-id': wixAuth.siteId,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*'
    };

    const results = [];
    let created = 0;
    let failed = 0;

    for (let i = 0; i < rawProducts.length; i++) {
      const p = rawProducts[i];
      const sku = normalizeSku(p?.sku);
      const name = pickName(p);
      const descHtml = pickDescriptionHtml(p);
      const price = pickPrice(p);
      const qty = pickQty(p);
      const imageUrls = pickImageUrls(p);

      try {
        const body = {
          product: {
            name,
            productType: 'PHYSICAL',
            ...(descHtml ? { plainDescription: descHtml } : {}),
            ...(imageUrls.length
              ? {
                  media: {
                    itemsInfo: {
                      items: imageUrls.map((url) => ({
                        url,
                        altText: name
                      }))
                    }
                  }
                }
              : {}),
            variantsInfo: {
              variants: [
                {
                  ...(sku ? { sku } : {}),
                  price: {
                    actualPrice: { amount: toAmountString(price), currency }
                  },
                  inventoryItem: {
                    // Use exact quantity when present; otherwise fall back to inStock.
                    ...(Number.isFinite(qty) ? { quantity: qty } : { inStock: qty > 0 })
                  }
                }
              ]
            },
            physicalProperties: {}
          }
        };

        const r = await axios.post('https://www.wixapis.com/stores/v3/products-with-inventory', body, {
          headers,
          timeout: 30000,
          validateStatus: () => true
        });

        if (r.status >= 200 && r.status < 300) {
          created += 1;
          results.push({
            success: true,
            index: i,
            sku,
            wixProductId: r?.data?.product?._id || r?.data?.product?.id || null,
            imagesAttached: imageUrls.length,
            wixResponse: r.data
          });
        } else {
          failed += 1;
          results.push({
            success: false,
            index: i,
            sku,
            status: r.status,
            imagesAttempted: imageUrls.length,
            wixError: r.data
          });
        }
      } catch (err) {
        failed += 1;
        results.push({
          success: false,
          index: i,
          sku,
          imagesAttempted: imageUrls.length,
          error: err?.response?.data || err?.message || 'Unknown error'
        });
      }
    }

    return res.status(200).json({
      success: failed === 0,
      wixAuthSource: wixAuth.source,
      created,
      failed,
      results
    });
  } catch (err) {
    const status = err?.response?.status || 500;
    return res.status(status).json({
      success: false,
      message: 'Failed to sync products to Wix',
      error: err?.response?.data || err?.message || 'Unknown error'
    });
  }
};

module.exports = {
  syncWixProducts
};

