const axios = require('axios');
const finerworksService = require('../helpers/finerworks-service');
const { handleWixJwtBodyAsAppInstall } = require('./wix-webhooks');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const debug = require('debug');
const { sendApiError, safeWixErrorData } = require('../helpers/api-error');
const log = debug('app:wix-auth');

function maskSecret(s) {
  const str = String(s || '');
  if (str.length <= 10) return '***';
  return `${str.slice(0, 6)}***${str.slice(-4)}`;
}

function base64UrlDecode(input) {
  const b64 = String(input || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  return Buffer.from(b64 + pad, 'base64').toString('utf8');
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

function jwtPayloadDecode(token) {
  // Decodes JWT payload WITHOUT verifying signature.
  // This is useful for extracting instanceId/siteId from Wix `instance` query param.
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const pad = payloadB64.length % 4 === 0 ? '' : '='.repeat(4 - (payloadB64.length % 4));
  const json = Buffer.from(payloadB64 + pad, 'base64').toString('utf8');
  return safeJsonParse(json);
}

const buildWixRedirectUri = () => {
  // Keep redirect_uri consistent between initiate + callback.
  return 'https://d7z22w3j4h.execute-api.us-east-1.amazonaws.com/Prod/api/wix/oauth/callback';
};

/**
 * Browser redirect after install (GET). Must match Wix Dev Center **exactly** (path only, no ?query):
 * e.g. https://xxx.execute-api.region.amazonaws.com/Prod/api/wix/oauth/install-return
 */
const buildWixInstallReturnUri = (_req) => {
  const fromEnv =
    process.env.WIX_INSTALL_RETURN_URL && String(process.env.WIX_INSTALL_RETURN_URL).trim();
  if (fromEnv) return fromEnv.split('?')[0].replace(/\/$/, '');
  return String(buildWixRedirectUri()).replace(
    /\/wix\/oauth\/callback\/?$/i,
    '/wix/oauth/install-return'
  );
};

/**
 * Returns (or redirects to) the Wix app install link.
 *
 * For new Wix Apps, avoid legacy custom-auth redirects. Instead:
 * - user installs your Wix app on their site (via an install link from Wix Dev Center)
 * - you capture `instanceId` for that site (e.g. from an extension URL query param or webhook)
 * - your server mints access tokens using client_credentials (client_id + client_secret + instance_id)
 *
 * Query:
 * - account_key (optional): accepted for symmetry with Squarespace; not used here.
 * - mode (optional): "redirect" (default) or "json"
 */
const getWixInstallLink = async (req, res) => {
  const mode = String(req.query?.mode || 'redirect').toLowerCase();
  const installUrl = process.env.WIX_INSTALL_URL;
  if (!installUrl || !String(installUrl).trim()) {
    return sendApiError(
      res,
      500,
      'WIX_INSTALL_URL not configured. Create/share an install link for your Wix App in Wix Dev Center (Distribution) and set it as WIX_INSTALL_URL.'
    );
  }

  if (mode === 'json') {
    return res.status(200).json({ success: true, installUrl: String(installUrl).trim() });
  }
  return res.redirect(String(installUrl).trim());
};

/**
 * Connect Wix using the `instance` (JWT) or `instanceId` query param Wix adds to extension URLs.
 *
 * This is the modern, non-legacy way to "connect a site":
 * - store instance_id (and best-effort site_id) in tenant connections
 * - actual access tokens are minted later using client_credentials when needed
 *
 * Query/body:
 * - account_key (required)
 * - instance (optional): Wix "app instance" token (JWT)
 * - instanceId (optional): raw instance id (if you already extracted it)
 * - siteId (optional): raw site id (if you already extracted it)
 * - return_url (optional): redirect to this URL with ?success=1
 */
const connectWixFromInstance = async (req, res) => {
  try {
    const account_key =
      req.query?.account_key ||
      req.query?.accountKey ||
      req.body?.account_key ||
      req.body?.accountKey;

    if (!account_key || !String(account_key).trim()) {
      return sendApiError(res, 400, 'Missing required parameter: account_key');
    }

    const instanceToken = req.query?.instance || req.body?.instance || null;
    const instanceIdRaw =
      req.query?.instanceId ||
      req.query?.instance_id ||
      req.body?.instanceId ||
      req.body?.instance_id ||
      null;
    const siteIdRaw =
      req.query?.siteId || req.query?.site_id || req.body?.siteId || req.body?.site_id || null;

    let instance_id = instanceIdRaw ? String(instanceIdRaw).trim() : '';
    let site_id = siteIdRaw ? String(siteIdRaw).trim() : '';

    if ((!instance_id || !site_id) && instanceToken) {
      const payload = jwtPayloadDecode(instanceToken);
      // Payload keys vary; we try common ones.
      if (!instance_id)
        instance_id = String(
          payload?.instanceId || payload?.instance_id || payload?.inst || ''
        ).trim();
      if (!site_id)
        site_id = String(payload?.siteId || payload?.site_id || payload?.metaSiteId || '').trim();
    }

    if (!instance_id) {
      return sendApiError(
        res,
        400,
        'Missing Wix instance id. Provide `instanceId` or provide `instance` (JWT) so the server can extract instanceId.'
      );
    }

    // Persist the site binding (instance id) even if we don't yet have a minted access token.
    // Keep `id` as-is if Wix connection exists, else store empty string.
    const getInformation = await finerworksService.GET_INFO({
      account_key: String(account_key).trim(),
    });
    const connections = Array.isArray(getInformation?.user_account?.connections)
      ? JSON.parse(JSON.stringify(getInformation.user_account.connections))
      : [];
    const idx = connections.findIndex((c) => c && c.name === 'Wix');
    const existing = idx !== -1 ? connections[idx] : null;
    let existingData = {};
    try {
      existingData = existing?.data
        ? typeof existing.data === 'string'
          ? JSON.parse(existing.data)
          : existing.data
        : {};
    } catch (_) {
      existingData = {};
    }

    const nextData = {
      ...existingData,
      auth_type: 'oauth_client_credentials',
      instance_id,
      site_id: site_id || existingData?.site_id || null,
      instance_token_present: Boolean(instanceToken),
      connected_at: new Date().toISOString(),
    };

    const conn = {
      name: 'Wix',
      id: existing?.id || '',
      data: JSON.stringify(nextData),
    };
    if (idx !== -1) connections[idx] = conn;
    else connections.push(conn);

    await finerworksService.UPDATE_INFO({
      account_key: String(account_key).trim(),
      connections,
    });

    const return_url = req.query?.return_url || req.body?.return_url || null;
    if (return_url) {
      const sep = String(return_url).includes('?') ? '&' : '?';
      return res.redirect(`${return_url}${sep}success=1`);
    }

    return res.status(200).json({
      success: true,
      message: 'Wix instance connected successfully',
      wix: {
        instance_id,
        site_id: nextData.site_id || null,
      },
    });
  } catch (err) {
    return sendApiError(res, err);
  }
};

async function upsertWixConnection({ account_key, id, data }) {
  const getInformation = await finerworksService.GET_INFO({
    account_key: String(account_key).trim(),
  });
  const connections = Array.isArray(getInformation?.user_account?.connections)
    ? JSON.parse(JSON.stringify(getInformation.user_account.connections))
    : [];

  const idx = connections.findIndex((c) => c && c.name === 'Wix');
  const conn = {
    name: 'Wix',
    id,
    data: JSON.stringify(data || {}),
  };

  if (idx !== -1) connections[idx] = conn;
  else connections.push(conn);

  await finerworksService.UPDATE_INFO({
    account_key: String(account_key).trim(),
    connections,
  });

  return conn;
}

async function createWixAccessTokenFromInstance({ instance_id }) {
  const clientId = process.env.WIX_CLIENT_ID;
  const clientSecret = process.env.WIX_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const err = new Error(
      'Wix App OAuth not configured. For Wix Apps (site-level access), Wix requires WIX_CLIENT_ID + WIX_CLIENT_SECRET and an instance_id for the target site. ' +
        'If you only have a clientId, that typically refers to Wix Headless visitor OAuth, which is a different flow and does not grant site owner/store management access.'
    );
    err.statusCode = 500;
    throw err;
  }
  if (!instance_id || !String(instance_id).trim()) {
    const err = new Error('Missing required parameter: instance_id');
    err.statusCode = 400;
    throw err;
  }

  const resp = await axios.post(
    'https://www.wixapis.com/oauth2/token',
    {
      grant_type: 'client_credentials',
      client_id: String(clientId).trim(),
      client_secret: String(clientSecret).trim(),
      instance_id: String(instance_id).trim(),
    },
    { timeout: 20000 }
  );

  return resp?.data || {};
}

async function persistWixClientCredentialsConnection(
  account_key,
  instance_id,
  site_id,
  extraData = null
) {
  const tokenData = await createWixAccessTokenFromInstance({ instance_id });
  const access_token = tokenData?.access_token;
  const expires_in = tokenData?.expires_in;
  if (!access_token) {
    const err = new Error('Token creation succeeded but access_token missing');
    err.statusCode = 400;
    err.tokenData = tokenData;
    throw err;
  }
  const now = Date.now();
  const expires_at = Number.isFinite(Number(expires_in))
    ? new Date(now + Number(expires_in) * 1000).toISOString()
    : null;
  const baseData = {
    auth_type: 'oauth_client_credentials',
    instance_id: String(instance_id).trim(),
    site_id: site_id ? String(site_id).trim() : null,
    access_token,
    expires_in: expires_in ?? null,
    expires_at,
    connected_at: new Date().toISOString(),
  };
  await upsertWixConnection({
    account_key: String(account_key).trim(),
    id: access_token,
    data: extraData && typeof extraData === 'object' ? { ...baseData, ...extraData } : baseData,
  });
  return {
    access_token,
    expires_at,
    instance_id: String(instance_id).trim(),
    site_id: site_id ? String(site_id).trim() : null,
  };
}

async function exchangeWixAuthorizationCode({ code }) {
  const clientId = process.env.WIX_CLIENT_ID;
  const clientSecret = process.env.WIX_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const err = new Error('WIX_CLIENT_ID / WIX_CLIENT_SECRET not configured');
    err.statusCode = 500;
    throw err;
  }
  if (!code || !String(code).trim()) {
    const err = new Error('Missing required parameter: code');
    err.statusCode = 400;
    throw err;
  }

  // Custom authentication (legacy). Only works for apps that already use it in Wix.
  const resp = await axios.post(
    'https://www.wixapis.com/oauth/access',
    {
      grant_type: 'authorization_code',
      client_id: String(clientId).trim(),
      client_secret: String(clientSecret).trim(),
      code: String(code).trim(),
    },
    { timeout: 20000 }
  );
  return resp?.data || {};
}

