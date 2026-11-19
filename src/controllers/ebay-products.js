const finerworksService = require('../helpers/finerworks-service');
const { sendApiError } = require('../helpers/api-error');
const {
  getEbayAppToken,
  getEbayMarketplaceId,
  getEbayCurrency,
  ebayApiCall,
  isOk,
  ebayError,
  summarizeEbayHttpError,
  isEbayUrl,
} = require('../helpers/ebay-api');
const { resolveEbayAuth } = require('./ebay-auth');
const debug = require('debug');
const log = debug('app:ebayProducts');

/**
 * eBay listing flow (Inventory API), per OFA product:
 *   1. PUT  /sell/inventory/v1/inventory_item/{sku}            one inventory item per SKU
 *   2. POST /sell/inventory/v1/offer                           one offer per SKU (price, qty,
 *                                                              category, policies, location)
 *   3a. single SKU  : POST /sell/inventory/v1/offer/{offerId}/publish
 *   3b. variations  : PUT  /sell/inventory/v1/inventory_item_group/{key} (variesBy)
 *                     POST /sell/inventory/v1/offer/publish_by_inventory_item_group
 * Prerequisites resolved once per sync:
 *   - business policies (fulfillment/payment/return) via the Account API
 *   - an inventory location (merchantLocationKey) — created from EBAY_LOCATION_* when missing
 *   - category (Taxonomy API suggestion, or an explicit/default category id) and the category's
 *     required item specifics (aspects)
 * Written back to FinerWorks: third_party_integrations.ebay_product_id (eBay listing id) and
 * ebay_variant_id (eBay offer id for that SKU).
 */

const INVENTORY = '/sell/inventory/v1';
const TITLE_MAX = 80; // eBay listing title limit
const ASPECT_VALUE_MAX = 65;

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
  return d.trim() || null;
}

function pickPrice(p) {
  const n = Number(
    p?.asking_price || p?.per_item_price || p?.price_details?.product_price || p?.price_details?.total_price || p?.total_price || 0
  );
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function pickQty(p) {
  const q = Number(p?.quantity_in_stock ?? p?.quantity ?? p?.inventory_quantity ?? 0);
  return Number.isFinite(q) && q >= 0 ? Math.round(q) : 0;
}

/** eBay downloads images itself, but only from https URLs; max 24 per listing. */
function pickImageUrls(p) {
  const urls = [];
  for (let i = 1; i <= 5; i++) {
    const u = p?.[`image_url_${i}`];
    if (typeof u === 'string' && /^https:\/\//i.test(u.trim())) urls.push(u.trim());
  }
  return [...new Set(urls)];
}

function isAlreadyOnEbay(p) {
  return !!p?.third_party_integrations?.ebay_product_id;
}

/** Same grouping as the other platforms: rows sharing image_guid become one multi-variation listing. */
function buildSyncJobs(rawProducts) {
  const seen = new Set();
  const jobs = [];
  for (const p of rawProducts) {
    if (isAlreadyOnEbay(p)) continue;
    const g = String(p?.image_guid || '').trim();
    if (!g) {
      jobs.push({ kind: 'single', items: [p] });
      continue;
    }
    if (seen.has(g)) continue;
    seen.add(g);
    const items = rawProducts.filter((q) => String(q?.image_guid || '').trim() === g && !isAlreadyOnEbay(q));
    if (items.length) jobs.push({ kind: items.length > 1 ? 'variants' : 'single', items, image_guid: g });
  }
  return jobs;
}

function parseJsonEnv(name) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch (_e) {
    log('%s is not valid JSON; ignored', name);
    return {};
  }
}

/** { name: value | [values] } -> { name: [string values] } (eBay aspect shape), trimmed to limits. */
function toAspectMap(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const vals = (Array.isArray(v) ? v : [v])
      .filter((x) => x != null && String(x).trim())
      .map((x) => String(x).trim().slice(0, ASPECT_VALUE_MAX));
    if (k && vals.length) out[String(k).trim()] = vals;
  }
  return out;
}

/* ------------------------------------------------------------------ prerequisites */

