const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const finerworksService = require('../helpers/finerworks-service');
const { sendApiError } = require('../helpers/api-error');
const { logIncomingRequest } = require('../helpers/request-log');
const {
  getEbayEnv,
  getEbayHosts,
  getEbayClientId,
  getEbayClientSecret,
  getEbayRuName,
  getEbayUserScopes,
  postEbayToken,
  ebayApiCall,
  isOk,
  summarizeEbayHttpError,
  isEbayUrl,
} = require('../helpers/ebay-api');
const {
  putEbayAccount,
  deleteEbayAccountsByAccountKey,
} = require('../helpers/ebay-accounts-dynamo');
const debug = require('debug');
const log = debug('app:ebayAuth');

/** Name of the connection object inside the account's FinerWorks `connections` list. */
const EBAY_CONNECTION_NAME = 'eBay';

const getInstallCtxSecret = () =>
  String(process.env.EBAY_INSTALL_CTX_SECRET || '').trim() || getEbayClientSecret();

/**
 * eBay token responses carry RELATIVE lifetimes in seconds: `expires_in` (access token, ~2h)
 * and `refresh_token_expires_in` (refresh token, ~18 months). Stored as absolute ISO times.
 */
function expiryIso(seconds) {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(Date.now() + n * 1000).toISOString() : null;
}

/** True when an ISO timestamp is missing, unparseable, or within 5 minutes of now. */
function isEbayTokenExpiringSoon(expires_at) {
  if (!expires_at) return true;
  const t = Date.parse(expires_at);
  if (!Number.isFinite(t)) return true;
  return Date.now() + 5 * 60_000 >= t;
}

function parseData(conn) {
  if (!conn) return {};
  if (typeof conn.data === 'string') {
    try {
      return JSON.parse(conn.data) || {};
    } catch (_e) {
      return {};
    }
  }
  return conn.data && typeof conn.data === 'object' ? { ...conn.data } : {};
}

/**
 * Upserts the eBay connection into the account's FinerWorks connections list. Merges onto the
 * existing connection data so fields written by other flows (order_sync,
 * notification_subscription_id, ...) survive a token refresh.
 */
async function saveEbayConnection(account_key, patch) {
  const trimmedKey = String(account_key).trim();
  const getInformation = await finerworksService.GET_INFO({ account_key: trimmedKey });
  const connections = Array.isArray(getInformation?.user_account?.connections)
    ? JSON.parse(JSON.stringify(getInformation.user_account.connections))
    : [];
  const idx = connections.findIndex((c) => c && c.name === EBAY_CONNECTION_NAME);
  const existingConn = idx !== -1 && connections[idx] ? connections[idx] : {};
  const nextData = { ...parseData(existingConn), ...patch };
  const nextConnection = {
    ...existingConn,
    name: EBAY_CONNECTION_NAME,
    // Same convention as the other platforms: `id` holds the current access token.
    id: nextData.access_token || existingConn.id || null,
    data: JSON.stringify(nextData),
  };
  if (idx !== -1) connections[idx] = nextConnection;
  else connections.push(nextConnection);
  await finerworksService.UPDATE_INFO({ account_key: trimmedKey, connections });
  return nextData;
}

/** Reads the saved eBay connection for an account_key (null when not connected). */
async function getEbayConnection(account_key) {
  const getInformation = await finerworksService.GET_INFO({ account_key: String(account_key).trim() });
  const connections = getInformation?.user_account?.connections;
  if (!Array.isArray(connections)) return null;
  const conn = connections.find((c) => c && c.name === EBAY_CONNECTION_NAME);
  if (!conn) return null;
  const data = parseData(conn);
  const access_token = data.access_token || conn.id || null;
  if (!access_token) return null;
  return { ...data, access_token };
}

/** GET /commerce/identity/v1/user/ — the seller's eBay userId + username (best effort). */
async function fetchEbayUser(accessToken) {
  const r = await ebayApiCall({ method: 'GET', path: '/commerce/identity/v1/user/', accessToken, host: 'apiz' });
  if (!isOk(r)) {
    log('fetchEbayUser failed: %o', summarizeEbayHttpError({ response: r }));
    return { userId: null, username: null };
  }
  return { userId: r.data?.userId || null, username: r.data?.username || null, accountType: r.data?.accountType || null };
}

/**
 * Core refresh, reused by resolveEbayAuth (proactive) and the refresh endpoint. eBay does NOT
 * rotate the refresh token on refresh — the same one stays valid until its ~18-month expiry,
 * after which the seller must reconnect.
 */
