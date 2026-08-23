const jwt = require('jsonwebtoken');
const axios = require('axios');
const { sendApiError } = require('../helpers/api-error');
const finerworksService = require('../helpers/finerworks-service');
const { resolveWixAuth, buildAuthHeaders: buildWixAuthHeaders } = require('./wix-products');
const {
  writeVirtualInventoryLink,
  clearVirtualInventoryLinkForProduct,
} = require('../helpers/virtual-inventory-links');
const debug = require('debug');
const log = debug('app:wix-webhooks');

function parseMaybeJsonString(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  if (typeof v !== 'string') return null;
  try {
    return JSON.parse(v);
  } catch (_) {
    return null;
  }
}

/**
 * Wix encodes the App installed JWT payload in different shapes; this covers the nested JSON-string
 * form (payload.data is a string containing instanceId + inner string `data` for appId).
 */
function extractWixAppInstalledFields(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const outerData =
    parseMaybeJsonString(payload.data) ||
    (typeof payload.data === 'object' ? payload.data : null) ||
    {};
  const metadata =
    parseMaybeJsonString(payload.metadata) ||
    (typeof payload.metadata === 'object' ? payload.metadata : null) ||
    {};
  const innerData =
    parseMaybeJsonString(outerData.data) ||
    (typeof outerData.data === 'object' ? outerData.data : null) ||
    {};

  const instanceId =
    outerData.instanceId ||
    metadata.instanceId ||
    payload.instanceId ||
    innerData.instanceId ||
    null;

  const accountInfo =
    metadata.accountInfo && typeof metadata.accountInfo === 'object'
      ? metadata.accountInfo
      : parseMaybeJsonString(metadata.accountInfo) || {};

  const siteId =
    accountInfo.siteId ||
    metadata.siteId ||
    outerData.siteId ||
    payload.siteId ||
    innerData.siteId ||
    null;

  const appId = innerData.appId || outerData.appId || payload.appId || null;
  const originInstanceId =
    innerData.originInstanceId || outerData.originInstanceId || payload.originInstanceId || null;

  const eventType = outerData.eventType || metadata.eventType || payload.eventType || null;

  return { instanceId, siteId, appId, originInstanceId, eventType };
}

/**
 * Wix App Instance Installed webhook handler.
 *
 * The HTTP body is a signed JWT (not a JSON object). Decode the payload to read event fields.
 * Verify the signature in production using the public key from the Wix app Webhooks page.
 *
 * Wix sends `metadata.instanceId` (app instance GUID) and may send `metadata.accountInfo.siteId`.
 * We persist these into the tenant's `connections[]` when `account_key` is provided so you can mint
 * access tokens via client_credentials (`createWixAccessTokenFromInstance`).
 *
 * If `account_key` is omitted (typical for Wix-only callbacks), we still return 200 and log the
 * decoded payload so installs are not retried indefinitely while you wire tenant mapping.
 */
