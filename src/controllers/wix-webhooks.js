const jwt = require('jsonwebtoken');
const { sendApiError } = require('../helpers/api-error');
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

/** Wix's Product Deleted payload nests productId under `data` (possibly a JSON string) and the
 *  tenant's site under `metadata.accountInfo.siteId` — same nested/stringified shape handled by
 *  extractWixAppInstalledFields above. */
function extractWixProductDeletedFields(payload) {
  if (!payload || typeof payload !== 'object') return null;

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

  return { productId, siteId };
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

    const extracted = extractWixProductDeletedFields(payload);
    const productId = extracted?.productId ? String(extracted.productId).trim() : null;
    const siteId = extracted?.siteId ? String(extracted.siteId).trim() : null;

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

module.exports = {
  handleWixAppInstanceInstalled,
  handleWixJwtBodyAsAppInstall,
  handleWixProductDeletedWebhook,
};