/**
 * Starts external Wix app install and returns users to GET /wix/oauth/install-return.
 *
 * Modern Wix apps use **OAuth client credentials** (App ID + secret + `instance_id`); the OAuth page in
 * Dev Center often shows **only keys** — there is **no Redirect URL field**, and that is expected.
 *
 * Use the **external install** URL documented by Wix (not legacy `installer/install?redirectUrl=…`, which
 * requires a pre-registered redirect and causes "couldn't find an app with this redirect url"):
 * `https://www.wix.com/app-installer?appId=…&postInstallationUrl=…`
 * The callback may include query params (e.g. signed `state`); Wix preserves them and appends
 * `instanceId`, `tenantId`, `appId`.
 *
 * Query:
 * - account_key (required)
 * - return_url (optional): stored inside signed `state` JWT for post-install redirect
 */
const handleWixAuthStart = async (req, res) => {
  try {
    log('handleWixAuthStart==========>>>>>>>>>>>', req.query);
    const account_key =
      req.query?.account_key ||
      req.query?.accountKey ||
      req.body?.account_key ||
      req.body?.accountKey;

    if (!account_key || !String(account_key).trim()) {
      return sendApiError(res, 400, 'Missing required parameter: account_key');
    }

    const clientId = process.env.WIX_CLIENT_ID;
    if (!clientId) {
      return sendApiError(res, 500, 'WIX_CLIENT_ID not configured');
    }

    const ctxSecret = process.env.WIX_INSTALL_CTX_SECRET || process.env.WIX_CLIENT_SECRET;
    if (!ctxSecret || !String(ctxSecret).trim()) {
      return sendApiError(
        res,
        500,
        'Set WIX_CLIENT_SECRET or WIX_INSTALL_CTX_SECRET to sign install `state` (carries account_key).'
      );
    }

    const nonce = crypto.randomBytes(16).toString('hex');
    const return_url = req.query?.return_url || req.body?.return_url || "https://fa.finerworks.com/";

    const state = jwt.sign(
      {
        purpose: 'wix_install_return',
        account_key: String(account_key).trim(),
        nonce,
        ...(return_url ? { return_url: String(return_url).trim() } : {}),
      },
      String(ctxSecret).trim(),
      { expiresIn: '24h' }
    );

    const installReturnBase = buildWixInstallReturnUri(req);
    const sep = installReturnBase.includes('?') ? '&' : '?';
    const postInstallationUrl = `${installReturnBase}${sep}state=${encodeURIComponent(state)}`;

    const legacy = String(process.env.WIX_LEGACY_INSTALLER || '').trim() === '1';
    const installerBase =
      process.env.WIX_INSTALLER_BASE_URL ||
      (legacy ? 'https://www.wix.com/installer/install' : 'https://www.wix.com/app-installer');

    let installUrl;
    if (legacy) {
      const qs = new URLSearchParams({
        appId: String(clientId).trim(),
        redirectUrl: installReturnBase,
        state,
      });
      installUrl = `${installerBase}?${qs.toString()}`;
    } else {
      installUrl = `${installerBase}?appId=${encodeURIComponent(String(clientId).trim())}&postInstallationUrl=${encodeURIComponent(postInstallationUrl)}`;
    }

    log('installUrl==========>>>>>>>>>>>', installUrl);
    console.log('installUrl==========>>>>>>>>>>>', installUrl);
    return res.redirect(installUrl);
  } catch (err) {
    return sendApiError(res, err);
  }
};