/** Shared handler: raw body is a Wix-signed JWT (e.g. App instance installed). Used by dedicated webhook URL or POST /wix/oauth/callback. */
const handleWixJwtBodyAsAppInstall = async (req, res) => {
  try {
    const raw =
      typeof req.body === 'string'
        ? req.body
        : Buffer.isBuffer(req.body)
          ? req.body.toString('utf8')
          : '';

    const token = String(raw || '').trim();
    if (!token) {
      return sendApiError(res, 400, 'Empty webhook body (expected JWT string)');
    }

    const decoded = jwt.decode(token, { complete: true });
    const payload = decoded && typeof decoded === 'object' ? decoded.payload : null;
    if (!payload || typeof payload !== 'object') {
      return sendApiError(res, 400, 'Could not decode Wix webhook JWT payload');
    }

    const extracted = extractWixAppInstalledFields(payload);
    const instanceId = extracted?.instanceId || null;
    const siteId = extracted?.siteId || null;
    const appId = extracted?.appId || null;
    const originInstanceId = extracted?.originInstanceId || null;

    log('[wix app-install JWT] decoded (signature not verified):', {
      instanceId,
      siteId,
      appId,
      originInstanceId,
      eventType: extracted?.eventType,
    });

    let account_key =
      req.query?.account_key || req.query?.accountKey || req.headers['x-account-key'] || null;

    // Optional: same signed ctx used on GET /wix/oauth/install-return (only if you append ?ctx= to the webhook URL via a proxy).
    if ((!account_key || !String(account_key).trim()) && req.query?.ctx) {
      try {
        const secret = process.env.WIX_INSTALL_CTX_SECRET || process.env.WIX_CLIENT_SECRET;
        if (secret) {
          const p = jwt.verify(String(req.query.ctx), secret);
          if (p?.purpose === 'wix_install_return' && p?.account_key) {
            account_key = String(p.account_key).trim();
          }
        }
      } catch (_) {
        /* ignore invalid ctx */
      }
    }

    if (!instanceId || !String(instanceId).trim()) {
      return sendApiError(
        res,
        400,
        'Missing instanceId in decoded JWT (expected instanceId inside payload.data or metadata)'
      );
    }

    if (!account_key || !String(account_key).trim()) {
      const successLog = JSON.stringify({
        level: 'INFO',
        platform: 'wix',
        method: req.method,
        api: req.originalUrl || req.url,
        function: 'handleWixJwtBodyAsAppInstall',
        operation: 'Wix webhook JWT decoded; no account_key provided',
        account_key: 'unknown',
        result: { instance_id: String(instanceId).trim(), site_id: siteId ? String(siteId).trim() : null },
        timestamp: new Date().toISOString()
      });
      console.log(successLog);
      log('Success in handleWixJwtBodyAsAppInstall: %s', successLog);
      return res.status(200).json({
        success: true,
        message:
          'Webhook JWT decoded; instanceId available. Use GET /wix/oauth/start?account_key=… so the install redirect can complete with tokens, or pass account_key / x-account-key on the webhook request.',
        wix: {
          instance_id: String(instanceId).trim(),
          site_id: siteId ? String(siteId).trim() : null,
          app_id: appId ? String(appId).trim() : null,
          origin_instance_id: originInstanceId ? String(originInstanceId).trim() : null,
        },
      });
    }

    const { persistWixClientCredentialsConnection, maskSecret } = require('./wix-auth');
    const out = await persistWixClientCredentialsConnection(
      String(account_key).trim(),
      String(instanceId).trim(),
      siteId ? String(siteId).trim() : null,
      {
        app_id: appId ? String(appId).trim() : null,
        origin_instance_id: originInstanceId ? String(originInstanceId).trim() : null,
        installed_via: 'wix_webhook',
      }
    );

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'wix',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'handleWixJwtBodyAsAppInstall',
      operation: 'Wix app installed; access token minted and connection saved',
      account_key: String(account_key).trim(),
      result: { instance_id: out.instance_id, site_id: out.site_id },
      timestamp: new Date().toISOString()
    });
    console.log(successLog);
    log('Success in handleWixJwtBodyAsAppInstall: %s', successLog);
    return res.status(200).json({
      success: true,
      message: 'Wix app installed; access token minted and connection saved',
      wix: {
        instance_id: out.instance_id,
        site_id: out.site_id,
        app_id: appId ? String(appId).trim() : null,
        access_token: maskSecret(out.access_token),
        expires_at: out.expires_at,
      },
    });
  } catch (err) {
    const isWixError = err?.response?.config?.url?.includes('wixapis.com') || err?.config?.url?.includes('wixapis.com');
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'wix',
      source: isWixError ? 'wix_api' : (isFinerworksError ? 'finerworks_api' : 'lambda'),
      function: 'handleWixJwtBodyAsAppInstall',
      account_key: req.query?.account_key || req.query?.accountKey || req.headers['x-account-key'] || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to handle Wix JWT app install webhook: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.error || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in handleWixJwtBodyAsAppInstall: %s', errorJson);
    return sendApiError(res, err);
  }
};

