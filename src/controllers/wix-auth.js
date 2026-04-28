const axios = require('axios');
const finerworksService = require('../helpers/finerworks-service');
const crypto = require('crypto');

function maskSecret(s) {
  const str = String(s || '');
  if (str.length <= 10) return '***';
  return `${str.slice(0, 6)}***${str.slice(-4)}`;
}

function base64UrlEncode(input) {
  const b64 = Buffer.from(String(input), 'utf8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(input) {
  const b64 = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  return Buffer.from(b64 + pad, 'base64').toString('utf8');
}

function normalizeBearer(token) {
  const t = String(token || '').trim();
  if (!t) return '';
  return /^Bearer\s+/i.test(t) ? t : `Bearer ${t}`;
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

const getApiBaseUrl = (req) => (req.baseUrl ? req.baseUrl : '/api');

const buildWixRedirectUri = (req) => {
  // Keep redirect_uri consistent between initiate + callback.
  return (
    process.env.WIX_REDIRECT_URI ||
    `${req.protocol}://${req.get('host')}${getApiBaseUrl(req)}/wix/oauth/callback`
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
    return res.status(500).json({
      success: false,
      message:
        'WIX_INSTALL_URL not configured. Create/share an install link for your Wix App in Wix Dev Center (Distribution) and set it as WIX_INSTALL_URL.'
    });
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
      return res.status(400).json({ success: false, message: 'Missing required parameter: account_key' });
    }

    const instanceToken = req.query?.instance || req.body?.instance || null;
    const instanceIdRaw =
      req.query?.instanceId ||
      req.query?.instance_id ||
      req.body?.instanceId ||
      req.body?.instance_id ||
      null;
    const siteIdRaw =
      req.query?.siteId ||
      req.query?.site_id ||
      req.body?.siteId ||
      req.body?.site_id ||
      null;

    let instance_id = instanceIdRaw ? String(instanceIdRaw).trim() : '';
    let site_id = siteIdRaw ? String(siteIdRaw).trim() : '';

    if ((!instance_id || !site_id) && instanceToken) {
      const payload = jwtPayloadDecode(instanceToken);
      // Payload keys vary; we try common ones.
      if (!instance_id) instance_id = String(payload?.instanceId || payload?.instance_id || payload?.inst || '').trim();
      if (!site_id) site_id = String(payload?.siteId || payload?.site_id || payload?.metaSiteId || '').trim();
    }

    if (!instance_id) {
      return res.status(400).json({
        success: false,
        message:
          'Missing Wix instance id. Provide `instanceId` or provide `instance` (JWT) so the server can extract instanceId.'
      });
    }

    // Persist the site binding (instance id) even if we don't yet have a minted access token.
    // Keep `id` as-is if Wix connection exists, else store empty string.
    const getInformation = await finerworksService.GET_INFO({ account_key: String(account_key).trim() });
    const connections = Array.isArray(getInformation?.user_account?.connections)
      ? JSON.parse(JSON.stringify(getInformation.user_account.connections))
      : [];
    const idx = connections.findIndex((c) => c && c.name === 'Wix');
    const existing = idx !== -1 ? connections[idx] : null;
    let existingData = {};
    try {
      existingData = existing?.data ? (typeof existing.data === 'string' ? JSON.parse(existing.data) : existing.data) : {};
    } catch (_) {
      existingData = {};
    }

    const nextData = {
      ...existingData,
      auth_type: 'oauth_client_credentials',
      instance_id,
      site_id: site_id || existingData?.site_id || null,
      instance_token_present: Boolean(instanceToken),
      connected_at: new Date().toISOString()
    };

    const conn = {
      name: 'Wix',
      id: existing?.id || '',
      data: JSON.stringify(nextData)
    };
    if (idx !== -1) connections[idx] = conn;
    else connections.push(conn);

    await finerworksService.UPDATE_INFO({
      account_key: String(account_key).trim(),
      connections
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
        site_id: nextData.site_id || null
      }
    });
  } catch (err) {
    const status = err?.response?.status || 500;
    return res.status(status).json({
      success: false,
      message: 'Failed to connect Wix from instance',
      error: err?.response?.data || err?.message || 'Unknown error'
    });
  }
};