/**
 * Creates/persists a Wix "connection" for a tenant using API Key auth.
 *
 * Wix API-key auth uses headers:
 * - Authorization: <API_KEY>
 * - wix-site-id: <SITE_ID>   (site-level APIs)
 *
 * Expected body/query:
 * - account_key (required)
 *
 * Env:
 * - WIX_API_KEY (required)
 * - WIX_SITE_ID (required)
 */
const connectWix = async (req, res) => {
  try {
    const account_key =
      req.body?.account_key ||
      req.body?.accountKey ||
      req.query?.account_key ||
      req.query?.accountKey;

    if (!account_key || !String(account_key).trim()) {
      return sendApiError(res, 400, 'Missing required parameter: account_key');
    }

    const apiKey = process.env.WIX_API_KEY;
    const siteId = process.env.WIX_SITE_ID;

    if (!apiKey || !siteId) {
      return sendApiError(res, 500, 'Wix credentials not configured (WIX_API_KEY, WIX_SITE_ID)');
    }

    // Lightweight validation call (site-level).
    // Prefer Wix's own docs example endpoint for API-key auth.
    // If permissions are missing, Wix typically returns 403 with a message like:
    // "Unauthorized to perform <permission> on site <siteId>"
    const wixHeaders = {
      Authorization: String(apiKey).trim(),
      'wix-site-id': String(siteId).trim(),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
    };

    const validateResp = await axios.post(
      // Catalog V3 compatible endpoint (many Wix sites are now V3).
      'https://www.wixapis.com/stores/v3/products/query',
      { query: { paging: { limit: 1 } } },
      {
        headers: wixHeaders,
        timeout: 20000,
        validateStatus: () => true,
      }
    );

    if (validateResp.status < 200 || validateResp.status >= 300) {
      const wixMsg = validateResp?.data?.message;
      const permissionMatch =
        typeof wixMsg === 'string' ? wixMsg.match(/perform\s+([a-z0-9.-_]+)\s+on\s+site/i) : null;
      const requiredPermission = permissionMatch?.[1] || null;
      return sendApiError(
        res,
        validateResp.status || 401,
        requiredPermission
          ? `Wix API key is valid, but missing permission: ${requiredPermission}. Enable it in Wix API Keys Manager for this key.`
          : 'Failed to validate Wix API key/site id',
        safeWixErrorData({
          httpStatus: validateResp.status,
          httpStatusText: validateResp.statusText,
          message:
            typeof validateResp?.data?.message === 'string'
              ? validateResp.data.message
              : undefined,
        })
      );
    }

    const getInformation = await finerworksService.GET_INFO({
      account_key: String(account_key).trim(),
    });
    const connections = Array.isArray(getInformation?.user_account?.connections)
      ? JSON.parse(JSON.stringify(getInformation.user_account.connections))
      : [];

    const idx = connections.findIndex((c) => c && c.name === 'Wix');
    const conn = {
      name: 'Wix',
      // Keep the existing pattern: `id` stores the "access token"
      id: String(apiKey).trim(),
      data: JSON.stringify({
        access_token: String(apiKey).trim(),
        site_id: String(siteId).trim(),
        connected_at: new Date().toISOString(),
        auth_type: 'api_key',
        // Persist a small bit of verified info for debugging (non-secret).
        validation: {
          endpoint: 'POST https://www.wixapis.com/stores/v3/products/query',
          status: validateResp.status,
          sample: validateResp?.data || null,
        },
      }),
    };

    if (idx !== -1) connections[idx] = conn;
    else connections.push(conn);

    await finerworksService.UPDATE_INFO({
      account_key: String(account_key).trim(),
      connections,
    });

    return res.status(200).json({
      success: true,
      message: 'Wix connection added successfully',
      wix: {
        site_id: String(siteId).trim(),
        access_token: maskSecret(apiKey),
      },
    });
  } catch (err) {
    return sendApiError(res, err);
  }
};