const handleWixAppInstanceInstalled = handleWixJwtBodyAsAppInstall;

/**
 * Verifies a Wix webhook JWT against the app's public key (RS256) — the key shown on the app's
 * Webhooks page / "View ID & Keys" in Wix Dev Center. Unlike handleWixJwtBodyAsAppInstall (which
 * only decodes), this fails closed: no key configured, or a signature that doesn't check out,
 * both reject the request rather than trusting an unverified payload that would mutate Virtual
 * Inventory links.
 * https://dev.wix.com/docs/build-apps/develop-your-app/access/authentication/verify-requests-received-from-wix
 */
function verifyWixWebhookJwt(token) {
  const rawKey = process.env.WIX_WEBHOOK_PUBLIC_KEY;
  if (!rawKey || !rawKey.trim()) {
    const err = new Error('WIX_WEBHOOK_PUBLIC_KEY is not configured; cannot verify Wix webhook signature');
    err.statusCode = 500;
    throw err;
  }
  // PEM keys pasted into a single-line env var commonly have literal "\n" instead of newlines.
  const publicKey = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;

  try {
    return jwt.verify(token, publicKey, { algorithms: ['RS256'] });
  } catch (verifyErr) {
    const err = new Error(`Wix webhook signature verification failed: ${verifyErr.message}`);
    err.statusCode = 401;
    throw err;
  }
}

/** Every Wix Stores Catalog webhook (Product Created/Changed/Deleted) nests its event fields
 *  under `data` (possibly a JSON string) and the tenant's site under `metadata.accountInfo.siteId`
 *  — same nested/stringified shape handled by extractWixAppInstalledFields above. Returns the
 *  decoded `data` object and siteId; callers pull whatever event-specific fields they need
 *  (productId is common to all three, sku/changedFields vary by event). */
function extractWixEventFields(payload) {
  if (!payload || typeof payload !== 'object') return { outerData: {}, siteId: null };

  const outerData =
    parseMaybeJsonString(payload.data) || (typeof payload.data === 'object' ? payload.data : null) || {};
  const metadata =
    parseMaybeJsonString(payload.metadata) || (typeof payload.metadata === 'object' ? payload.metadata : null) || {};
  const accountInfo =
    metadata.accountInfo && typeof metadata.accountInfo === 'object'
      ? metadata.accountInfo
      : parseMaybeJsonString(metadata.accountInfo) || {};

  const productId = outerData.productId || payload.entityId || payload.productId || null;
  const siteId = accountInfo.siteId || metadata.siteId || outerData.siteId || payload.siteId || null;

  return { outerData: { ...outerData, productId }, siteId };
}

/**
 * Wix "Product Deleted" webhook receiver (Stores Catalog V1/V3 both fire this — see
 * originatedFromVersion in the payload). Clears this platform's link fields
 * (wix_product_id/wix_variant_id/wix_inventory_id) on whichever Virtual Inventory item(s) are
 * currently linked to the deleted product — same pattern as Shopify's products/delete receiver
 * (shopify-orders.js shopifyProductDeleteWebhook), generalized via
 * clearVirtualInventoryLinkByConnectionId.
 *
 * Requires: WIX_WEBHOOK_PUBLIC_KEY (for signature verification) and the wix-accounts DynamoDB
 * table populated by persistWixClientCredentialsConnection (for siteId -> account_key routing,
 * since this webhook URL is shared across every install, not per-account).
 */
