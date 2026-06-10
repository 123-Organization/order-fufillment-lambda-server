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
    return sendApiError(res, err);
  }
};

const handleWixAppInstanceInstalled = handleWixJwtBodyAsAppInstall;

module.exports = {
  handleWixAppInstanceInstalled,
  handleWixJwtBodyAsAppInstall,
};