/**
 * OAuth connect (recommended by Wix): uses OAuth Client Credentials.
 *
 * Caller must provide `instance_id` (app instance id for the target Wix site).
 * This is how the same app can connect to many stores/sites.
 *
 * Body/query:
 * - account_key (required)
 * - instance_id (required)
 * - site_id (optional, stored as metadata if provided)
 */
const connectWixOAuth = async (req, res) => {
  try {
    const account_key =
      req.body?.account_key ||
      req.body?.accountKey ||
      req.query?.account_key ||
      req.query?.accountKey;

    const instance_id =
      req.body?.instance_id ||
      req.body?.instanceId ||
      req.query?.instance_id ||
      req.query?.instanceId;

    const site_id =
      req.body?.site_id || req.body?.siteId || req.query?.site_id || req.query?.siteId || null;

    if (!account_key || !String(account_key).trim()) {
      return sendApiError(res, 400, 'Missing required parameter: account_key');
    }
    if (!instance_id || !String(instance_id).trim()) {
      return sendApiError(res, 400, 'Missing required parameter: instance_id');
    }

    const out = await persistWixClientCredentialsConnection(
      String(account_key).trim(),
      String(instance_id).trim(),
      site_id ? String(site_id).trim() : null
    );

    return res.status(200).json({
      success: true,
      message: 'Wix OAuth connection added successfully',
      wix: {
        instance_id: out.instance_id,
        site_id: out.site_id,
        access_token: maskSecret(out.access_token),
        expires_at: out.expires_at,
      },
    });
  } catch (err) {
    return sendApiError(res, err);
  }
};