/**
 * Business policy ids: request body -> env -> the seller's first policy of each type.
 * Sellers must be opted in to business policies; if they have none, eBay returns an error or an
 * empty list and we explain what to set up.
 */
async function resolveListingPolicies(accessToken, body) {
  const marketplace_id = getEbayMarketplaceId();
  const wanted = {
    fulfillmentPolicyId: body?.fulfillment_policy_id || process.env.EBAY_FULFILLMENT_POLICY_ID || null,
    paymentPolicyId: body?.payment_policy_id || process.env.EBAY_PAYMENT_POLICY_ID || null,
    returnPolicyId: body?.return_policy_id || process.env.EBAY_RETURN_POLICY_ID || null,
  };
  const lookups = [
    ['fulfillmentPolicyId', 'fulfillment_policy', 'fulfillmentPolicies'],
    ['paymentPolicyId', 'payment_policy', 'paymentPolicies'],
    ['returnPolicyId', 'return_policy', 'returnPolicies'],
  ];
  const found = {};
  for (const [field, path, listKey] of lookups) {
    if (wanted[field]) continue;
    const r = await ebayApiCall({ method: 'GET', path: `/sell/account/v1/${path}`, accessToken, params: { marketplace_id } });
    if (!isOk(r)) {
      return { policies: null, error: { step: path, ...summarizeEbayHttpError({ response: r }) } };
    }
    const list = Array.isArray(r.data?.[listKey]) ? r.data[listKey] : [];
    found[path] = list.map((p) => ({ id: p[field], name: p.name }));
    wanted[field] = list[0]?.[field] || null;
  }
  const missing = Object.entries(wanted).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    return {
      policies: null,
      error: {
        message: `The eBay seller account has no ${missing.join(', ')}. Create shipping, payment and return business policies in eBay Seller Hub (Account > Business policies), or pass the ids in the request.`,
        found,
      },
    };
  }
  return { policies: wanted, error: null };
}

/** Uses (or creates) the inventory location every offer must reference. */
async function ensureInventoryLocation(accessToken, body) {
  const key = String(body?.merchant_location_key || process.env.EBAY_MERCHANT_LOCATION_KEY || 'finerworks-default')
    .trim()
    .slice(0, 36);
  const existing = await ebayApiCall({ method: 'GET', path: `${INVENTORY}/location/${encodeURIComponent(key)}`, accessToken });
  if (isOk(existing)) return { merchantLocationKey: key, created: false };
  if (existing.status !== 404) throw ebayError('Could not read the eBay inventory location', existing);

  const loc = body?.location || {};
  const address = {
    addressLine1: loc.address_line1 || process.env.EBAY_LOCATION_ADDRESS_LINE1 || undefined,
    city: loc.city || process.env.EBAY_LOCATION_CITY || undefined,
    stateOrProvince: loc.state || process.env.EBAY_LOCATION_STATE || undefined,
    postalCode: loc.postal_code || process.env.EBAY_LOCATION_POSTAL_CODE || undefined,
    country: loc.country || process.env.EBAY_LOCATION_COUNTRY || 'US',
  };
  if (!address.postalCode && !(address.city && address.stateOrProvince)) {
    const err = new Error(
      `eBay inventory location "${key}" does not exist and no address is configured. Set EBAY_LOCATION_POSTAL_CODE (and city/state) or pass location in the request.`
    );
    err.status = 400;
    throw err;
  }
  const created = await ebayApiCall({
    method: 'POST',
    path: `${INVENTORY}/location/${encodeURIComponent(key)}`,
    accessToken,
    body: {
      location: { address },
      locationTypes: ['WAREHOUSE'],
      name: String(process.env.EBAY_LOCATION_NAME || 'FinerWorks').slice(0, 1000),
      merchantLocationStatus: 'ENABLED',
    },
  });
  if (!isOk(created)) throw ebayError('Failed to create the eBay inventory location', created);
  return { merchantLocationKey: key, created: true };
}

/* ------------------------------------------------------------------ taxonomy */