async function refreshEbayTokenCore(account_key, conn) {
  if (!conn?.refresh_token) {
    const err = new Error('This eBay connection has no refresh_token stored; reconnect via GET /ebay/auth.');
    err.status = 400;
    throw err;
  }
  if (!getEbayClientId() || !getEbayClientSecret()) {
    const err = new Error('EBAY_CLIENT_ID / EBAY_CLIENT_SECRET not configured');
    err.status = 500;
    throw err;
  }
  if (conn.refresh_token_expires_at && Date.parse(conn.refresh_token_expires_at) < Date.now()) {
    const err = new Error('The eBay refresh token has expired (about 18 months after connecting); reconnect via GET /ebay/auth.');
    err.status = 401;
    throw err;
  }

  const resp = await postEbayToken({
    grant_type: 'refresh_token',
    refresh_token: conn.refresh_token,
    scope: (conn.granted_scopes && conn.granted_scopes.length ? conn.granted_scopes : getEbayUserScopes()).join(' '),
  });
  const tokenData = resp?.data || {};
  if (!tokenData.access_token) {
    const err = new Error('eBay did not return a new access_token');
    err.status = 502;
    throw err;
  }
  const access_token_expires_at = expiryIso(tokenData.expires_in);
  await saveEbayConnection(account_key, {
    access_token: tokenData.access_token,
    access_token_expires_at,
    token_refreshed_at: new Date().toISOString(),
  });
  return { access_token: tokenData.access_token, access_token_expires_at };
}

/**
 * Seller credentials for an account_key, refreshing first when the access token is within
 * 5 minutes of expiry (eBay access tokens only last ~2 hours). Used by every eBay controller.
 */
async function resolveEbayAuth(account_key) {
  if (!account_key || !String(account_key).trim()) {
    const err = new Error('account_key is required');
    err.status = 400;
    throw err;
  }
  const trimmedKey = String(account_key).trim();
  let conn = await getEbayConnection(trimmedKey);
  if (!conn) {
    const err = new Error('No eBay connection found for this account. Connect via GET /ebay/auth first.');
    err.status = 400;
    throw err;
  }
  if (isEbayTokenExpiringSoon(conn.access_token_expires_at) && conn.refresh_token) {
    const refreshed = await refreshEbayTokenCore(trimmedKey, conn);
    conn = { ...conn, ...refreshed };
  }
  return { accessToken: conn.access_token, conn };
}

/**
 * Step 1 of connecting: redirect the seller to eBay's consent page.
 *
 * eBay's OAuth differs from the other platforms in one important way: `redirect_uri` is NOT a
 * URL but the app's **RuName** (eBay Redirect URL name). The real callback URL
 * (GET /api/ebay/callback) is configured against that RuName in the eBay developer portal as
 * the "auth accepted URL". eBay echoes `state` back, so account_key rides in a signed JWT.
 *
 * Query: account_key (required), return_url (optional, where to send the seller afterwards).
 */
const handleEbayAuthStart = async (req, res) => {
  try {
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'handleEbayAuthStart',
      accountKey: req.query?.account_key || req.body?.account_key,
      body: req.body,
      query: req.query,
    });
    const account_key = req.query?.account_key || req.body?.account_key;
    if (!account_key || !String(account_key).trim()) {
      return sendApiError(res, 400, 'Missing required parameter: account_key');
    }
    const clientId = getEbayClientId();
    const ruName = getEbayRuName();
    if (!clientId || !ruName) {
      return sendApiError(res, 500, 'EBAY_CLIENT_ID and EBAY_RUNAME must be configured');
    }
    const ctxSecret = getInstallCtxSecret();
    if (!ctxSecret) {
      return sendApiError(res, 500, 'Set EBAY_CLIENT_SECRET or EBAY_INSTALL_CTX_SECRET to sign the OAuth state.');
    }

    const return_url = req.query?.return_url || req.body?.return_url || process.env.EBAY_RETURN_URL || 'https://fa.finerworks.com/';
    const state = jwt.sign(
      {
        purpose: 'ebay_install',
        account_key: String(account_key).trim(),
        nonce: crypto.randomBytes(16).toString('hex'),
        return_url: String(return_url).trim(),
      },
      ctxSecret,
      { expiresIn: '15m' }
    );

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: ruName,
      response_type: 'code',
      scope: getEbayUserScopes().join(' '),
      state,
    });
    // Force the eBay sign-in screen so a merchant can pick the right eBay account.
    if (String(process.env.EBAY_FORCE_LOGIN_PROMPT || 'true').toLowerCase() !== 'false') params.set('prompt', 'login');
    const authorizeUrl = `${getEbayHosts().auth}/oauth2/authorize?${params.toString()}`;

    console.log(JSON.stringify({
      level: 'INFO',
      platform: 'ebay',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'handleEbayAuthStart',
      operation: 'eBay consent redirect sent',
      account_key: String(account_key).trim(),
      result: { env: getEbayEnv() },
      timestamp: new Date().toISOString(),
    }));
    return res.redirect(authorizeUrl);
  } catch (err) {
    console.error(JSON.stringify({
      level: 'ERROR',
      platform: 'ebay',
      source: 'lambda',
      function: 'handleEbayAuthStart',
      account_key: req.query?.account_key || req.body?.account_key || 'unknown',
      message: `eBay authorize initiation failed: ${err?.message || 'Unknown error'}`,
      timestamp: new Date().toISOString(),
    }));
    return sendApiError(res, err);
  }
};