/**
 * GET /wix/oauth/install-return — after install, Wix redirects here with the same **state** we sent
 * (signed JWT with account_key) plus **instance** / ids. Optional legacy **ctx** query still supported.
 */
const handleWixOAuthInstallReturn = async (req, res) => {
  try {
    const secret = process.env.WIX_INSTALL_CTX_SECRET || process.env.WIX_CLIENT_SECRET;
    log('handleWixOAuthInstallReturn==========>>>>>>>>>>>', req.query);
    if (!secret || !String(secret).trim()) {
      return sendApiError(
        res,
        500,
        'Set WIX_INSTALL_CTX_SECRET or WIX_CLIENT_SECRET to verify install state.'
      );
    }

    let account_key = null;
    let return_url_from_state = null;

    const ctx = req.query?.ctx;
    if (ctx) {
      try {
        const ctxPayload = jwt.verify(String(ctx), String(secret).trim());
        if (ctxPayload?.purpose === 'wix_install_return' && ctxPayload?.account_key) {
          account_key = String(ctxPayload.account_key).trim();
          if (ctxPayload.return_url) return_url_from_state = String(ctxPayload.return_url).trim();
        }
      } catch (_) {
        /* fall through to state */
      }
    }

    const stateQ = req.query?.state;
    if (!account_key && stateQ) {
      try {
        const sp = jwt.verify(String(stateQ), String(secret).trim());
        if (sp?.purpose === 'wix_install_return' && sp?.account_key) {
          account_key = String(sp.account_key).trim();
          if (sp.return_url) return_url_from_state = String(sp.return_url).trim();
        }
      } catch (_) {
        try {
          const stateObj = JSON.parse(base64UrlDecode(String(stateQ)));
          if (stateObj?.account_key) account_key = String(stateObj.account_key).trim();
        } catch (__) {
          /* ignore */
        }
      }
    }

    if (!account_key) {
      return sendApiError(
        res,
        400,
        'Missing install context. Start from GET /wix/oauth/start?account_key=... (Wix must return `state` on this redirect).'
      );
    }
    const instanceToken = req.query?.instance || null;
    const instanceIdRaw = req.query?.instanceId || req.query?.instance_id;
    let instance_id = instanceIdRaw ? String(instanceIdRaw).trim() : '';
    let site_id = (req.query?.siteId || req.query?.site_id || '').trim() || null;

    if (!instance_id && instanceToken) {
      const instPayload = jwtPayloadDecode(instanceToken);
      if (!instance_id) {
        instance_id = String(
          instPayload?.instanceId || instPayload?.instance_id || instPayload?.inst || ''
        ).trim();
      }
      if (!site_id) {
        site_id =
          String(
            instPayload?.siteId || instPayload?.site_id || instPayload?.metaSiteId || ''
          ).trim() || null;
      }
    }

    if (!instance_id) {
      return sendApiError(
        res,
        400,
        'Missing Wix instance. Wix should redirect with `instance` or `instanceId` after install. If not, open the installed app from the site dashboard or use the App installed webhook plus POST /wix/oauth/connect.'
      );
    }

    await persistWixClientCredentialsConnection(account_key, instance_id, site_id);

    const return_url = req.query?.return_url || return_url_from_state;
    if (return_url) {
      const sep = String(return_url).includes('?') ? '&' : '?';
      return res.redirect(`${return_url}${sep}success=1`);
    }

    return res.status(200).json({
      success: true,
      message: 'Wix connected after install redirect',
    });
  } catch (err) {
    return sendApiError(res, err);
  }
};

