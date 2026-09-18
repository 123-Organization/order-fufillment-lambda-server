const axios = require('axios');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const finerworksService = require('../helpers/finerworks-service');
const debug = require('debug');
const { sendApiError } = require('../helpers/api-error');
const { logIncomingRequest, redactAndTruncate } = require('../helpers/request-log');
const log = debug('app:bigcommerceAuth');
require('dotenv').config();

const BIGCOMMERCE_LOGIN_BASE = 'https://login.bigcommerce.com';
const BIGCOMMERCE_API_BASE = 'https://api.bigcommerce.com';
const INSTALL_CTX_COOKIE = 'bc_install_ctx';

const getBigcommerceClientId = () => process.env.BIGCOMMERCE_CLIENT_ID;
const getBigcommerceClientSecret = () => process.env.BIGCOMMERCE_CLIENT_SECRET;
const getInstallCtxSecret = () => process.env.BIGCOMMERCE_INSTALL_CTX_SECRET || getBigcommerceClientSecret();

const getApiBaseUrl = (req) => (req.baseUrl ? req.baseUrl : '/api');

/** Auth Callback URL — must match exactly what's registered for this app in the BigCommerce Dev Portal. */
const buildRedirectUri = (req) =>
  process.env.BIGCOMMERCE_REDIRECT_URI ||
  `${req.protocol}://${req.get('host')}${getApiBaseUrl(req)}/bigcommerce/auth-callback`;