const taxonomyCache = { treeId: null, treeMarketplace: null, aspects: new Map() };

async function getCategoryTreeId(appToken) {
  const mp = getEbayMarketplaceId();
  if (taxonomyCache.treeId && taxonomyCache.treeMarketplace === mp) return taxonomyCache.treeId;
  const r = await ebayApiCall({
    method: 'GET',
    path: '/commerce/taxonomy/v1/get_default_category_tree_id',
    accessToken: appToken,
    params: { marketplace_id: mp },
  });
  if (!isOk(r) || !r.data?.categoryTreeId) throw ebayError('Could not read the eBay category tree', r);
  taxonomyCache.treeId = r.data.categoryTreeId;
  taxonomyCache.treeMarketplace = mp;
  return taxonomyCache.treeId;
}

async function suggestCategory(appToken, treeId, q) {
  const r = await ebayApiCall({
    method: 'GET',
    path: `/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions`,
    accessToken: appToken,
    params: { q: String(q).slice(0, 350) },
  });
  if (!isOk(r)) return { categoryId: null, error: summarizeEbayHttpError({ response: r }) };
  const top = (r.data?.categorySuggestions || [])[0]?.category || null;
  return { categoryId: top?.categoryId || null, categoryName: top?.categoryName || null };
}

/** Category aspects: [{ name, required, mode, values, forVariations }], cached per category. */
async function getCategoryAspects(appToken, treeId, categoryId) {
  const cacheKey = `${treeId}:${categoryId}`;
  if (taxonomyCache.aspects.has(cacheKey)) return taxonomyCache.aspects.get(cacheKey);
  const r = await ebayApiCall({
    method: 'GET',
    path: `/commerce/taxonomy/v1/category_tree/${treeId}/get_item_aspects_for_category`,
    accessToken: appToken,
    params: { category_id: categoryId },
  });
  if (!isOk(r)) {
    log('getCategoryAspects failed for %s: %o', categoryId, summarizeEbayHttpError({ response: r }));
    return [];
  }
  const aspects = (r.data?.aspects || []).map((a) => ({
    name: a?.localizedAspectName,
    required: a?.aspectConstraint?.aspectRequired === true,
    mode: a?.aspectConstraint?.aspectMode || 'FREE_TEXT',
    forVariations: a?.aspectConstraint?.aspectEnabledForVariations === true,
    values: (a?.aspectValues || []).map((v) => v?.localizedValue).filter(Boolean),
  }));
  taxonomyCache.aspects.set(cacheKey, aspects);
  return aspects;
}

/**
 * Item specifics for a listing. Sources, later wins: built-in (Brand = Unbranded) ->
 * EBAY_DEFAULT_ASPECTS (JSON) -> request `aspects` -> product `ebay_aspects`.
 * Reports required aspects that are still missing (or whose value isn't allowed for a
 * SELECTION_ONLY aspect) so the caller can show exactly what to fill in.
 */
function buildAspects(categoryAspects, product, body) {
  const aspects = toAspectMap({
    Brand: 'Unbranded',
    ...parseJsonEnv('EBAY_DEFAULT_ASPECTS'),
    ...(body?.aspects || {}),
    ...(product?.ebay_aspects || {}),
  });
  const missing = [];
  for (const a of categoryAspects) {
    if (!a.required || !a.name) continue;
    const vals = aspects[a.name];
    if (!vals?.length) {
      missing.push(a.mode === 'SELECTION_ONLY' && a.values.length ? `${a.name} (one of: ${a.values.slice(0, 10).join(', ')}${a.values.length > 10 ? ', ...' : ''})` : a.name);
    } else if (a.mode === 'SELECTION_ONLY' && a.values.length && !vals.every((v) => a.values.includes(v))) {
      missing.push(`${a.name} (value "${vals[0]}" not allowed; one of: ${a.values.slice(0, 10).join(', ')})`);
    }
  }
  return { aspects, missing };
}

/* ------------------------------------------------------------------ listing calls */