const handleWixProductDeletedWebhook = async (req, res) => {
  let account_key = null;
  try {
    const raw =
      typeof req.body === 'string'
        ? req.body
        : Buffer.isBuffer(req.body)
          ? req.body.toString('utf8')
          : '';
    const token = String(raw || '').trim();
    if (!token) {
      return sendApiError(res, 400, 'Empty webhook body (expected JWT string)');
    }

    let payload;
    try {
      payload = verifyWixWebhookJwt(token);
    } catch (verifyErr) {
      log('Wix product-delete webhook verification failed: %s', verifyErr.message);
      return sendApiError(res, verifyErr.statusCode || 401, verifyErr.message);
    }

    const { outerData, siteId: rawSiteId } = extractWixEventFields(payload);
    const productId = outerData?.productId ? String(outerData.productId).trim() : null;
    const siteId = rawSiteId ? String(rawSiteId).trim() : null;

    if (!productId) {
      return sendApiError(res, 400, 'Missing productId in decoded Wix webhook payload');
    }
    if (!siteId) {
      return res.status(200).json({
        success: true,
        ignored: true,
        message: 'No siteId in webhook payload; cannot resolve tenant',
      });
    }

    const { findAccountKeyByWixSiteId } = require('../helpers/wix-accounts-dynamo');
    account_key = await findAccountKeyByWixSiteId(siteId);
    if (!account_key) {
      return res.status(200).json({
        success: true,
        ignored: true,
        message: 'Could not resolve account_key for this Wix site',
        site_id: siteId,
      });
    }

    const { clearVirtualInventoryLinkByConnectionId } = require('../helpers/virtual-inventory-links');
    const result = await clearVirtualInventoryLinkByConnectionId({
      source: 'wix',
      connectionId: productId,
      accountKey: account_key,
    });

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'wix',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'handleWixProductDeletedWebhook',
      operation: 'Wix product deleted; virtual inventory link cleared',
      account_key,
      result: { productId, clearedCount: result.count },
      timestamp: new Date().toISOString(),
    });
    console.log(successLog);
    log('Success in handleWixProductDeletedWebhook: %s', successLog);

    return res.status(200).json({
      success: true,
      account_key,
      productId,
      site_id: siteId,
      cleared: result.cleared,
    });
  } catch (err) {
    const isWixError = err?.response?.config?.url?.includes('wixapis.com') || err?.config?.url?.includes('wixapis.com');
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'wix',
      source: isWixError ? 'wix_api' : (isFinerworksError ? 'finerworks_api' : 'lambda'),
      function: 'handleWixProductDeletedWebhook',
      account_key: account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to handle Wix product-deleted webhook: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.error || null,
      timestamp: new Date().toISOString(),
    });
    console.error(errorJson);
    log('Formatted error in handleWixProductDeletedWebhook: %s', errorJson);
    return sendApiError(res, err);
  }
};

const WIX_VARIANTS_PAGE_LIMIT = 1000;
const WIX_MAX_VARIANT_PAGES_TO_SCAN = 20;

/**
 * Re-syncs one Wix product's current SKU(s) against Virtual Inventory — the shared resolver
 * behind both handleWixProductCreatedWebhook and handleWixProductChangedWebhook, since neither
 * webhook payload reliably carries the SKU itself: Product Created only includes it for
 * non-variant products ("If variants are being managed, this will be empty" per Wix's docs), and
 * Product Changed never includes it at all (just `changedFields`). Query Variants filtered by
 * productData.productId is the one Wix endpoint confirmed to support an exact filter on product
 * id (see check-link-for-external-source.js's checkWixSku notes on why sku-based filtering
 * doesn't work) — it's the real source of truth here, not the webhook body.
 *
 * For each of the product's current variant SKUs:
 *  - matches a Virtual Inventory item not yet linked to this product/variant -> write/move the
 *    link (covers a new listing created with a Virtual Inventory SKU, and a SKU edited on the
 *    platform to now match a different item).
 * For any Virtual Inventory item already linked to this productId whose own sku is no longer
 * among the product's current variant skus -> clear it (the SKU changed on the platform and no
 * longer matches what we had on file).
 */