async function upsertWixConnection({ account_key, id, data }) {
  const getInformation = await finerworksService.GET_INFO({ account_key: String(account_key).trim() });
  const connections = Array.isArray(getInformation?.user_account?.connections)
    ? JSON.parse(JSON.stringify(getInformation.user_account.connections))
    : [];

  const idx = connections.findIndex((c) => c && c.name === 'Wix');
  const conn = {
    name: 'Wix',
    id,
    data: JSON.stringify(data || {})
  };

  if (idx !== -1) connections[idx] = conn;
  else connections.push(conn);

  await finerworksService.UPDATE_INFO({
    account_key: String(account_key).trim(),
    connections
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
      instance_id: String(instance_id).trim()
    },
    { timeout: 20000 }
  );

  return resp?.data || {};
}

/**
 * Wix Headless visitor tokens (clientId-only).
 *
 * Important: These tokens are for acting "on behalf of a site visitor" in headless contexts.
 * They are NOT the same as Wix App site-level tokens (instance_id + client_secret) used to manage a site's store.
 *
 * Body/query:
 * - clientId (optional; defaults to WIX_CLIENT_ID)
 * - grantType (optional; "anonymous" or "refresh_token")
 * - refreshToken (required when grantType=refresh_token)
 */
const getWixHeadlessVisitorTokens = async (req, res) => {
  try {
    const clientId =
      req.body?.clientId ||
      req.body?.client_id ||
      req.query?.clientId ||
      req.query?.client_id ||
      process.env.WIX_CLIENT_ID;

    const grantType =
      req.body?.grantType ||
      req.body?.grant_type ||
      req.query?.grantType ||
      req.query?.grant_type ||
      'anonymous';

    const refreshToken =
      req.body?.refreshToken ||
      req.body?.refresh_token ||
      req.query?.refreshToken ||
      req.query?.refresh_token ||
      null;

    if (!clientId || !String(clientId).trim()) {
      return res.status(400).json({ success: false, message: 'Missing required parameter: clientId' });
    }

    if (String(grantType) === 'refresh_token' && (!refreshToken || !String(refreshToken).trim())) {
      return res.status(400).json({ success: false, message: 'Missing required parameter: refreshToken' });
    }

    const payload = {
      clientId: String(clientId).trim(),
      grantType: String(grantType).trim()
    };
    if (String(grantType) === 'refresh_token') payload.refreshToken = String(refreshToken).trim();

    const resp = await axios.post('https://www.wixapis.com/oauth2/token', payload, {
      timeout: 20000,
      headers: { 'Content-Type': 'application/json' }
    });

    return res.status(200).json({
      success: true,
      tokens: resp?.data || {}
    });
  } catch (err) {
    const status = err?.response?.status || 500;
    return res.status(status).json({
      success: false,
      message: 'Failed to retrieve Wix Headless visitor tokens',
      error: err?.response?.data || err?.message || 'Unknown error'
    });
  }
};

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
      code: String(code).trim()
    },
    { timeout: 20000 }
  );
  return resp?.data || {};
}

/**
 * Initiates Wix install/auth flow (custom authentication legacy).
 *
 * Mirrors the Squarespace /auth endpoint behavior:
 * - UI hits this endpoint with `account_key`
 * - we generate `state` that embeds account_key + nonce
 * - we redirect to Wix install URL
 *
 * Notes:
 * - This flow only works for Wix apps that already have "custom authentication (legacy)" enabled.
 * - For modern Wix Apps, prefer storing instance_id via install webhook and minting tokens via client_credentials.
 *
 * Query:
 * - account_key (required)
 * - return_url (optional): appended to callback as `return_url`
 */