/**
 * Step 2: eBay redirects here ("auth accepted URL" of the RuName) with `code` and `state`.
 * Exchanges the code for tokens, looks up the seller's eBay user id, saves the connection on
 * the account, and records the seller in the eBay accounts registry (DynamoDB).
 * If the seller declined, eBay sends no code (configure the RuName's "auth declined URL" to
 * this same endpoint) and the seller is sent back to return_url with success=0.
 */
const handleEbayAuthCallback = async (req, res) => {
  let account_key = null;
  let return_url = null;
  try {
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'handleEbayAuthCallback',
      accountKey: null,
      body: req.body,
      query: { ...req.query, code: req.query?.code ? '***' : undefined },
    });
    const { code, state } = req.query || {};
    const ctxSecret = getInstallCtxSecret();
    if (state && ctxSecret) {
      try {
        const payload = jwt.verify(state, ctxSecret);
        if (payload?.purpose === 'ebay_install' && payload?.account_key) {
          account_key = String(payload.account_key).trim();
          return_url = payload.return_url || null;
        }
      } catch (verifyErr) {
        log('handleEbayAuthCallback: state verification failed: %s', verifyErr?.message);
      }
    }
    if (!account_key) {
      return sendApiError(res, 400, 'Missing or invalid state. Start the connection from GET /ebay/auth?account_key=... inside OFA.');
    }
    if (!code) {
      const reason = req.query?.error_description || req.query?.error || 'consent was declined';
      if (return_url) {
        const sep = String(return_url).includes('?') ? '&' : '?';
        return res.redirect(`${return_url}${sep}success=0&platform=ebay&reason=${encodeURIComponent(reason)}`);
      }
      return sendApiError(res, 400, `eBay did not return an authorization code (${reason})`);
    }
    if (!getEbayClientId() || !getEbayClientSecret() || !getEbayRuName()) {
      return sendApiError(res, 500, 'eBay OAuth credentials not configured');
    }

    const tokenResp = await postEbayToken({
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: getEbayRuName(),
    });
    const tokenData = tokenResp?.data || {};
    if (!tokenData.access_token) {
      return sendApiError(res, 400, 'Token exchange succeeded but access_token missing');
    }

    const user = await fetchEbayUser(tokenData.access_token);
    await saveEbayConnection(account_key, {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || null,
      access_token_expires_at: expiryIso(tokenData.expires_in),
      refresh_token_expires_at: expiryIso(tokenData.refresh_token_expires_in),
      granted_scopes: getEbayUserScopes(),
      ebay_user_id: user.userId,
      ebay_username: user.username,
      ebay_env: getEbayEnv(),
      marketplace_id: process.env.EBAY_MARKETPLACE_ID || 'EBAY_US',
      connected_at: new Date().toISOString(),
    });

    try {
      await putEbayAccount({
        id: crypto.randomUUID(),
        account_key,
        ebay_user_id: user.userId,
        ebay_username: user.username,
        ebay_env: getEbayEnv(),
      });
    } catch (dynErr) {
      // Registry is only needed for notifications/polling; don't fail the connect over it.
      log('handleEbayAuthCallback: eBay accounts registry write failed: %s', dynErr?.message);
    }

    console.log(JSON.stringify({
      level: 'INFO',
      platform: 'ebay',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'handleEbayAuthCallback',
      operation: 'eBay connected and connection saved',
      account_key,
      result: { ebay_username: user.username, env: getEbayEnv() },
      timestamp: new Date().toISOString(),
    }));

    if (return_url) {
      const sep = String(return_url).includes('?') ? '&' : '?';
      return res.redirect(`${return_url}${sep}success=1&platform=ebay`);
    }
    return res.status(200).json({
      success: true,
      message: 'eBay connection added successfully',
      ebay_user_id: user.userId,
      ebay_username: user.username,
    });
  } catch (err) {
    console.error(JSON.stringify({
      level: 'ERROR',
      platform: 'ebay',
      source: isEbayUrl(err) ? 'ebay_api' : 'lambda',
      function: 'handleEbayAuthCallback',
      account_key: account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `eBay OAuth callback failed: ${err?.message || 'Unknown error'}`,
      detail: summarizeEbayHttpError(err),
      timestamp: new Date().toISOString(),
    }));
    return sendApiError(res, err);
  }
};