async function resolveWixProductSync({ productId, siteId, fallbackSku }) {
  log('resolveWixProductSync start productId=%s siteId=%s fallbackSku=%s', productId, siteId, fallbackSku);
  console.log('[resolveWixProductSync] start', { productId, siteId, fallbackSku });

  const { findAccountKeyByWixSiteId } = require('../helpers/wix-accounts-dynamo');
  const account_key = await findAccountKeyByWixSiteId(siteId);
  log('resolveWixProductSync account_key lookup siteId=%s -> account_key=%s', siteId, account_key || 'NOT FOUND');
  console.log('[resolveWixProductSync] account_key lookup', { siteId, account_key: account_key || null });
  if (!account_key) {
    console.log('[resolveWixProductSync] ignored: no account_key for siteId', siteId);
    return { ignored: true, reason: 'Could not resolve account_key for this Wix site' };
  }

  const wixAuth = await resolveWixAuth({ account_key });
  log('resolveWixProductSync wixAuth resolved=%s authType=%s source=%s', Boolean(wixAuth?.accessToken), wixAuth?.authType, wixAuth?.source);
  console.log('[resolveWixProductSync] wixAuth', { hasAccessToken: Boolean(wixAuth?.accessToken), authType: wixAuth?.authType, source: wixAuth?.source });
  if (!wixAuth?.accessToken) {
    console.log('[resolveWixProductSync] ignored: could not resolve Wix access token for account_key', account_key);
    return { ignored: true, reason: 'Unable to resolve Wix access token for this account', account_key };
  }
  const headers = buildWixAuthHeaders(wixAuth);

  const variants = [];
  let cursor;
  for (let page = 0; page < WIX_MAX_VARIANT_PAGES_TO_SCAN; page++) {
    log('resolveWixProductSync query-variants page=%d productId=%s cursor=%s', page, productId, cursor || 'none');
    const r = await axios.post(
      'https://www.wixapis.com/stores/v3/products/query-variants',
      {
        fields: [],
        query: {
          filter: { 'productData.productId': { $eq: productId } },
          cursorPaging: { limit: WIX_VARIANTS_PAGE_LIMIT, cursor },
        },
      },
      { headers, timeout: 30000, validateStatus: () => true }
    );
    console.log('[resolveWixProductSync] query-variants response', {
      page,
      status: r.status,
      variantCount: Array.isArray(r.data?.variants) ? r.data.variants.length : 0,
    });
    if (r.status < 200 || r.status >= 300) {
      log('resolveWixProductSync query-variants FAILED page=%d status=%d', page, r.status);
      const err = new Error('Wix variant lookup failed');
      err.response = { status: r.status, data: r.data };
      throw err;
    }
    variants.push(...(Array.isArray(r.data?.variants) ? r.data.variants : []));
    cursor = r.data?.pagingMetadata?.cursors?.next;
    if (!r.data?.pagingMetadata?.hasNext || !cursor) break;
  }
  log('resolveWixProductSync total variants fetched=%d productId=%s', variants.length, productId);

  const currentSkus = variants
    .map((v) => ({
      variantId: v?.variantId || v?._id || null,
      sku: v?.sku != null ? String(v.sku).trim() : null,
    }))
    .filter((v) => v.sku);

  // Simple (non-variant) products don't show up in query-variants — fall back to the sku the
  // Product Created payload gave us directly, when there is one.
  if (!currentSkus.length && fallbackSku) {
    log('resolveWixProductSync no variants found, using fallbackSku=%s', fallbackSku);
    currentSkus.push({ variantId: null, sku: String(fallbackSku).trim() });
  }
  console.log('[resolveWixProductSync] currentSkus resolved', currentSkus);

  const listResp = await finerworksService.LIST_VIRTUAL_INVENTORY({ account_key });
  const allVI = Array.isArray(listResp?.products) ? listResp.products : [];
  log('resolveWixProductSync Virtual Inventory list account_key=%s count=%d', account_key, allVI.length);
  console.log('[resolveWixProductSync] Virtual Inventory list', { account_key, count: allVI.length });

  const viBySku = new Map();
  for (const p of allVI) {
    if (p?.sku) viBySku.set(String(p.sku).trim().toLowerCase(), p);
  }

  const currentSkuSet = new Set(currentSkus.map((v) => v.sku.toLowerCase()));
  const linked = [];
  const relinked = [];
  const clearedStale = [];

  const linkedToThisProduct = allVI.filter(
    (p) => String(p?.third_party_integrations?.wix_product_id || '') === String(productId)
  );
  log('resolveWixProductSync VI items already linked to productId=%s count=%d', productId, linkedToThisProduct.length);
  for (const p of linkedToThisProduct) {
    if (!currentSkuSet.has(String(p.sku).trim().toLowerCase())) {
      log('resolveWixProductSync clearing stale link sku=%s (no longer matches any current variant sku)', p.sku);
      console.log('[resolveWixProductSync] clearing stale link', { sku: p.sku, productId });
      await clearVirtualInventoryLinkForProduct({ source: 'wix', product: p, accountKey: account_key });
      clearedStale.push(p.sku);
    }
  }

  for (const v of currentSkus) {
    const viMatch = viBySku.get(v.sku.toLowerCase());
    if (!viMatch) {
      log('resolveWixProductSync no Virtual Inventory match for sku=%s', v.sku);
      continue;
    }

    const integrations = viMatch.third_party_integrations || {};
    const alreadyCorrect =
      String(integrations.wix_product_id || '') === String(productId) &&
      String(integrations.wix_variant_id || '') === String(v.variantId || '');
    if (alreadyCorrect) {
      log('resolveWixProductSync sku=%s already correctly linked to productId=%s variantId=%s', v.sku, productId, v.variantId);
      continue;
    }

    const wasLinkedElsewhere = Boolean(integrations.wix_product_id);
    log(
      'resolveWixProductSync %s sku=%s -> productId=%s variantId=%s (previous wix_product_id=%s)',
      wasLinkedElsewhere ? 'RE-LINKING' : 'LINKING',
      v.sku,
      productId,
      v.variantId,
      integrations.wix_product_id || 'none'
    );
    console.log('[resolveWixProductSync] writing link', {
      sku: v.sku,
      productId,
      variantId: v.variantId,
      wasLinkedElsewhere,
    });
    await writeVirtualInventoryLink({
      source: 'wix',
      product: viMatch,
      ids: { wix_product_id: productId, wix_variant_id: v.variantId },
      accountKey: account_key,
    });
    (wasLinkedElsewhere ? relinked : linked).push(viMatch.sku);
  }

  log(
    'resolveWixProductSync done productId=%s checked=%d linked=%d relinked=%d clearedStale=%d',
    productId,
    currentSkus.length,
    linked.length,
    relinked.length,
    clearedStale.length
  );
  console.log('[resolveWixProductSync] done', {
    productId,
    checked: currentSkus.length,
    linked,
    relinked,
    clearedStale,
  });

  return { account_key, checked: currentSkus.length, linked, relinked, clearedStale };
}