const handleWixAuthStart = async (req, res) => {
  try {
    const account_key =
      req.query?.account_key ||
      req.query?.accountKey ||
      req.body?.account_key ||
      req.body?.accountKey;

    if (!account_key || !String(account_key).trim()) {
      return res.status(400).json({ success: false, message: 'Missing required parameter: account_key' });
    }

    const clientId = process.env.WIX_CLIENT_ID;
    if (!clientId) {
      return res.status(500).json({ success: false, message: 'WIX_CLIENT_ID not configured' });
    }

    const nonce = crypto.randomBytes(16).toString('hex');
    const state = base64UrlEncode(JSON.stringify({ account_key: String(account_key).trim(), nonce }));

    const redirectUrl = buildWixRedirectUri(req);

    // Default Wix install URL pattern used by AppStrategy.getInstallUrl().
    const installerBase = process.env.WIX_INSTALLER_BASE_URL || 'https://www.wix.com/installer/install';
    const qs = new URLSearchParams({
      appId: String(clientId).trim(),
      redirectUrl,
      state
    });

    const return_url = req.query?.return_url || req.body?.return_url || null;
    if (return_url) {
      // We can't control what Wix sends back besides our redirectUrl.
      // So we include return_url into our own redirectUrl via query param.
      const redirectWithReturn = `${redirectUrl}${redirectUrl.includes('?') ? '&' : '?'}return_url=${encodeURIComponent(
        String(return_url)
      )}`;
      qs.set('redirectUrl', redirectWithReturn);
    }

    const installUrl = `${installerBase}?${qs.toString()}`;
    return res.redirect(installUrl);
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Failed to initiate Wix auth',
      error: err?.message || 'Unknown error'
    });
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
      return res.status(400).json({
        success: false,
        message: 'Missing required parameter: account_key'
      });
    }

    const apiKey = process.env.WIX_API_KEY;
    const siteId = process.env.WIX_SITE_ID;

    if (!apiKey || !siteId) {
      return res.status(500).json({
        success: false,
        message: 'Wix credentials not configured (WIX_API_KEY, WIX_SITE_ID)'
      });
    }

    // Lightweight validation call (site-level).
    // Prefer Wix's own docs example endpoint for API-key auth.
    // If permissions are missing, Wix typically returns 403 with a message like:
    // "Unauthorized to perform <permission> on site <siteId>"
    const wixHeaders = {
      Authorization: String(apiKey).trim(),
      'wix-site-id': String(siteId).trim(),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*'
    };

    const validateResp = await axios.post(
      // Catalog V3 compatible endpoint (many Wix sites are now V3).
      'https://www.wixapis.com/stores/v3/products/query',
      { query: { paging: { limit: 1 } } },
      {
        headers: wixHeaders,
        timeout: 20000,
        validateStatus: () => true
      }
    );

    if (validateResp.status < 200 || validateResp.status >= 300) {
      const wixMsg = validateResp?.data?.message;
      const permissionMatch = typeof wixMsg === 'string' ? wixMsg.match(/perform\s+([a-z0-9.-_]+)\s+on\s+site/i) : null;
      const requiredPermission = permissionMatch?.[1] || null;
      return res.status(validateResp.status || 401).json({
        success: false,
        message: requiredPermission
          ? `Wix API key is valid, but missing permission: ${requiredPermission}. Enable it in Wix API Keys Manager for this key.`
          : 'Failed to validate Wix API key/site id',
        status: validateResp.status,
        requiredPermission,
        wixError: validateResp.data
      });
    }

    const getInformation = await finerworksService.GET_INFO({ account_key: String(account_key).trim() });
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
          sample: validateResp?.data || null
        }
      })
    };

    if (idx !== -1) connections[idx] = conn;
    else connections.push(conn);

    await finerworksService.UPDATE_INFO({
      account_key: String(account_key).trim(),
      connections
    });

    return res.status(200).json({
      success: true,
      message: 'Wix connection added successfully',
      wix: {
        site_id: String(siteId).trim(),
        access_token: maskSecret(apiKey)
      }
    });
  } catch (err) {
    const status = err?.response?.status || 500;
    return res.status(status).json({
      success: false,
      message: 'Failed to connect Wix',
      error: err?.response?.data || err?.message || 'Unknown error'
    });
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
      req.body?.site_id ||
      req.body?.siteId ||
      req.query?.site_id ||
      req.query?.siteId ||
      null;

    if (!account_key || !String(account_key).trim()) {
      return res.status(400).json({ success: false, message: 'Missing required parameter: account_key' });
    }
    if (!instance_id || !String(instance_id).trim()) {
      return res.status(400).json({ success: false, message: 'Missing required parameter: instance_id' });
    }

    const tokenData = await createWixAccessTokenFromInstance({ instance_id });
    const access_token = tokenData?.access_token;
    const expires_in = tokenData?.expires_in;

    if (!access_token) {
      return res.status(400).json({
        success: false,
        message: 'Token creation succeeded but access_token missing',
        data: tokenData
      });
    }

    const now = Date.now();
    const expires_at = Number.isFinite(Number(expires_in)) ? new Date(now + Number(expires_in) * 1000).toISOString() : null;

    await upsertWixConnection({
      account_key: String(account_key).trim(),
      id: access_token,
      data: {
        auth_type: 'oauth_client_credentials',
        instance_id: String(instance_id).trim(),
        site_id: site_id ? String(site_id).trim() : null,
        access_token,
        expires_in: expires_in ?? null,
        expires_at,
        connected_at: new Date().toISOString()
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Wix OAuth connection added successfully',
      wix: {
        instance_id: String(instance_id).trim(),
        site_id: site_id ? String(site_id).trim() : null,
        access_token: maskSecret(access_token),
        expires_at
      }
    });
  } catch (err) {
    const status = err?.statusCode || err?.response?.status || 500;
    return res.status(status).json({
      success: false,
      message: 'Failed to connect Wix via OAuth',
      error: err?.response?.data || err?.message || 'Unknown error'
    });
  }
};