/**
 * POST /wix/oauth/callback — two shapes:
 *
 * 1) Wix **App installed** (and similar) webhooks: body is a **raw JWT** string. Register this URL in
 *    Wix Dev Center → Webhooks. Must run behind `express.text` before `express.json` (see app.js).
 *
 * 2) **Custom auth (legacy)** redirect callback: query `code` + `state` (no JWT body required).
 */
const handleWixOAuthCallback = async (req, res) => {
  try {
    log('handleWixOAuthCallback', req.query);
    log('handleWixOAuthCallback body type', typeof req.body);

    const code = req.query?.code;
    const state = req.query?.state;
    const return_url = req.query?.return_url;
    const oauthError = req.query?.error;

    if (oauthError) {
      return sendApiError(res, 400, String(oauthError));
    }

    const rawBody =
      typeof req.body === 'string'
        ? req.body.trim()
        : Buffer.isBuffer(req.body)
          ? req.body.toString('utf8').trim()
          : '';
    const looksLikeJwt = rawBody.length > 0 && rawBody.split('.').length >= 3;

    // Wix app lifecycle webhooks (e.g. App installed) POST a JWT; legacy OAuth uses code+state.
    if (looksLikeJwt && !(code && state)) {
      return handleWixJwtBodyAsAppInstall(req, res);
    }

    if (!code || !state) {
      return sendApiError(
        res,
        400,
        'Missing OAuth query params code and state, and body is not a Wix JWT. For App installed, POST a JWT body (or use legacy ?code=&state=).'
      );
    }

    let stateObj = null;
    try {
      stateObj = JSON.parse(base64UrlDecode(state));
    } catch (_) {
      return sendApiError(res, 400, 'Invalid state');
    }
    const account_key = stateObj?.account_key;
    if (!account_key) {
      return sendApiError(res, 400, 'Invalid state: missing account_key');
    }

    const tokenData = await exchangeWixAuthorizationCode({ code });
    if (!tokenData?.access_token) {
      return sendApiError(res, 400, 'Token exchange succeeded but access_token missing');
    }

    await upsertWixConnection({
      account_key: String(account_key).trim(),
      id: tokenData.access_token,
      data: {
        ...tokenData,
        auth_type: 'custom_auth_legacy',
        state_nonce: stateObj?.nonce || null,
        connected_at: new Date().toISOString(),
      },
    });

    if (return_url) {
      const sep = String(return_url).includes('?') ? '&' : '?';
      return res.redirect(`${return_url}${sep}success=1`);
    }

    return res.status(200).json({ success: true, message: 'Wix connection added successfully' });
  } catch (err) {
    return sendApiError(res, err);
  }
};

module.exports = {
  connectWix,
  handleWixAuthStart,
  connectWixOAuth,
  handleWixOAuthCallback,
  handleWixOAuthInstallReturn,
  persistWixClientCredentialsConnection,
  maskSecret,
  getWixInstallLink,
  connectWixFromInstance,
};