/**
 * Force-refresh an account's eBay access token. Body/query: { account_key }.
 * The refresh token is always read server-side from the stored connection (never accepted
 * from the caller), so one account's token can't be bound to another account.
 */
const refreshEbayToken = async (req, res) => {
  try {
    const account_key = req.body?.account_key || req.query?.account_key;
    if (!account_key || !String(account_key).trim()) {
      return sendApiError(res, 400, 'Missing required parameter: account_key');
    }
    const trimmedKey = String(account_key).trim();
    const conn = await getEbayConnection(trimmedKey);
    if (!conn) return sendApiError(res, 404, 'No eBay connection found for this account_key');

    const result = await refreshEbayTokenCore(trimmedKey, conn);
    console.log(JSON.stringify({
      level: 'INFO',
      platform: 'ebay',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'refreshEbayToken',
      operation: 'eBay access token refreshed',
      account_key: trimmedKey,
      result: { access_token_expires_at: result.access_token_expires_at },
      timestamp: new Date().toISOString(),
    }));
    return res.status(200).json({
      success: true,
      message: 'eBay access token refreshed successfully',
      access_token_expires_at: result.access_token_expires_at,
      refresh_token_expires_at: conn.refresh_token_expires_at || null,
    });
  } catch (err) {
    console.error(JSON.stringify({
      level: 'ERROR',
      platform: 'ebay',
      source: isEbayUrl(err) ? 'ebay_api' : 'lambda',
      function: 'refreshEbayToken',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || err?.status || null,
      message: `eBay token refresh failed: ${err?.message || 'Unknown error'}`,
      detail: summarizeEbayHttpError(err),
      timestamp: new Date().toISOString(),
    }));
    return sendApiError(res, err);
  }
};

/**
 * Disconnect: removes the order notification subscription (best effort), clears the eBay
 * connection on the account and removes the seller from the eBay accounts registry.
 * eBay has no token-revocation API; the seller can also revoke access from their eBay
 * account settings ("Third-party app access"). Body/query: { account_key }.
 */
const handleEbayDisconnect = async (req, res) => {
  try {
    const account_key = req.body?.account_key || req.query?.account_key;
    if (!account_key || !String(account_key).trim()) {
      return sendApiError(res, 400, 'Missing required parameter: account_key');
    }
    const trimmedKey = String(account_key).trim();
    const getInformation = await finerworksService.GET_INFO({ account_key: trimmedKey });
    const connections = JSON.parse(JSON.stringify(getInformation?.user_account?.connections || []));
    const idx = connections.findIndex((c) => c && c.name === EBAY_CONNECTION_NAME);
    if (idx === -1) {
      return res.status(200).json({ success: true, message: 'No eBay connection found; nothing to disconnect' });
    }

    const data = parseData(connections[idx]);
    if (data.notification_subscription_id && data.access_token) {
      try {
        // Lazy require: ebay-notifications requires this module.
        const { deleteEbayOrderSubscription } = require('../helpers/ebay-notifications');
        await deleteEbayOrderSubscription(data.access_token, data.notification_subscription_id);
      } catch (subErr) {
        log('handleEbayDisconnect: subscription delete failed (continuing): %s', subErr?.message);
      }
    }

    connections[idx] = { name: EBAY_CONNECTION_NAME, id: null, data: null };
    await finerworksService.UPDATE_INFO({ account_key: trimmedKey, connections });
    try {
      await deleteEbayAccountsByAccountKey(trimmedKey);
    } catch (dynErr) {
      log('handleEbayDisconnect: registry delete failed (continuing): %s', dynErr?.message);
    }

    console.log(JSON.stringify({
      level: 'INFO',
      platform: 'ebay',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'handleEbayDisconnect',
      operation: 'eBay disconnected',
      account_key: trimmedKey,
      timestamp: new Date().toISOString(),
    }));
    return res.status(200).json({ success: true, message: 'eBay disconnected successfully' });
  } catch (err) {
    console.error(JSON.stringify({
      level: 'ERROR',
      platform: 'ebay',
      source: 'finerworks_api',
      function: 'handleEbayDisconnect',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `eBay disconnect failed: ${err?.message || 'Unknown error'}`,
      timestamp: new Date().toISOString(),
    }));
    return sendApiError(res, err);
  }
};

module.exports = {
  EBAY_CONNECTION_NAME,
  handleEbayAuthStart,
  handleEbayAuthCallback,
  refreshEbayToken,
  handleEbayDisconnect,
  getEbayConnection,
  saveEbayConnection,
  refreshEbayTokenCore,
  resolveEbayAuth,
  isEbayTokenExpiringSoon,
  fetchEbayUser,
};