/**
 * Custom auth (legacy) callback-style handler.
 *
 * Query:
 * - code (required)
 * - state (required): base64url JSON containing { account_key, nonce }
 * - return_url (optional): redirect to this URL with ?success=1 on success
 */
const handleWixOAuthCallback = async (req, res) => {
  try {
    const code = req.query?.code;
    const state = req.query?.state;
    const return_url = req.query?.return_url;
    const error = req.query?.error;

    if (error) {
      return res.status(400).json({ success: false, message: String(error) });
    }
    if (!code || !state) {
      return res.status(400).json({ success: false, message: 'Missing required parameters: code, state' });
    }

    let stateObj = null;
    try {
      stateObj = JSON.parse(base64UrlDecode(state));
    } catch (_) {
      return res.status(400).json({ success: false, message: 'Invalid state' });
    }
    const account_key = stateObj?.account_key;
    if (!account_key) {
      return res.status(400).json({ success: false, message: 'Invalid state: missing account_key' });
    }

    const tokenData = await exchangeWixAuthorizationCode({ code });
    if (!tokenData?.access_token) {
      return res.status(400).json({
        success: false,
        message: 'Token exchange succeeded but access_token missing',
        data: tokenData
      });
    }

    await upsertWixConnection({
      account_key: String(account_key).trim(),
      id: tokenData.access_token,
      data: {
        ...tokenData,
        auth_type: 'custom_auth_legacy',
        state_nonce: stateObj?.nonce || null,
        connected_at: new Date().toISOString()
      }
    });

    if (return_url) {
      const sep = String(return_url).includes('?') ? '&' : '?';
      return res.redirect(`${return_url}${sep}success=1`);
    }

    return res.status(200).json({ success: true, message: 'Wix connection added successfully' });
  } catch (err) {
    const status = err?.statusCode || err?.response?.status || 500;
    return res.status(status).json({
      success: false,
      message: 'Failed to process Wix OAuth callback',
      error: err?.response?.data || err?.message || 'Unknown error'
    });
  }
};

/**
 * Helper endpoint to generate a Wix `state` value for (legacy) consent flows.
 * This does not start an OAuth redirect by itself because Wix consent URLs are configured
 * within Wix app installation (for legacy custom auth).
 *
 * Query/body:
 * - account_key (required)
 */
const getWixOAuthState = async (req, res) => {
  const account_key = req.query?.account_key || req.body?.account_key || req.query?.accountKey || req.body?.accountKey;
  if (!account_key || !String(account_key).trim()) {
    return res.status(400).json({ success: false, message: 'Missing required parameter: account_key' });
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  const state = base64UrlEncode(JSON.stringify({ account_key: String(account_key).trim(), nonce }));
  return res.status(200).json({ success: true, state });
};

module.exports = {
  connectWix,
  handleWixAuthStart,
  connectWixOAuth,
  handleWixOAuthCallback,
  getWixOAuthState,
  getWixHeadlessVisitorTokens,
  getWixInstallLink,
  connectWixFromInstance
};