/** Minimal cookie helpers — avoids pulling in cookie-parser for a single short-lived cookie. */
function serializeCookie(name, value, { maxAgeSeconds }) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;
  const match = header
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${name}=`));
  if (!match) return null;
  return decodeURIComponent(match.slice(name.length + 1));
}

const bigcommerceErrorDetail = (err) => {
  const data = err?.response?.data;
  if (!data) return null;
  if (typeof data === 'string') return data.trim().slice(0, 500) || null;
  return (data.title || data.message || data.error || null);
};

/**
 * Initiates connecting a merchant's BigCommerce store to OFA.
 *
 * BigCommerce's install flow doesn't support carrying our own state through to the Auth
 * Callback the way Square/Shopify's `state` query param does: the external install URL
 * (login.bigcommerce.com/app/{client_id}/install) has no parameter slot for it, and the Auth
 * Callback URL itself is a single fixed URL registered once in the Dev Portal — not something
 * we can vary per install attempt the way Wix's postInstallationUrl works.
 *
 * So instead we set a short-lived, signed, HttpOnly cookie carrying account_key before
 * redirecting. It's scoped to our own domain, so it survives the round trip through
 * BigCommerce and back, and the Auth Callback reads it to know which OFA account this
 * install belongs to.
 *
 * Expected query: account_key (required), return_url (optional).
 */
const handleBigcommerceAuthStart = async (req, res) => {
  try {
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'handleBigcommerceAuthStart',
      accountKey: req.query?.account_key || req.body?.account_key,
      body: req.body,
      query: req.query,
    });

    const account_key = req.query?.account_key || req.body?.account_key;
    if (!account_key || !String(account_key).trim()) {
      log('handleBigcommerceAuthStart rejected: missing account_key');
      return sendApiError(res, 400, 'Missing required parameter: account_key');
    }

    const clientId = getBigcommerceClientId();
    if (!clientId) {
      log('handleBigcommerceAuthStart rejected: BIGCOMMERCE_CLIENT_ID not configured');
      return sendApiError(res, 500, 'BIGCOMMERCE_CLIENT_ID not configured');
    }
    const ctxSecret = getInstallCtxSecret();
    if (!ctxSecret) {
      log('handleBigcommerceAuthStart rejected: no install-context secret configured');
      return sendApiError(
        res,
        500,
        'Set BIGCOMMERCE_CLIENT_SECRET or BIGCOMMERCE_INSTALL_CTX_SECRET to sign the install context.'
      );
    }

    const nonce = crypto.randomBytes(16).toString('hex');
    const return_url = req.query?.return_url || req.body?.return_url || 'https://fa.finerworks.com/';
    log(
      'handleBigcommerceAuthStart: building install context account_key=%s nonce=%s return_url=%s',
      String(account_key).trim(),
      nonce,
      return_url
    );

    const ctx = jwt.sign(
      {
        purpose: 'bigcommerce_install',
        account_key: String(account_key).trim(),
        nonce,
        return_url: String(return_url).trim(),
      },
      ctxSecret,
      { expiresIn: '15m' }
    );
    log('handleBigcommerceAuthStart: install-context JWT signed (expires in 15m)');

    res.setHeader('Set-Cookie', serializeCookie(INSTALL_CTX_COOKIE, ctx, { maxAgeSeconds: 900 }));
    log('handleBigcommerceAuthStart: set %s cookie (Max-Age=900s)', INSTALL_CTX_COOKIE);

    const installUrl = `${BIGCOMMERCE_LOGIN_BASE}/app/${encodeURIComponent(clientId)}/install`;
    log('handleBigcommerceAuthStart: redirecting to %s', installUrl);

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'bigcommerce',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'handleBigcommerceAuthStart',
      operation: 'BigCommerce install redirect sent successfully',
      account_key: String(account_key).trim(),
      result: { installUrl, nonce },
      timestamp: new Date().toISOString(),
    });
    console.log(successLog);
    log('Success in handleBigcommerceAuthStart: %s', successLog);

    return res.redirect(installUrl);
  } catch (err) {
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'bigcommerce',
      source: 'lambda',
      function: 'handleBigcommerceAuthStart',
      account_key: req.query?.account_key || req.body?.account_key || 'unknown',
      message: `BigCommerce install initiation failed: ${err?.message || 'Unknown error'}`,
      stack: err?.stack ? String(err.stack).split('\n').slice(0, 5).join(' | ') : null,
      timestamp: new Date().toISOString(),
    });
    console.error(errorJson);
    log('Formatted error in handleBigcommerceAuthStart: %s', errorJson);
    return sendApiError(res, err);
  }
};

/**
 * Auth Callback — register this exact URL in the Dev Portal (Technical tab, "Auth Callback URL").
 * BigCommerce GETs this after the merchant approves the install, with `code`, `scope`,
 * `context` (stores/{store_hash}), and `account_uuid`. Exchanges the code for an access token
 * and saves the connection under whichever OFA account the install-context cookie identifies.
 */
/**
 * Saves (or replaces) the BigCommerce connection entry for an OFA account_key in FinerWorks.
 * Same shape as the Square/Squarespace connection save — pulled into its own function just to
 * keep the Auth Callback below readable.
 */
async function saveBigcommerceConnection({ account_key, store_hash, access_token, scope, account_uuid, user, owner }) {
  log('saveBigcommerceConnection: fetching existing FinerWorks connections for account_key=%s', account_key);
  const getInformation = await finerworksService.GET_INFO({ account_key });
  const connections = Array.isArray(getInformation?.user_account?.connections)
    ? JSON.parse(JSON.stringify(getInformation.user_account.connections))
    : [];
  const idx = connections.findIndex((c) => c && c.name === 'BigCommerce');
  log('saveBigcommerceConnection: existing connections=%d, %s BigCommerce entry', connections.length, idx !== -1 ? 'replacing' : 'adding');
  const nextConnection = {
    name: 'BigCommerce',
    // Keep the same pattern as Square/Shopify/Squarespace: id stores the access token.
    id: access_token,
    data: JSON.stringify({
      access_token,
      store_hash,
      scope: scope || null,
      account_uuid: account_uuid || null,
      user: user || null,
      owner: owner || null,
      connected_at: new Date().toISOString(),
    }),
  };
  if (idx !== -1) connections[idx] = nextConnection;
  else connections.push(nextConnection);

  log('saveBigcommerceConnection: saving connection to FinerWorks account_key=%s store_hash=%s', account_key, store_hash);
  await finerworksService.UPDATE_INFO({ account_key, connections });
  log('saveBigcommerceConnection: FinerWorks connection saved successfully account_key=%s', account_key);
}

/** POST https://login.bigcommerce.com/oauth2/token — exchanges an install code for a token. */
async function exchangeBigcommerceCode({ code, scope, context, redirectUri }) {
  const clientId = getBigcommerceClientId();
  const clientSecret = getBigcommerceClientSecret();
  if (!clientId || !clientSecret) {
    const err = new Error('BigCommerce OAuth credentials not configured');
    err.statusCode = 500;
    throw err;
  }
  const tokenResp = await axios.post(
    `${BIGCOMMERCE_LOGIN_BASE}/oauth2/token`,
    {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      context,
      scope,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
  );
  log(
    'exchangeBigcommerceCode: token exchange responded status=%s access_token_present=%s scope=%s',
    tokenResp?.status,
    Boolean(tokenResp?.data?.access_token),
    tokenResp?.data?.scope || 'none'
  );
  return tokenResp?.data;
}

const handleBigcommerceAuthCallback = async (req, res) => {
  let account_key = null;
  try {
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'handleBigcommerceAuthCallback',
      accountKey: null, // not known yet — recovered from the install-context cookie below
      body: req.body,
      query: req.query,
    });

    const { code, scope, context, account_uuid, external_install } = req.query || {};
    log(
      'handleBigcommerceAuthCallback: received code_present=%s scope=%s context=%s account_uuid=%s external_install=%s',
      Boolean(code),
      scope || 'none',
      context || 'none',
      account_uuid || 'none',
      external_install || 'none'
    );
    if (!code || !context) {
      log('handleBigcommerceAuthCallback rejected: missing code or context');
      return sendApiError(res, 400, 'Missing required parameters: code, context');
    }

    const ctxSecret = getInstallCtxSecret();
    const rawCtx = readCookie(req, INSTALL_CTX_COOKIE);
    log('handleBigcommerceAuthCallback: install-context cookie present=%s', Boolean(rawCtx));
    let return_url = null;
    if (rawCtx && ctxSecret) {
      try {
        const payload = jwt.verify(rawCtx, ctxSecret);
        if (payload?.purpose === 'bigcommerce_install' && payload?.account_key) {
          account_key = String(payload.account_key).trim();
          return_url = payload.return_url || null;
          log(
            'handleBigcommerceAuthCallback: install-context verified account_key=%s nonce=%s',
            account_key,
            payload.nonce || 'unknown'
          );
        } else {
          log('handleBigcommerceAuthCallback: install-context verified but missing purpose/account_key claim');
        }
      } catch (verifyErr) {
        log('handleBigcommerceAuthCallback: install-context verification failed: %s', verifyErr?.message);
        // Falls through to the missing-context error below.
      }
    }

    if (!account_key) {
      log('handleBigcommerceAuthCallback rejected: no account_key recovered from install context');
      return sendApiError(
        res,
        400,
        'Missing install context. Start the connection from GET /bigcommerce/auth?account_key=... inside OFA rather than installing directly from BigCommerce.'
      );
    }

    const redirectUri = buildRedirectUri(req);
    log(
      'handleBigcommerceAuthCallback: exchanging code for token account_key=%s context=%s redirect_uri=%s',
      account_key,
      context,
      redirectUri
    );
    const tokenData = await exchangeBigcommerceCode({ code, scope, context, redirectUri });
    if (!tokenData?.access_token) {
      log('handleBigcommerceAuthCallback rejected: token exchange succeeded but access_token missing account_key=%s', account_key);
      return sendApiError(res, 400, 'Token exchange succeeded but access_token missing');
    }

    const store_hash = String(context).replace(/^stores\//, '');
    log('handleBigcommerceAuthCallback: resolved store_hash=%s account_key=%s', store_hash, account_key);

    await saveBigcommerceConnection({
      account_key,
      store_hash,
      access_token: tokenData.access_token,
      scope: tokenData.scope || scope || null,
      account_uuid: tokenData.account_uuid || account_uuid || null,
      user: tokenData.user || null,
      owner: tokenData.owner || null,
    });

    // Consumed — clear it so a retry doesn't reuse a stale context.
    res.setHeader('Set-Cookie', serializeCookie(INSTALL_CTX_COOKIE, '', { maxAgeSeconds: 0 }));
    log('handleBigcommerceAuthCallback: cleared %s cookie', INSTALL_CTX_COOKIE);

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'bigcommerce',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'handleBigcommerceAuthCallback',
      operation: 'BigCommerce OAuth callback handled and connection saved successfully',
      account_key,
      result: { store_hash, scope: tokenData.scope || scope || null, redirected: Boolean(return_url) },
      timestamp: new Date().toISOString(),
    });
    console.log(successLog);
    log('Success in handleBigcommerceAuthCallback: %s', successLog);

    if (return_url) {
      const sep = String(return_url).includes('?') ? '&' : '?';
      log('handleBigcommerceAuthCallback: redirecting to return_url=%s', return_url);
      return res.redirect(`${return_url}${sep}success=1`);
    }
    return res.status(200).json({
      success: true,
      message: 'BigCommerce connection added successfully',
      store_hash,
    });
  } catch (err) {
    const isBigcommerceError =
      err?.response?.config?.url?.includes('bigcommerce.com') || err?.config?.url?.includes('bigcommerce.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'bigcommerce',
      source: isBigcommerceError ? 'bigcommerce_api' : 'lambda',
      function: 'handleBigcommerceAuthCallback',
      account_key: account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `BigCommerce OAuth callback failed: ${err?.message || 'Unknown error'}`,
      detail: bigcommerceErrorDetail(err),
      responseBody: err?.response?.data ? redactAndTruncate(err.response.data, 1000) : null,
      stack: err?.stack ? String(err.stack).split('\n').slice(0, 5).join(' | ') : null,
      timestamp: new Date().toISOString(),
    });
    console.error(errorJson);
    log('Formatted error in handleBigcommerceAuthCallback: %s', errorJson);
    return sendApiError(res, err);
  }
};

/**
 * Load Callback — register this URL in the Dev Portal too ("Load Callback URL"). BigCommerce
 * GETs this whenever a merchant opens the already-installed app from their control panel, with
 * a `signed_payload_jwt` (HS256, signed with the app's client secret; `sub` is `stores/{hash}`).
 * OFA has no server-rendered app UI to hand back here, so this just verifies the signature and
 * acknowledges it, which is what BigCommerce's app spec requires this endpoint to do at minimum.
 */
const handleBigcommerceLoadCallback = async (req, res) => {
  try {
    const signed = req.query?.signed_payload_jwt;
    if (!signed) {
      return sendApiError(res, 400, 'Missing required parameter: signed_payload_jwt');
    }
    const clientSecret = getBigcommerceClientSecret();
    if (!clientSecret) {
      return sendApiError(res, 500, 'BIGCOMMERCE_CLIENT_SECRET not configured');
    }
    const payload = jwt.verify(signed, clientSecret, { algorithms: ['HS256'] });
    const store_hash = String(payload?.sub || '').replace(/^stores\//, '');

    log('BigCommerce load callback for store_hash %s', store_hash);
    return res.status(200).json({ success: true, store_hash });
  } catch (err) {
    log('handleBigcommerceLoadCallback rejected: %s', err?.message);
    return sendApiError(res, 400, 'Invalid signed_payload_jwt');
  }
};

/**
 * Uninstall Callback — register this URL in the Dev Portal too ("Uninstall Callback URL").
 * Same signed_payload_jwt shape as the Load Callback. Verifies the signature and logs the
 * event. Doesn't auto-clear the FinerWorks connection: connections are stored per OFA
 * account_key, and there's no store_hash-to-account_key index to reverse-lookup which
 * account this store belonged to. Use POST /bigcommerce/disconnect with the account_key for
 * that — worth building a proper index later if automatic cleanup on uninstall matters.
 */
const handleBigcommerceUninstallCallback = async (req, res) => {
  try {
    const signed = req.query?.signed_payload_jwt;
    if (!signed) {
      return sendApiError(res, 400, 'Missing required parameter: signed_payload_jwt');
    }
    const clientSecret = getBigcommerceClientSecret();
    if (!clientSecret) {
      return sendApiError(res, 500, 'BIGCOMMERCE_CLIENT_SECRET not configured');
    }
    const payload = jwt.verify(signed, clientSecret, { algorithms: ['HS256'] });
    const store_hash = String(payload?.sub || '').replace(/^stores\//, '');

    console.warn(
      JSON.stringify({
        level: 'WARN',
        platform: 'bigcommerce',
        function: 'handleBigcommerceUninstallCallback',
        message: 'BigCommerce app uninstalled — connection not auto-cleared (no store_hash-to-account_key index)',
        result: { store_hash },
        timestamp: new Date().toISOString(),
      })
    );

    return res.status(200).json({ success: true, store_hash });
  } catch (err) {
    log('handleBigcommerceUninstallCallback rejected: %s', err?.message);
    return sendApiError(res, 400, 'Invalid signed_payload_jwt');
  }
};

/**
 * Reads the saved BigCommerce connection (access_token + store_hash) for an OFA account_key.
 * Shared by anything that needs to call the BigCommerce Management API on a merchant's behalf
 * (product sync, order fetch, webhook registration, etc.).
 */
async function getBigcommerceConnection(account_key) {
  const getInformation = await finerworksService.GET_INFO({ account_key });
  const connections = getInformation?.user_account?.connections;
  if (!Array.isArray(connections)) return null;
  const conn = connections.find((c) => c && c.name === 'BigCommerce');
  if (!conn) return null;

  let data = {};
  if (typeof conn.data === 'string') {
    try {
      data = JSON.parse(conn.data);
    } catch (_e) {
      data = {};
    }
  } else if (conn.data && typeof conn.data === 'object') {
    data = conn.data;
  }

  const access_token = data.access_token || conn.id || null;
  const store_hash = data.store_hash || null;
  if (!access_token || !store_hash) return null;

  return { access_token, store_hash, scope: data.scope || null };
}

/** Headers BigCommerce's Management API expects — not standard Bearer auth. */
function bigcommerceAuthHeaders({ access_token }) {
  return {
    'X-Auth-Client': getBigcommerceClientId(),
    'X-Auth-Token': access_token,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/**
 * Explicit, account_key-driven disconnect (mirrors handleSquareDisconnect) — clears the
 * BigCommerce connection from FinerWorks. There's no token-revoke call to BigCommerce here
 * (uninstalling the app from BigCommerce's own control panel is what actually invalidates the
 * token on their side); this just clears our side of the connection.
 * Expects body/query: { account_key }.
 */
const handleBigcommerceDisconnect = async (req, res) => {
  try {
    const account_key = req.body?.account_key || req.query?.account_key;
    if (!account_key) {
      return sendApiError(res, 400, 'Missing required parameter: account_key');
    }

    const getInformation = await finerworksService.GET_INFO({ account_key });
    const connections = JSON.parse(JSON.stringify(getInformation?.user_account?.connections || []));
    const idx = connections.findIndex((c) => c && c.name === 'BigCommerce');

    if (idx === -1) {
      return res.status(200).json({
        success: true,
        message: 'No BigCommerce connection found; nothing to disconnect',
        connections,
      });
    }

    connections[idx] = { name: 'BigCommerce', id: null, data: null };
    await finerworksService.UPDATE_INFO({ account_key, connections });

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'bigcommerce',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'handleBigcommerceDisconnect',
      operation: 'BigCommerce disconnected successfully',
      account_key,
      result: { disconnected: true },
      timestamp: new Date().toISOString(),
    });
    console.log(successLog);
    log('Success in handleBigcommerceDisconnect: %s', successLog);

    return res.status(200).json({
      success: true,
      message: 'BigCommerce disconnected successfully',
      connections,
    });
  } catch (err) {
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'bigcommerce',
      source: 'finerworks_api',
      function: 'handleBigcommerceDisconnect',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `BigCommerce disconnect failed: ${err?.message || 'Unknown error'}`,
      timestamp: new Date().toISOString(),
    });
    console.error(errorJson);
    log('Formatted error in handleBigcommerceDisconnect: %s', errorJson);
    return sendApiError(res, err);
  }
};

module.exports = {
  handleBigcommerceAuthStart,
  handleBigcommerceAuthCallback,
  handleBigcommerceLoadCallback,
  handleBigcommerceUninstallCallback,
  handleBigcommerceDisconnect,
  getBigcommerceConnection,
  bigcommerceAuthHeaders,
  getBigcommerceClientId,
  getBigcommerceClientSecret,
  BIGCOMMERCE_API_BASE,
};