/** Shared body for the Product Created / Product Changed receivers — same envelope, same
 *  resolver, differing only in which webhook fired (used for logging) and whether the payload
 *  carries a fallback sku (Created only). */
async function handleWixProductSyncWebhook(req, res, { eventLabel, functionName }) {
  let account_key = null;
  try {
    log('%s webhook hit method=%s url=%s', functionName, req.method, req.originalUrl || req.url);
    console.log(`[${functionName}] webhook received`, {
      eventLabel,
      headers: { 'content-type': req.headers['content-type'] },
      bodyType: typeof req.body,
      bodyLength: typeof req.body === 'string' ? req.body.length : Buffer.isBuffer(req.body) ? req.body.length : null,
    });

    const raw =
      typeof req.body === 'string'
        ? req.body
        : Buffer.isBuffer(req.body)
          ? req.body.toString('utf8')
          : '';
    const token = String(raw || '').trim();
    log('%s raw token length=%d', functionName, token.length);
    if (!token) {
      console.log(`[${functionName}] empty body — nothing to verify`);
      return sendApiError(res, 400, 'Empty webhook body (expected JWT string)');
    }

    let payload;
    try {
      payload = verifyWixWebhookJwt(token);
      log('%s JWT verified OK', functionName);
      console.log(`[${functionName}] JWT verified`, { payloadKeys: Object.keys(payload || {}) });
    } catch (verifyErr) {
      log('Wix %s webhook verification failed: %s', eventLabel, verifyErr.message);
      console.log(`[${functionName}] JWT verification FAILED`, { message: verifyErr.message, statusCode: verifyErr.statusCode });
      return sendApiError(res, verifyErr.statusCode || 401, verifyErr.message);
    }

    const { outerData, siteId: rawSiteId } = extractWixEventFields(payload);
    const productId = outerData?.productId ? String(outerData.productId).trim() : null;
    const siteId = rawSiteId ? String(rawSiteId).trim() : null;
    const fallbackSku = outerData?.sku != null ? String(outerData.sku).trim() : null;

    log('%s decoded productId=%s siteId=%s fallbackSku=%s', functionName, productId, siteId, fallbackSku);
    console.log(`[${functionName}] decoded fields`, { productId, siteId, fallbackSku, outerData });

    if (!productId) {
      console.log(`[${functionName}] rejecting: missing productId`);
      return sendApiError(res, 400, 'Missing productId in decoded Wix webhook payload');
    }
    if (!siteId) {
      console.log(`[${functionName}] ignoring: missing siteId`);
      return res.status(200).json({
        success: true,
        ignored: true,
        message: 'No siteId in webhook payload; cannot resolve tenant',
      });
    }

    log('%s calling resolveWixProductSync productId=%s siteId=%s', functionName, productId, siteId);
    const result = await resolveWixProductSync({ productId, siteId, fallbackSku: fallbackSku || null });
    account_key = result.account_key || null;
    log('%s resolveWixProductSync returned ignored=%s account_key=%s', functionName, Boolean(result.ignored), account_key || 'none');

    if (result.ignored) {
      console.log(`[${functionName}] ignored`, { reason: result.reason, productId, siteId });
      return res.status(200).json({ success: true, ignored: true, message: result.reason });
    }

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'wix',
      method: req.method,
      api: req.originalUrl || req.url,
      function: functionName,
      operation: `Wix ${eventLabel}; virtual inventory sync completed`,
      account_key,
      result: {
        productId,
        checked: result.checked,
        linkedCount: result.linked.length,
        relinkedCount: result.relinked.length,
        clearedStaleCount: result.clearedStale.length,
      },
      timestamp: new Date().toISOString(),
    });
    console.log(successLog);
    log('Success in %s: %s', functionName, successLog);

    return res.status(200).json({
      success: true,
      event: eventLabel,
      productId,
      site_id: siteId,
      account_key,
      checked: result.checked,
      linked: result.linked,
      relinked: result.relinked,
      clearedStale: result.clearedStale,
    });
  } catch (err) {
    const isWixError = err?.response?.config?.url?.includes('wixapis.com') || err?.config?.url?.includes('wixapis.com');
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'wix',
      source: isWixError ? 'wix_api' : (isFinerworksError ? 'finerworks_api' : 'lambda'),
      function: functionName,
      account_key: account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to handle Wix ${eventLabel} webhook: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.error || null,
      timestamp: new Date().toISOString(),
    });
    console.error(errorJson);
    log('Formatted error in %s: %s', functionName, errorJson);
    return sendApiError(res, err);
  }
}

/** Wix "Product Created" webhook receiver — see handleWixProductSyncWebhook / resolveWixProductSync. */
const handleWixProductCreatedWebhook = (req, res) =>
  handleWixProductSyncWebhook(req, res, {
    eventLabel: 'product created',
    functionName: 'handleWixProductCreatedWebhook',
  });

/** Wix "Product Changed" (update) webhook receiver — see handleWixProductSyncWebhook / resolveWixProductSync. */
const handleWixProductChangedWebhook = (req, res) =>
  handleWixProductSyncWebhook(req, res, {
    eventLabel: 'product changed',
    functionName: 'handleWixProductChangedWebhook',
  });

module.exports = {
  handleWixAppInstanceInstalled,
  handleWixJwtBodyAsAppInstall,
  handleWixProductDeletedWebhook,
  handleWixProductCreatedWebhook,
  handleWixProductChangedWebhook,
};