async function putInventoryItem(accessToken, { sku, title, description, imageUrls, aspects, quantity }) {
  const r = await ebayApiCall({
    method: 'PUT',
    path: `${INVENTORY}/inventory_item/${encodeURIComponent(sku)}`,
    accessToken,
    body: {
      availability: { shipToLocationAvailability: { quantity } },
      condition: String(process.env.EBAY_ITEM_CONDITION || 'NEW'),
      product: { title, description, imageUrls, aspects },
    },
  });
  if (!isOk(r)) throw ebayError(`Failed to create eBay inventory item ${sku}`, r);
}

/** Creates the offer for a SKU, or reuses (and updates) the one eBay already has for it. */
async function createOrUpdateOffer(accessToken, offerBody) {
  const created = await ebayApiCall({ method: 'POST', path: `${INVENTORY}/offer`, accessToken, body: offerBody });
  if (isOk(created) && created.data?.offerId) return created.data.offerId;

  // 25002 = an offer already exists for this SKU/marketplace/format; eBay returns its id.
  const params = summarizeEbayHttpError({ response: created }).parameters || [];
  let offerId = params.find((p) => p?.name === 'offerId')?.value || null;
  if (!offerId) {
    const list = await ebayApiCall({ method: 'GET', path: `${INVENTORY}/offer`, accessToken, params: { sku: offerBody.sku } });
    if (isOk(list)) {
      offerId = (list.data?.offers || []).find((o) => o?.marketplaceId === offerBody.marketplaceId)?.offerId || null;
    }
  }
  if (!offerId) throw ebayError(`Failed to create eBay offer for ${offerBody.sku}`, created);
  const updated = await ebayApiCall({ method: 'PUT', path: `${INVENTORY}/offer/${offerId}`, accessToken, body: offerBody });
  if (!isOk(updated)) throw ebayError(`Failed to update existing eBay offer for ${offerBody.sku}`, updated);
  return offerId;
}

/** Writes eBay ids back to FinerWorks virtual inventory for each SKU. */
async function updateVirtualInventoryWithEbayIds(accountKey, items, listingId, offerIdBySku) {
  const updates = [];
  const errors = [];
  for (const src of items) {
    const sku = normalizeSku(src?.sku);
    if (!sku) continue;
    const offerId = offerIdBySku.get(sku) || null;
    try {
      const result = await finerworksService.UPDATE_VIRTUAL_INVENTORY({
        virtual_inventory: [
          {
            sku,
            asking_price: pickPrice(src),
            name: pickName(src),
            description: pickDescription(src) || '',
            quantity_in_stock: pickQty(src),
            track_inventory: true,
            third_party_integrations: {
              ...(src?.third_party_integrations || {}),
              ebay_product_id: String(listingId),
              ...(offerId ? { ebay_variant_id: String(offerId) } : {}),
            },
          },
        ],
        account_key: String(accountKey).trim(),
      });
      updates.push({ sku, result });
    } catch (e) {
      errors.push({ sku, error: e?.message || 'Unknown virtual inventory update error' });
    }
  }
  return { updates, errors };
}

/** Variation value per SKU (must be unique within the group). */
function variationValues(items) {
  const used = new Set();
  return items.map((it) => {
    const candidates = [it?.ebay_variation_value, it?.variation_name, it?.description_short, normalizeSku(it?.sku)];
    for (const c of candidates) {
      const v = c != null ? String(c).trim().slice(0, ASPECT_VALUE_MAX) : '';
      if (v && !used.has(v)) {
        used.add(v);
        return v;
      }
    }
    const fallback = `Option ${used.size + 1}`;
    used.add(fallback);
    return fallback;
  });
}

/**
 * POST /ebay/sync-products — list OFA products on eBay.
 * Body: account_key, productList/productsList (required); optional: category_id, aspects {},
 * fulfillment_policy_id / payment_policy_id / return_policy_id, merchant_location_key,
 * location {address_line1, city, state, postal_code, country}.
 * Per product (optional): ebay_category_id, ebay_aspects {}, ebay_variation_value.
 */
