const axios = require('axios');
const finerworksService = require('../helpers/finerworks-service');
const { sendApiError } = require('../helpers/api-error');
const debug = require('debug');
const log = debug('app:wixProducts');

const WIX_OPTION_CONFIGURATION = 'Configuration';
/** Wix Catalog V3 caps option choice labels at 50 chars (validated server-side). */
const MAX_WIX_CHOICE_NAME_LEN = 50;

function normalizeSku(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function toAmountString(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '0';
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

/** Same idea as Squarespace: label each variant row for the option picker. */
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

/** Trim to Wix max length for option choice names. */
function truncateWixChoiceName(s) {
  return String(s || '')
    .trim()
    .slice(0, MAX_WIX_CHOICE_NAME_LEN);
}

/** Ensure Wix option choice names are unique within the product (each ≤ 50 chars). */
function uniqueChoiceLabels(items, labelFn) {
  const used = new Set();
  const out = [];
  for (let i = 0; i < items.length; i++) {
    let label = String(labelFn(items[i]) || '').trim();
    if (!label) label = normalizeSku(items[i]?.sku) || `Option ${i + 1}`;

    let candidate = truncateWixChoiceName(label);
    let n = 2;
    while (used.has(candidate)) {
      const suffix = ` (${n})`;
      const maxBase = MAX_WIX_CHOICE_NAME_LEN - suffix.length;
      candidate = truncateWixChoiceName(`${label.slice(0, Math.max(1, maxBase))}${suffix}`);
      n++;
    }
    used.add(candidate);
    out.push(candidate);
  }
  return out;
}

/**
 * Order-preserving jobs: items without `image_guid` are each a separate product;
 * items sharing the same `image_guid` are one product with multiple variants (like Squarespace sync).
 */
function buildSyncJobs(rawProducts) {
  const processedGuid = new Set();
  const jobs = [];
  for (const p of rawProducts) {
    // if the product already present in the wix store then we do not need to sync it again.
    if (p.third_party_integrations && p.third_party_integrations.wix_inventory_id) {
      continue;
    }
    const g = String(p?.image_guid || '').trim();
    if (!g) {
      jobs.push({ kind: 'single', items: [p] });
      continue;
    }
    if (processedGuid.has(g)) continue;
    processedGuid.add(g);
    const items = rawProducts.filter((q) => String(q?.image_guid || '').trim() === g);
    if (items.length <= 1) {
      jobs.push({ kind: 'single', items, image_guid: g });
    } else {
      jobs.push({ kind: 'variants', items, image_guid: g });
    }
  }
  return jobs;
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

/** Decode JWT payload without verifying signature (matches wix-auth helper). */
function jwtPayloadDecodeUnverified(token) {
  const parts = String(token || '')
    .replace(/^Bearer\s+/i, '')
    .trim()
    .split('.');
  if (parts.length < 2) return null;
  const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const pad = payloadB64.length % 4 === 0 ? '' : '='.repeat(4 - (payloadB64.length % 4));
  try {
    const json = Buffer.from(payloadB64 + pad, 'base64').toString('utf8');
    return safeJsonParse(json);
  } catch (_) {
    return null;
  }
}

/**
 * Wix app tokens (e.g. `OauthNG.JWS...`) embed `instance` with `metaSiteId` inside stringified `data`.
 * Use metaSiteId as `wix-site-id` when the connection row has `site_id: null`.
 */
function parseWixOAuthAccessTokenContext(accessTokenRaw) {
  const token = String(accessTokenRaw || '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  const payload = jwtPayloadDecodeUnverified(token);
  if (!payload) return null;

  let embedded = payload;
  if (typeof payload.data === 'string') {
    embedded = safeJsonParse(payload.data) || {};
  } else if (payload.data && typeof payload.data === 'object') {
    embedded = payload.data;
  }

  const inst = embedded?.instance || embedded;
  const metaSiteId = inst?.metaSiteId || inst?.siteId || embedded?.metaSiteId || embedded?.siteId;
  const instanceId = inst?.instanceId || inst?.instance_id;
  let permissions = inst?.permissions;
  if (permissions == null) permissions = embedded?.permissions;
  const permissionsStr = permissions != null ? String(permissions) : null;

  const out = {
    metaSiteId: metaSiteId ? String(metaSiteId).trim() : null,
    instanceId: instanceId ? String(instanceId).trim() : null,
    permissions: permissionsStr,
    permissionsEmpty: permissionsStr !== null && permissionsStr.trim() === '',
  };
  if (!out.metaSiteId && !out.instanceId) return null;
  return out;
}

function oauthEffectiveSiteId(siteIdStored, accessToken) {
  const s = String(siteIdStored || '').trim();
  if (s) return s;
  return parseWixOAuthAccessTokenContext(accessToken)?.metaSiteId || null;
}

/** Backfill FineWorks connections when `site_id` was never saved but the token carries `metaSiteId`. */
async function maybePersistDiscoveredWixSiteId(account_key, metaSiteId) {
  const sid = String(metaSiteId || '').trim();
  if (!sid || !account_key || !String(account_key).trim()) return;

  const info = await finerworksService.GET_INFO({ account_key: String(account_key).trim() });
  const connections = info?.user_account?.connections || [];
  const idx = Array.isArray(connections) ? connections.findIndex((c) => c && c.name === 'Wix') : -1;
  if (idx === -1) return;

  let data = {};
  try {
    const raw = connections[idx]?.data;
    data = typeof raw === 'string' ? JSON.parse(raw) : raw || {};
  } catch (_) {
    data = {};
  }
  const existing = String(data?.site_id || '').trim();
  if (existing) return;

  const nextData = { ...data, site_id: sid };
  const copy = JSON.parse(JSON.stringify(connections));
  copy[idx] = {
    ...copy[idx],
    data: JSON.stringify(nextData),
  };
  await finerworksService.UPDATE_INFO({
    account_key: String(account_key).trim(),
    connections: copy,
  });
}

function summarizeWixHttpError(r) {
  const payload = {};
  const d = r?.data;
  if (typeof d === 'string' && d.trim()) {
    const raw = d.trim();
    payload.rawBody = raw.slice(0, 2000);
    if (!payload.message) payload.message = raw.slice(0, 500);
  } else if (d && typeof d === 'object') {
    Object.assign(payload, d);
  }
  if (r?.status != null) payload.httpStatus = r.status;
  if (r?.statusText) payload.httpStatusText = r.statusText;
  const noMsg = typeof payload.message !== 'string' || payload.message.trim() === '';
  const noDetails =
    !payload.details ||
    (typeof payload.details === 'object' && Object.keys(payload.details || {}).length === 0);
  if (noMsg && noDetails && r?.status === 403) {
    payload.hint403 =
      'Usually missing Stores/Catalog API permissions or the app installation/instance does not match this site.';
  }
  return payload;
}

function buildAuthHeaders(wixAuth) {
  const headers = {
    Authorization:
      wixAuth.authType === 'oauth'
        ? String(wixAuth.accessToken)
            .trim()
            .match(/^Bearer\s+/i)
          ? String(wixAuth.accessToken).trim()
          : `Bearer ${String(wixAuth.accessToken).trim()}`
        : wixAuth.accessToken,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
  };
  if (wixAuth.siteId) {
    headers['wix-site-id'] = wixAuth.siteId;
  }
  return headers;
}

function buildProductRequestBody({ items, currency, multiVariant }) {
  const first = items[0];
  const name = pickName(first);
  const descHtml = pickDescriptionHtml(first);
  const imageUrls = pickImageUrls(first);

  if (!multiVariant) {
    const p = first;
    const sku = normalizeSku(p?.sku);
    const price = pickPrice(p);
    const qty = pickQty(p);
    return {
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
                    altText: name,
                  })),
                },
              },
            }
          : {}),
        variantsInfo: {
          variants: [
            {
              ...(sku ? { sku } : {}),
              price: {
                actualPrice: { amount: toAmountString(price), currency },
              },
              inventoryItem: {
                ...(Number.isFinite(qty) ? { quantity: qty } : { inStock: qty > 0 }),
              },
            },
          ],
        },
        physicalProperties: {},
      },
    };
  }

  const choiceLabels = uniqueChoiceLabels(items, buildVariantLabel);

  const variants = items.map((p, idx) => {
    const sku = normalizeSku(p?.sku);
    const price = pickPrice(p);
    const qty = pickQty(p);
    const choiceName = choiceLabels[idx];
    return {
      ...(sku ? { sku } : {}),
      visible: true,
      choices: [
        {
          optionChoiceNames: {
            optionName: WIX_OPTION_CONFIGURATION,
            choiceName,
            renderType: 'TEXT_CHOICES',
          },
        },
      ],
      price: {
        actualPrice: { amount: toAmountString(price), currency },
      },
      inventoryItem: {
        ...(Number.isFinite(qty) ? { quantity: qty } : { inStock: qty > 0 }),
      },
      physicalProperties: {},
    };
  });

  return {
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
                  altText: name,
                })),
              },
            },
          }
        : {}),
      options: [
        {
          name: WIX_OPTION_CONFIGURATION,
          optionRenderType: 'TEXT_CHOICES',
          choicesSettings: {
            choices: choiceLabels.map((choiceName) => ({
              choiceType: 'CHOICE_TEXT',
              name: choiceName,
            })),
          },
        },
      ],
      variantsInfo: { variants },
      physicalProperties: {},
    },
  };
}