const syncEbayProducts = async (req, res) => {
  try {
    const account_key = req.body?.account_key || req.query?.account_key;
    const rawProducts =
      (Array.isArray(req.body?.productList) ? req.body.productList : null) ||
      (Array.isArray(req.body?.productsList) ? req.body.productsList : []);
    if (!rawProducts.length) return sendApiError(res, 400, 'productList / productsList must be a non-empty array');

    const { accessToken } = await resolveEbayAuth(account_key);

    const { policies, error: policyError } = await resolveListingPolicies(accessToken, req.body);
    if (policyError) {
      return sendApiError(res, 400, policyError.message || 'Could not read eBay business policies', {
        detail: JSON.stringify(policyError).slice(0, 1500),
      });
    }
    const { merchantLocationKey, created: locationCreated } = await ensureInventoryLocation(accessToken, req.body);

    const jobs = buildSyncJobs(rawProducts);
    if (!jobs.length) {
      return res.status(200).json({ success: true, message: 'Nothing to sync (all products are already linked to eBay)', created: 0, failed: 0, jobCount: 0, results: [] });
    }

    const appToken = await getEbayAppToken();
    const treeId = await getCategoryTreeId(appToken);
    const marketplaceId = getEbayMarketplaceId();
    const currency = req.body?.currency || getEbayCurrency();
    const variationName = String(process.env.EBAY_VARIATION_ASPECT_NAME || 'Configuration').trim();

    const results = [];
    let created = 0;
    let failed = 0;

    for (let ji = 0; ji < jobs.length; ji++) {
      const { items, image_guid: guid } = jobs[ji];
      const first = items[0];
      const name = pickName(first);
      const base = { jobIndex: ji, ...(guid ? { image_guid: guid } : {}), sku: normalizeSku(first?.sku) };
      try {
        const imageUrls = [...new Set(items.flatMap(pickImageUrls))].slice(0, 24);
        if (!imageUrls.length) throw Object.assign(new Error('No https image_url_1..5 found; eBay requires at least one image'), { status: 400 });
        const badPrice = items.find((it) => !(pickPrice(it) > 0));
        if (badPrice) throw Object.assign(new Error(`SKU ${badPrice.sku} has no price; eBay requires a price above 0`), { status: 400 });

        // Category: product -> request -> env default -> eBay suggestion (title, then title + "art print").
        let categoryId = String(first?.ebay_category_id || req.body?.category_id || process.env.EBAY_DEFAULT_CATEGORY_ID || '').trim() || null;
        let categoryName = null;
        if (!categoryId) {
          for (const q of [name, `${name} art print`]) {
            const s = await suggestCategory(appToken, treeId, q);
            if (s.categoryId) {
              ({ categoryId, categoryName } = s);
              break;
            }
          }
        }
        if (!categoryId) throw Object.assign(new Error('Could not resolve an eBay category. Pass ebay_category_id on the product, category_id in the request, or set EBAY_DEFAULT_CATEGORY_ID.'), { status: 400 });

        const categoryAspects = await getCategoryAspects(appToken, treeId, categoryId);
        const { aspects, missing } = buildAspects(categoryAspects, first, req.body);
        if (missing.length) {
          failed += 1;
          results.push({
            ...base,
            success: false,
            categoryId,
            error: 'Missing required eBay item specifics for this category',
            missingItemSpecifics: missing,
            hint: 'Pass them as aspects {"Name": "Value"} in the request, ebay_aspects on the product, or EBAY_DEFAULT_ASPECTS.',
          });
          continue;
        }

        const title = name.slice(0, TITLE_MAX);
        const description = pickDescription(first) || name;
        const isGroup = items.length > 1;
        const values = isGroup ? variationValues(items) : [];
        const offerIdBySku = new Map();

        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          const sku = normalizeSku(it.sku);
          await putInventoryItem(accessToken, {
            sku,
            title,
            description: pickDescription(it) || description,
            imageUrls: pickImageUrls(it).length ? pickImageUrls(it) : imageUrls,
            aspects: isGroup ? { ...aspects, [variationName]: [values[i]] } : aspects,
            quantity: pickQty(it),
          });
          const offerId = await createOrUpdateOffer(accessToken, {
            sku,
            marketplaceId,
            format: 'FIXED_PRICE',
            availableQuantity: pickQty(it),
            categoryId,
            listingDescription: pickDescription(it) || description,
            listingPolicies: policies,
            merchantLocationKey,
            pricingSummary: { price: { value: pickPrice(it).toFixed(2), currency } },
          });
          offerIdBySku.set(sku, offerId);
        }

        let listingId = null;
        let groupKey = null;
        if (!isGroup) {
          const sku = normalizeSku(first.sku);
          const pub = await ebayApiCall({ method: 'POST', path: `${INVENTORY}/offer/${offerIdBySku.get(sku)}/publish`, accessToken });
          if (!isOk(pub)) throw ebayError('eBay rejected publishing the listing', pub);
          listingId = pub.data?.listingId || null;
        } else {
          groupKey = `fw${String(guid).replace(/[^A-Za-z0-9]/g, '')}`.slice(0, 50);
          const grp = await ebayApiCall({
            method: 'PUT',
            path: `${INVENTORY}/inventory_item_group/${encodeURIComponent(groupKey)}`,
            accessToken,
            body: {
              title,
              description,
              imageUrls,
              aspects,
              variantSKUs: items.map((it) => normalizeSku(it.sku)),
              variesBy: { specifications: [{ name: variationName, values }] },
            },
          });
          if (!isOk(grp)) throw ebayError('Failed to create the eBay variation group', grp);
          const pub = await ebayApiCall({
            method: 'POST',
            path: `${INVENTORY}/offer/publish_by_inventory_item_group`,
            accessToken,
            body: { inventoryItemGroupKey: groupKey, marketplaceId },
          });
          if (!isOk(pub)) throw ebayError('eBay rejected publishing the variation listing', pub);
          listingId = pub.data?.listingId || null;
        }

        created += 1;
        const entry = {
          ...base,
          success: true,
          variantCount: items.length,
          ebayListingId: listingId,
          ebayCategoryId: categoryId,
          ebayCategoryName: categoryName,
          ...(groupKey ? { ebayInventoryItemGroupKey: groupKey } : {}),
          offers: [...offerIdBySku.entries()].map(([sku, offerId]) => ({ sku, offerId })),
        };
        if (listingId) {
          const vi = await updateVirtualInventoryWithEbayIds(account_key, items, listingId, offerIdBySku);
          if (vi.updates.length) entry.virtualInventoryUpdates = vi.updates;
          if (vi.errors.length) entry.virtualInventoryUpdateErrors = vi.errors;
        }
        results.push(entry);
      } catch (err) {
        failed += 1;
        results.push({ ...base, success: false, error: err?.message || 'Unknown error', ebayError: err?.data || undefined });
      }
    }

    console.log(JSON.stringify({
      level: 'INFO',
      platform: 'ebay',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'syncEbayProducts',
      operation: 'eBay products sync completed',
      account_key: String(account_key).trim(),
      result: { created, failed, jobCount: jobs.length },
      timestamp: new Date().toISOString(),
    }));
    return res.status(200).json({
      success: failed === 0,
      created,
      failed,
      jobCount: jobs.length,
      merchantLocationKey,
      locationCreated,
      policies,
      results,
    });
  } catch (err) {
    console.error(JSON.stringify({
      level: 'ERROR',
      platform: 'ebay',
      source: isEbayUrl(err) || err?.response ? 'ebay_api' : 'lambda',
      function: 'syncEbayProducts',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || err?.status || null,
      message: `Failed to sync eBay products: ${err?.message || 'Unknown error'}`,
      detail: err?.data || summarizeEbayHttpError(err),
      timestamp: new Date().toISOString(),
    }));
    return sendApiError(res, err?.status || 500, err?.message || 'Unknown error', err?.data);
  }
};

module.exports = {
  syncEbayProducts,
  buildSyncJobs,
  buildAspects,
  variationValues,
  resolveListingPolicies,
  ensureInventoryLocation,
};