async function mintWixAppAccessTokenFromInstanceId(instanceId, creds = {}) {
  const clientId = String(creds.client_id || process.env.WIX_CLIENT_ID || '').trim();
  const clientSecret = String(creds.client_secret || process.env.WIX_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  const resp = await axios.post(
    'https://www.wixapis.com/oauth2/token',
    {
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      instance_id: String(instanceId).trim(),
    },
    { timeout: 20000 }
  );
  return resp?.data || null;
}

function isExpired(expires_at) {
  if (!expires_at) return true;
  const t = Date.parse(expires_at);
  if (!Number.isFinite(t)) return true;
  return Date.now() + 60_000 >= t;
}

async function resolveWixAuth({
  account_key,
  access_token,
  ignoreRequestToken = false,
  allowEnvFallback = true,
}) {
  if (!ignoreRequestToken && access_token) {
    const t = String(access_token).trim();
    return {
      authType: 'oauth',
      accessToken: t,
      siteId: oauthEffectiveSiteId(null, t),
      source: 'request',
    };
  }

  if (account_key) {
    const info = await finerworksService.GET_INFO({ account_key: String(account_key).trim() });
    const connections = info?.user_account?.connections || [];
    const wixConn = Array.isArray(connections)
      ? connections.find((c) => c && c.name === 'Wix')
      : null;
    if (wixConn) {
      let data = {};
      try {
        data = typeof wixConn.data === 'string' ? JSON.parse(wixConn.data) : wixConn.data || {};
      } catch (_) {
        data = {};
      }
      const authType = data?.auth_type === 'api_key' ? 'api_key' : 'oauth';
      const accessTokenStored = String(data?.access_token || wixConn.id || '').trim();
      const instanceId = String(data?.instance_id || '').trim();
      const siteIdStored = String(data?.site_id || '').trim();
      const expiresAt = data?.expires_at || null;

      const mintCreds = {
        client_id: data?.client_id || data?.wix_client_id,
        client_secret: data?.client_secret || data?.wix_client_secret,
      };

      if (authType === 'api_key') {
        if (accessTokenStored) {
          return {
            authType,
            accessToken: accessTokenStored,
            siteId: siteIdStored || null,
            source: 'connections',
          };
        }
      } else if (instanceId && (!accessTokenStored || isExpired(expiresAt))) {
        const tokenData = await mintWixAppAccessTokenFromInstanceId(instanceId, mintCreds);
        const nextAccess = tokenData?.access_token ? String(tokenData.access_token).trim() : '';
        const expires_in = tokenData?.expires_in;
        const nextExpiresAt = Number.isFinite(Number(expires_in))
          ? new Date(Date.now() + Number(expires_in) * 1000).toISOString()
          : null;

        if (nextAccess) {
          const fromTok = parseWixOAuthAccessTokenContext(nextAccess);
          const siteToStore = siteIdStored || data?.site_id || fromTok?.metaSiteId || null;

          const nextData = {
            ...data,
            auth_type: 'oauth_client_credentials',
            instance_id: instanceId,
            site_id: siteToStore ? String(siteToStore).trim() : null,
            access_token: nextAccess,
            expires_in: expires_in ?? null,
            expires_at: nextExpiresAt,
            refreshed_at: new Date().toISOString(),
          };
          const idx = Array.isArray(connections)
            ? connections.findIndex((c) => c && c.name === 'Wix')
            : -1;
          if (idx !== -1) {
            const copy = JSON.parse(JSON.stringify(connections));
            copy[idx] = { name: 'Wix', id: nextAccess, data: JSON.stringify(nextData) };
            await finerworksService.UPDATE_INFO({
              account_key: String(account_key).trim(),
              connections: copy,
            });
          }
          return {
            authType: 'oauth',
            accessToken: nextAccess,
            siteId: oauthEffectiveSiteId(siteToStore, nextAccess),
            source: 'connections_refresh',
          };
        }
      }

      if (authType === 'oauth' && accessTokenStored) {
        return {
          authType,
          accessToken: accessTokenStored,
          siteId: oauthEffectiveSiteId(siteIdStored, accessTokenStored),
          source: 'connections',
        };
      }
      if (authType === 'api_key' && accessTokenStored) {
        return {
          authType,
          accessToken: accessTokenStored,
          siteId: siteIdStored || null,
          source: 'connections',
        };
      }
    }
  }

  if (allowEnvFallback) {
    const envAccess = String(process.env.WIX_API_KEY || '').trim();
    const envSiteFromEnv = String(process.env.WIX_SITE_ID || '').trim();
    if (envAccess && envSiteFromEnv) {
      return { authType: 'api_key', accessToken: envAccess, siteId: envSiteFromEnv, source: 'env' };
    }
    if (envAccess)
      return { authType: 'api_key', accessToken: envAccess, siteId: null, source: 'env' };

    const envOauthAccess = String(process.env.WIX_OAUTH_ACCESS_TOKEN || '').trim();
    if (envOauthAccess) {
      return {
        authType: 'oauth',
        accessToken: envOauthAccess,
        siteId: oauthEffectiveSiteId(null, envOauthAccess),
        source: 'env',
      };
    }
  }

  return null;
}

const WIX_CREATE_PRODUCT_URL = 'https://www.wixapis.com/stores/v3/products-with-inventory';

/**
 * Sync products from Fineworks payload to Wix Stores Catalog V3.
 *
 * Mirrors Shopify/Squarespace:
 * - `productList` or `productsList` in body (same shapes as elsewhere)
 * - `account_key`, `access_token` from query or body (query overrides for convenience)
 * - Rows sharing the same `image_guid` export as **one Wix product** with multiple variants (Squarespace logic)
 *
 * Auth: request `access_token` or FinerWorks `connections` Wix row only (no WIX_* env fallback).
 * OAuth refresh uses `instance_id` from the connection; client secrets may fall back to env
 * `WIX_CLIENT_ID` / `WIX_CLIENT_SECRET` for token minting only.
 */
const syncWixProducts = async (req, res) => {
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
      req.query?.access_token || req.body?.access_token || req.headers['x-wix-access-token'];

    if (!account_key || !String(account_key).trim()) {
      return sendApiError(res, 400, 'account_key is required');
    }
    if (!Array.isArray(rawProducts) || !rawProducts.length) {
      return sendApiError(res, 400, 'productList / productsList must be a non-empty array');
    }

    let wixAuth = await resolveWixAuth({
      account_key,
      access_token,
      allowEnvFallback: false,
    });

    if (!wixAuth) {
      return sendApiError(
        res,
        400,
        'Missing Wix auth. Connect Wix for this account or provide access_token in the request.'
      );
    }

    if (
      account_key &&
      wixAuth.authType === 'oauth' &&
      wixAuth.siteId &&
      ['request', 'connections', 'connections_refresh'].includes(wixAuth.source)
    ) {
      try {
        await maybePersistDiscoveredWixSiteId(account_key, wixAuth.siteId);
      } catch (_) {
        // non-fatal; sync can still succeed with metaSiteId on this request only
      }
    }

    const tokenCtx =
      wixAuth.authType === 'oauth' ? parseWixOAuthAccessTokenContext(wixAuth.accessToken) : null;
    const warnings = [];
    if (tokenCtx?.permissionsEmpty) {
      warnings.push(
        'This Wix access token carries empty permissions inside its payload. Grant Stores/Catalog (or equivalent REST) permissions to the app in Wix Dev Center, save changes, uninstall the app from the site, reinstall, run /wix/instance/connect again, then sync without reusing old tokens.'
      );
    }

    const jobs = buildSyncJobs(rawProducts);
    const results = [];
    let created = 0;
    let failed = 0;

    const postCreate = async (body) =>
      axios.post(WIX_CREATE_PRODUCT_URL, body, {
        headers: buildAuthHeaders(wixAuth),
        timeout: 30000,
        validateStatus: () => true,
      });

    let ignoreRequestAuth = false;

    for (let ji = 0; ji < jobs.length; ji++) {
      const job = jobs[ji];
      const items = job.items;
      const multiVariant = job.kind === 'variants';
      const guid = job.image_guid || null;

      try {
        const body = buildProductRequestBody({ items, currency, multiVariant });

        let r = await postCreate(body);

        if (r.status === 401 && account_key && !ignoreRequestAuth) {
          ignoreRequestAuth = true;
          wixAuth = await resolveWixAuth({
            account_key,
            access_token: null,
            ignoreRequestToken: true,
            allowEnvFallback: false,
          });
          if (wixAuth) {
            r = await postCreate(body);
          }
        }

        const skuPreview = normalizeSku(items[0]?.sku);

        if (r.status >= 200 && r.status < 300) {
          created += 1;
          const wixProductId = r?.data?.product?._id || r?.data?.product?.id || null;

          const resultEntry = {
            success: true,
            jobIndex: ji,
            ...(guid ? { image_guid: guid } : {}),
            variantCount: items.length,
            sku: skuPreview,
            wixProductId,
            wixResponse: r.data,
          };

          // Update FinerWorks virtual inventory with the new Wix product id (inventory integration field).
          try {
            const accountKey =
              req.body?.account_key ||
              req.body?.accountKey ||
              req.body?.accountkey ||
              req.query?.account_key ||
              req.query?.accountKey ||
              null;

            if (wixProductId && accountKey) {
              const wixInventoryId = String(wixProductId);

              const virtualInventoryItems = [];
              for (const src of items) {
                if (!src) continue;
                const srcSku = normalizeSku(src?.sku);
                if (!srcSku) continue;

                virtualInventoryItems.push({
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
                    wix_inventory_id: wixInventoryId,
                  },
                });
              }

              const finalPayload = {
                virtual_inventory: virtualInventoryItems,
                account_key: accountKey,
              };

              const virtualInventoryUpdates = [];
              const virtualInventoryUpdateErrors = [];

              for (const viItem of virtualInventoryItems) {
                try {
                  const onePayload = {
                    virtual_inventory: [viItem],
                    account_key: accountKey,
                  };
                  const updateResult = await finerworksService.UPDATE_VIRTUAL_INVENTORY(onePayload);
                  virtualInventoryUpdates.push({
                    sku: viItem?.sku || null,
                    result: updateResult,
                  });
                } catch (singleErr) {
                  virtualInventoryUpdateErrors.push({
                    sku: viItem?.sku || null,
                    error: singleErr.message || 'Unknown virtual inventory update error',
                  });
                }
              }

              if (virtualInventoryUpdates.length) {
                resultEntry.virtualInventoryUpdates = virtualInventoryUpdates;
              }
              if (virtualInventoryUpdateErrors.length) {
                resultEntry.virtualInventoryUpdateErrors = virtualInventoryUpdateErrors;
              }
              if (virtualInventoryItems.length) {
                resultEntry.virtualInventoryPayload = finalPayload;
              }
            }
          } catch (fwErr) {
            resultEntry.virtualInventoryUpdateError =
              fwErr.message || 'Unknown virtual inventory update error';
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
            wixError: summarizeWixHttpError(r),
          });
        }
      } catch (err) {
        failed += 1;
        results.push({
          success: false,
          jobIndex: ji,
          ...(guid ? { image_guid: guid } : {}),
          sku: normalizeSku(items[0]?.sku),
          error: err?.response?.data || err?.message || 'Unknown error',
        });
      }
    }

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'wix',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'syncWixProducts',
      operation: 'Wix products sync completed',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      result: { created, failed, jobCount: jobs.length, success: failed === 0 },
      timestamp: new Date().toISOString()
    });
    console.log(successLog);
    log('Success in syncWixProducts: %s', successLog);
    return res.status(200).json({
      success: failed === 0,
      wixAuthSource: wixAuth.source,
      wixAuthType: wixAuth.authType,
      wixSiteIdUsed: wixAuth.siteId || null,
      ...(warnings.length ? { warnings } : {}),
      created,
      failed,
      jobCount: jobs.length,
      results,
    });
  } catch (err) {
    const isWixError = err?.response?.config?.url?.includes('wixapis.com') || err?.config?.url?.includes('wixapis.com');
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'wix',
      source: isWixError ? 'wix_api' : (isFinerworksError ? 'finerworks_api' : 'lambda'),
      function: 'syncWixProducts',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to sync Wix products: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.error || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in syncWixProducts: %s', errorJson);
    return sendApiError(res, err);
  }
};

module.exports = {
  syncWixProducts,
  resolveWixAuth,
  buildAuthHeaders,
  summarizeWixHttpError,
  maybePersistDiscoveredWixSiteId,
};
