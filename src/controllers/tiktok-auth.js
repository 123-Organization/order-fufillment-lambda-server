const axios = require('axios');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const finerworksService = require('../helpers/finerworks-service');
const debug = require('debug');
const { sendApiError } = require('../helpers/api-error');
const { logIncomingRequest } = require('../helpers/request-log');
const log = debug('app:tiktokAuth');
require('dotenv').config();

/**
 * TikTok Shop host map — confirmed against TikTok's own official sample server
 * (github.com/tiktok/ttspc-server-sample):
 *   - OAuth token exchange/refresh live on auth.tiktok-shops.com (api/v2/token/*).
 *   - Every other Open API call (shops, products, orders, ...) lives on
 *     open-api.tiktokglobalshop.com and must be request-signed (see generateTiktokSign).
 *   - The seller "authorize app" link lives on services.tiktokshop.com (or
 *     services.us.tiktokshop.com for the US market — override via TIKTOK_AUTHORIZE_BASE).
 * All three are overridable via env for region/API changes without a code change.
 */
const TIKTOK_AUTH_BASE = process.env.TIKTOK_AUTH_BASE || 'https://auth.tiktok-shops.com';
const TIKTOK_API_BASE = process.env.TIKTOK_API_BASE || 'https://open-api.tiktokglobalshop.com';
const TIKTOK_AUTHORIZE_BASE = process.env.TIKTOK_AUTHORIZE_BASE || 'https://services.tiktokshop.com';

const getTiktokAppKey = () => process.env.TIKTOK_APP_KEY;
const getTiktokAppSecret = () => process.env.TIKTOK_APP_SECRET;
const getInstallCtxSecret = () => process.env.TIKTOK_INSTALL_CTX_SECRET || getTiktokAppSecret();

/**
 * Unlike BigCommerce, TikTok Shop's seller-authorize link DOES echo a `state` param back on
 * the callback, so (like Wix) we can carry account_key through as a signed JWT state instead
 * of needing an install-context cookie.
 *
 * Partner Center shows the exact authorize link for your app (App & Service -> your app ->
 * Basic Information) — TikTok's docs are inconsistent about whether it takes `service_id` or
 * `app_key`, so the safest option is to paste that exact link into TIKTOK_AUTHORIZE_URL rather
 * than relying on this function's best-effort construction from TIKTOK_SERVICE_ID.
 */
function buildTiktokAuthorizeUrl(state) {
  const explicit = String(process.env.TIKTOK_AUTHORIZE_URL || '').trim();
  if (explicit) {
    const sep = explicit.includes('?') ? '&' : '?';
    return `${explicit}${sep}state=${encodeURIComponent(state)}`;
  }
  const serviceId = process.env.TIKTOK_SERVICE_ID;
  return `${TIKTOK_AUTHORIZE_BASE}/open/authorize?service_id=${encodeURIComponent(serviceId)}&state=${encodeURIComponent(state)}`;
}

/**
 * TikTok Shop's request-signing scheme — every Open API call made WITH an access_token
 * (product sync, order fetch, "Get Authorized Shops" below, etc.) must carry a `sign` query
 * param computed this exact way, or the call is rejected. Ported near-verbatim from TikTok's
 * own official sample server (src/utils/sign.ts) rather than reimplemented from a description,
 * since it has to match their algorithm byte-for-byte:
 *   1. Sort all query params (excluding `sign`/`access_token`) alphabetically by key.
 *   2. Concatenate as key+value pairs with no separators: key1value1key2value2...
 *   3. Prepend the request path.
 *   4. If not multipart/form-data and a body exists, append JSON.stringify(body).
 *   5. Wrap with app_secret on both ends, HMAC-SHA256 with app_secret as the key, hex digest.
 * Not used for the OAuth token exchange/refresh calls — those take app_secret directly as a
 * query param instead and are unsigned.
 */
function generateTiktokSign({ path, params = {}, headers = {}, body = null, appSecret }) {
  const sortedKeys = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'access_token')
    .sort();
  let paramString = '';
  for (const key of sortedKeys) {
    paramString += `${key}${params[key]}`;
  }
  let signString = `${path}${paramString}`;
  const contentType = headers['content-type'] || headers['Content-Type'];
  if (contentType !== 'multipart/form-data' && body != null) {
    signString += JSON.stringify(body);
  }
  signString = `${appSecret}${signString}${appSecret}`;
  return crypto.createHmac('sha256', appSecret).update(signString).digest('hex');
}

/**
 * Signed GET to a TikTok Open API path — shared by fetchTiktokAuthorizedShops now and
 * reusable for product/order endpoints later (export it alongside generateTiktokSign).
 */
async function tiktokSignedGet(path, { accessToken, extraParams = {} }) {
  const appKey = getTiktokAppKey();
  const appSecret = getTiktokAppSecret();
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { app_key: appKey, timestamp, ...extraParams };
  const sign = generateTiktokSign({ path, params, headers: {}, body: null, appSecret });
  return axios.get(`${TIKTOK_API_BASE}${path}`, {
    params: { ...params, sign },
    headers: { 'x-tts-access-token': accessToken },
    timeout: 20000,
  });
}

/**
 * "Get Authorized Shops" — an access_token can cover multiple shops; this is how TikTok says
 * to enumerate them (there's no shop_id on the OAuth callback itself). Each shop's `cipher`
 * (shop_cipher) is required on nearly every later shop-scoped API call, so it's captured and
 * stored on the connection now rather than re-fetched on every future call.
 */
async function fetchTiktokAuthorizedShops(accessToken) {
  const resp = await tiktokSignedGet('/authorization/202309/shops', { accessToken });
  const shops = resp?.data?.data?.shops || resp?.data?.data || [];
  return Array.isArray(shops) ? shops : [];
}

/**
 * Upserts the TikTok Shop connection (tokens + shop list) into an OFA account's FinerWorks
 * connections list. Shared by the Auth Callback and the refresh endpoint.
 */
async function saveTiktokConnection({
  account_key,
  access_token,
  refresh_token,
  access_token_expires_at,
  refresh_token_expires_at,
  open_id,
  seller_name,
  seller_base_region,
  granted_scopes,
  shops,
}) {
  const trimmedKey = String(account_key).trim();
  const getInformation = await finerworksService.GET_INFO({ account_key: trimmedKey });
  const connections = Array.isArray(getInformation?.user_account?.connections)
    ? JSON.parse(JSON.stringify(getInformation.user_account.connections))
    : [];
  const idx = connections.findIndex((c) => c && c.name === 'TikTok Shop');
  const nextConnection = {
    name: 'TikTok Shop',
    // Keep the same pattern as Square/Shopify/Squarespace/Wix: id stores the access token.
    id: access_token,
    data: JSON.stringify({
      access_token,
      refresh_token: refresh_token || null,
      access_token_expires_at: access_token_expires_at || null,
      refresh_token_expires_at: refresh_token_expires_at || null,
      open_id: open_id || null,
      seller_name: seller_name || null,
      seller_base_region: seller_base_region || null,
      granted_scopes: granted_scopes || null,
      shops: shops || [],
      connected_at: new Date().toISOString(),
    }),
  };
  if (idx !== -1) connections[idx] = nextConnection;
  else connections.push(nextConnection);

  await finerworksService.UPDATE_INFO({ account_key: trimmedKey, connections });
  return connections;
}

/**
 * Reads the saved TikTok Shop connection for an OFA account_key. Shared by anything that needs
 * to call TikTok's Open API on a merchant's behalf (product sync, order fetch, etc.).
 */
async function getTiktokConnection(account_key) {
  const getInformation = await finerworksService.GET_INFO({ account_key });
  const connections = getInformation?.user_account?.connections;
  if (!Array.isArray(connections)) return null;
  const conn = connections.find((c) => c && c.name === 'TikTok Shop');
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
  if (!access_token) return null;

  return {
    access_token,
    refresh_token: data.refresh_token || null,
    access_token_expires_at: data.access_token_expires_at || null,
    refresh_token_expires_at: data.refresh_token_expires_at || null,
    open_id: data.open_id || null,
    seller_name: data.seller_name || null,
    seller_base_region: data.seller_base_region || null,
    granted_scopes: data.granted_scopes || null,
    shops: Array.isArray(data.shops) ? data.shops : [],
  };
}

const tiktokErrorDetail = (err) => {
  const data = err?.response?.data;
  if (!data) return null;
  if (typeof data === 'string') return data.trim().slice(0, 500) || null;
  // TikTok's error envelope: { code, message, request_id, data }.
  return data.message || data.error || null;
};

/**
 * Initiates connecting a merchant's TikTok Shop to OFA.
 *
 * TikTok's Redirect URL is configured statically in Partner Center (App & Service -> your
 * app -> Basic Information -> Redirect URL), not passed per-request like most OAuth flows —
 * similar to BigCommerce in that respect. Unlike BigCommerce, though, TikTok's authorize link
 * DOES echo a `state` param back on the callback, so account_key rides through as a signed
 * JWT state param (same technique as Wix's handleWixAuthStart) rather than needing a cookie.
 *
 * Expected query: account_key (required), return_url (optional).
 */
const handleTiktokAuthStart = async (req, res) => {
  try {
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'handleTiktokAuthStart',
      accountKey: req.query?.account_key || req.body?.account_key,
      body: req.body,
      query: req.query,
    });

    const account_key = req.query?.account_key || req.body?.account_key;
    if (!account_key || !String(account_key).trim()) {
      log('handleTiktokAuthStart rejected: missing account_key');
      return sendApiError(res, 400, 'Missing required parameter: account_key');
    }

    const appKey = getTiktokAppKey();
    if (!appKey) {
      log('handleTiktokAuthStart rejected: TIKTOK_APP_KEY not configured');
      return sendApiError(res, 500, 'TIKTOK_APP_KEY not configured');
    }
    const ctxSecret = getInstallCtxSecret();
    if (!ctxSecret) {
      log('handleTiktokAuthStart rejected: no OAuth state secret configured');
      return sendApiError(
        res,
        500,
        'Set TIKTOK_APP_SECRET or TIKTOK_INSTALL_CTX_SECRET to sign the OAuth state.'
      );
    }

    const nonce = crypto.randomBytes(16).toString('hex');
    const return_url = req.query?.return_url || req.body?.return_url || 'https://fa.finerworks.com/';
    log(
      'handleTiktokAuthStart: building state account_key=%s nonce=%s return_url=%s',
      String(account_key).trim(),
      nonce,
      return_url
    );

    const state = jwt.sign(
      {
        purpose: 'tiktok_install',
        account_key: String(account_key).trim(),
        nonce,
        return_url: String(return_url).trim(),
      },
      ctxSecret,
      { expiresIn: '15m' }
    );
    log('handleTiktokAuthStart: state JWT signed (expires in 15m)');

    const authorizeUrl = buildTiktokAuthorizeUrl(state);
    log('handleTiktokAuthStart: redirecting to %s', authorizeUrl);

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'tiktok',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'handleTiktokAuthStart',
      operation: 'TikTok Shop authorize redirect sent successfully',
      account_key: String(account_key).trim(),
      result: { authorizeUrl, nonce },
      timestamp: new Date().toISOString(),
    });
    console.log(successLog);
    log('Success in handleTiktokAuthStart: %s', successLog);

    return res.redirect(authorizeUrl);
  } catch (err) {
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'tiktok',
      source: 'lambda',
      function: 'handleTiktokAuthStart',
      account_key: req.query?.account_key || req.body?.account_key || 'unknown',
      message: `TikTok Shop authorize initiation failed: ${err?.message || 'Unknown error'}`,
      timestamp: new Date().toISOString(),
    });
    console.error(errorJson);
    log('Formatted error in handleTiktokAuthStart: %s', errorJson);
    return sendApiError(res, err);
  }
};

/**
 * Auth Callback — register this exact URL in Partner Center as the app's Redirect URL.
 * TikTok GETs this after the seller approves the install, with `code` (the auth_code) and
 * `state`. Exchanges the code for tokens, fetches the authorized shop list, and saves the
 * connection under whichever OFA account the state identifies.
 */
const handleTiktokAuthCallback = async (req, res) => {
  let account_key = null;
  try {
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'handleTiktokAuthCallback',
      accountKey: null, // not known yet — recovered from state below
      body: req.body,
      query: req.query,
    });

    const { code, state } = req.query || {};
    log('handleTiktokAuthCallback: received code_present=%s state_present=%s', Boolean(code), Boolean(state));
    if (!code || !state) {
      log('handleTiktokAuthCallback rejected: missing code or state');
      return sendApiError(res, 400, 'Missing required parameters: code, state');
    }

    const ctxSecret = getInstallCtxSecret();
    let return_url = null;
    if (ctxSecret) {
      try {
        const payload = jwt.verify(state, ctxSecret);
        if (payload?.purpose === 'tiktok_install' && payload?.account_key) {
          account_key = String(payload.account_key).trim();
          return_url = payload.return_url || null;
          log('handleTiktokAuthCallback: state verified account_key=%s nonce=%s', account_key, payload.nonce || 'unknown');
        } else {
          log('handleTiktokAuthCallback: state verified but missing purpose/account_key claim');
        }
      } catch (verifyErr) {
        log('handleTiktokAuthCallback: state verification failed: %s', verifyErr?.message);
      }
    }

    if (!account_key) {
      log('handleTiktokAuthCallback rejected: no account_key recovered from state');
      return sendApiError(
        res,
        400,
        'Missing or invalid state. Start the connection from GET /tiktok/auth?account_key=... inside OFA rather than installing directly from TikTok.'
      );
    }

    const appKey = getTiktokAppKey();
    const appSecret = getTiktokAppSecret();
    if (!appKey || !appSecret) {
      log('handleTiktokAuthCallback rejected: TikTok OAuth credentials not configured');
      return sendApiError(res, 500, 'TikTok OAuth credentials not configured');
    }

    log('handleTiktokAuthCallback: exchanging code for token account_key=%s', account_key);
    const tokenResp = await axios.get(`${TIKTOK_AUTH_BASE}/api/v2/token/get`, {
      params: {
        app_key: appKey,
        app_secret: appSecret,
        auth_code: code,
        // TikTok's actual spelling — not the standard OAuth "authorization_code".
        grant_type: 'authorized_code',
      },
      timeout: 20000,
    });
    log(
      'handleTiktokAuthCallback: token exchange responded code=%s access_token_present=%s',
      tokenResp?.data?.code,
      Boolean(tokenResp?.data?.data?.access_token)
    );

    const tokenData = tokenResp?.data?.data;
    if (!tokenData?.access_token) {
      log('handleTiktokAuthCallback rejected: token exchange succeeded but access_token missing account_key=%s', account_key);
      return sendApiError(res, 400, 'Token exchange succeeded but access_token missing', {
        detail: tokenResp?.data?.message || null,
      });
    }

    const now = Date.now();
    const access_token_expires_at = Number.isFinite(Number(tokenData.access_token_expires_in))
      ? new Date(now + Number(tokenData.access_token_expires_in) * 1000).toISOString()
      : null;
    const refresh_token_expires_at = Number.isFinite(Number(tokenData.refresh_token_expires_in))
      ? new Date(now + Number(tokenData.refresh_token_expires_in) * 1000).toISOString()
      : null;

    log('handleTiktokAuthCallback: fetching authorized shops open_id=%s', tokenData.open_id);
    let shops = [];
    try {
      shops = await fetchTiktokAuthorizedShops(tokenData.access_token);
      log('handleTiktokAuthCallback: found %d authorized shop(s)', shops.length);
    } catch (shopErr) {
      // Don't fail the whole connect over this — the token is still good; shops can be
      // re-fetched later. Just log it so a missing shop list is diagnosable.
      log('handleTiktokAuthCallback: fetching authorized shops failed (continuing without shop list): %s', shopErr?.message);
    }

    log('handleTiktokAuthCallback: saving connection to FinerWorks account_key=%s', account_key);
    await saveTiktokConnection({
      account_key,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      access_token_expires_at,
      refresh_token_expires_at,
      open_id: tokenData.open_id,
      seller_name: tokenData.seller_name,
      seller_base_region: tokenData.seller_base_region,
      granted_scopes: tokenData.granted_scopes,
      shops,
    });
    log('handleTiktokAuthCallback: FinerWorks connection saved successfully account_key=%s', account_key);

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'tiktok',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'handleTiktokAuthCallback',
      operation: 'TikTok Shop OAuth callback handled and connection saved successfully',
      account_key,
      result: { shopCount: shops.length, redirected: Boolean(return_url) },
      timestamp: new Date().toISOString(),
    });
    console.log(successLog);
    log('Success in handleTiktokAuthCallback: %s', successLog);

    if (return_url) {
      const sep = String(return_url).includes('?') ? '&' : '?';
      log('handleTiktokAuthCallback: redirecting to return_url=%s', return_url);
      return res.redirect(`${return_url}${sep}success=1`);
    }
    return res.status(200).json({
      success: true,
      message: 'TikTok Shop connection added successfully',
      open_id: tokenData.open_id,
      shops: shops.map((s) => ({ id: s.id, name: s.name, region: s.region })),
    });
  } catch (err) {
    const isTiktokError =
      err?.response?.config?.url?.includes('tiktok-shops.com') ||
      err?.response?.config?.url?.includes('tiktokglobalshop.com') ||
      err?.config?.url?.includes('tiktok-shops.com') ||
      err?.config?.url?.includes('tiktokglobalshop.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'tiktok',
      source: isTiktokError ? 'tiktok_api' : 'lambda',
      function: 'handleTiktokAuthCallback',
      account_key: account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `TikTok Shop OAuth callback failed: ${err?.message || 'Unknown error'}`,
      detail: tiktokErrorDetail(err),
      timestamp: new Date().toISOString(),
    });
    console.error(errorJson);
    log('Formatted error in handleTiktokAuthCallback: %s', errorJson);
    return sendApiError(res, err);
  }
};

/**
 * Core refresh logic, reusable outside the HTTP handler (product sync / order fetch call this
 * directly when a stored token is near expiry, mirroring Square's refreshSquareTokensCore).
 * Throws on failure rather than writing to a response — callers decide how to surface it.
 */
async function refreshTiktokTokenCore(account_key, conn) {
  const trimmedKey = String(account_key).trim();
  if (!conn?.refresh_token) {
    const err = new Error('This TikTok Shop connection has no refresh_token stored; reconnect via GET /tiktok/auth.');
    err.status = 400;
    throw err;
  }

  const appKey = getTiktokAppKey();
  const appSecret = getTiktokAppSecret();
  if (!appKey || !appSecret) {
    const err = new Error('TikTok OAuth credentials not configured');
    err.status = 500;
    throw err;
  }

  log('refreshTiktokTokenCore: refreshing access_token account_key=%s', trimmedKey);
  const tokenResp = await axios.get(`${TIKTOK_AUTH_BASE}/api/v2/token/refresh`, {
    params: {
      app_key: appKey,
      app_secret: appSecret,
      refresh_token: conn.refresh_token,
      grant_type: 'refresh_token',
    },
    timeout: 20000,
  });

  const tokenData = tokenResp?.data?.data;
  if (!tokenData?.access_token) {
    const err = new Error('TikTok did not return a new access_token');
    err.status = 502;
    err.detail = tokenResp?.data?.message || null;
    throw err;
  }

  const now = Date.now();
  const access_token_expires_at = Number.isFinite(Number(tokenData.access_token_expires_in))
    ? new Date(now + Number(tokenData.access_token_expires_in) * 1000).toISOString()
    : null;
  const refresh_token_expires_at = Number.isFinite(Number(tokenData.refresh_token_expires_in))
    ? new Date(now + Number(tokenData.refresh_token_expires_in) * 1000).toISOString()
    : null;

  await saveTiktokConnection({
    account_key: trimmedKey,
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token || conn.refresh_token,
    access_token_expires_at,
    refresh_token_expires_at,
    open_id: conn.open_id,
    seller_name: conn.seller_name,
    seller_base_region: conn.seller_base_region,
    granted_scopes: conn.granted_scopes,
    shops: conn.shops,
  });

  return { access_token: tokenData.access_token, access_token_expires_at, refresh_token_expires_at };
}

/** True when an ISO timestamp is missing, unparseable, or within 5 minutes of now. */
function isTiktokTokenExpiringSoon(expires_at) {
  if (!expires_at) return true;
  const t = Date.parse(expires_at);
  if (!Number.isFinite(t)) return true;
  return Date.now() + 5 * 60_000 >= t;
}

/**
 * Force-refreshes a TikTok Shop connection's access token on demand.
 *
 * Expects body/query: { account_key } only — deliberately does NOT accept a client-supplied
 * refresh_token (unlike this codebase's Square/Squarespace refresh endpoints). Accepting a
 * caller-supplied token tied to a caller-chosen account_key lets anyone with their own valid
 * refresh_token rebind it to an arbitrary victim account_key — the refresh_token here is
 * always looked up server-side from the account's own stored connection instead.
 */
const refreshTiktokToken = async (req, res) => {
  try {
    const account_key = req.body?.account_key || req.query?.account_key;
    if (!account_key || !String(account_key).trim()) {
      log('refreshTiktokToken rejected: missing account_key');
      return sendApiError(res, 400, 'Missing required parameter: account_key');
    }
    const trimmedKey = String(account_key).trim();

    const conn = await getTiktokConnection(trimmedKey);
    if (!conn) {
      log('refreshTiktokToken rejected: no TikTok Shop connection for account_key=%s', trimmedKey);
      return sendApiError(res, 404, 'No TikTok Shop connection found for this account_key');
    }

    const result = await refreshTiktokTokenCore(trimmedKey, conn);

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'tiktok',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'refreshTiktokToken',
      operation: 'TikTok Shop access token refreshed successfully',
      account_key: trimmedKey,
      result: { access_token_expires_at: result.access_token_expires_at },
      timestamp: new Date().toISOString(),
    });
    console.log(successLog);
    log('Success in refreshTiktokToken: %s', successLog);

    return res.status(200).json({
      success: true,
      message: 'TikTok Shop access token refreshed successfully',
      access_token: result.access_token,
      access_token_expires_at: result.access_token_expires_at,
    });
  } catch (err) {
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'tiktok',
      source: 'tiktok_api',
      function: 'refreshTiktokToken',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `TikTok Shop token refresh failed: ${err?.message || 'Unknown error'}`,
      detail: tiktokErrorDetail(err),
      timestamp: new Date().toISOString(),
    });
    console.error(errorJson);
    log('Formatted error in refreshTiktokToken: %s', errorJson);
    return sendApiError(res, err);
  }
};

/**
 * Explicit, account_key-driven disconnect — clears the TikTok Shop connection from FinerWorks.
 * There's no token-revoke call here (uninstalling the app from TikTok Partner Center / Seller
 * Center is what actually invalidates the token on their side); this just clears our side.
 *
 * Deliberately does NOT echo the account's full connections array back (unlike this codebase's
 * Square/Shopify/BigCommerce disconnect handlers, which do and leak every other connected
 * platform's live tokens in the response) — only a plain success message.
 * Expects body/query: { account_key }.
 */
const handleTiktokDisconnect = async (req, res) => {
  try {
    const account_key = req.body?.account_key || req.query?.account_key;
    if (!account_key || !String(account_key).trim()) {
      return sendApiError(res, 400, 'Missing required parameter: account_key');
    }
    const trimmedKey = String(account_key).trim();

    const getInformation = await finerworksService.GET_INFO({ account_key: trimmedKey });
    const connections = JSON.parse(JSON.stringify(getInformation?.user_account?.connections || []));
    const idx = connections.findIndex((c) => c && c.name === 'TikTok Shop');

    if (idx === -1) {
      return res.status(200).json({
        success: true,
        message: 'No TikTok Shop connection found; nothing to disconnect',
      });
    }

    connections[idx] = { name: 'TikTok Shop', id: null, data: null };
    await finerworksService.UPDATE_INFO({ account_key: trimmedKey, connections });

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'tiktok',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'handleTiktokDisconnect',
      operation: 'TikTok Shop disconnected successfully',
      account_key: trimmedKey,
      result: { disconnected: true },
      timestamp: new Date().toISOString(),
    });
    console.log(successLog);
    log('Success in handleTiktokDisconnect: %s', successLog);

    return res.status(200).json({
      success: true,
      message: 'TikTok Shop disconnected successfully',
    });
  } catch (err) {
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'tiktok',
      source: 'finerworks_api',
      function: 'handleTiktokDisconnect',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `TikTok Shop disconnect failed: ${err?.message || 'Unknown error'}`,
      timestamp: new Date().toISOString(),
    });
    console.error(errorJson);
    log('Formatted error in handleTiktokDisconnect: %s', errorJson);
    return sendApiError(res, err);
  }
};

module.exports = {
  handleTiktokAuthStart,
  handleTiktokAuthCallback,
  refreshTiktokToken,
  handleTiktokDisconnect,
  getTiktokConnection,
  refreshTiktokTokenCore,
  isTiktokTokenExpiringSoon,
  generateTiktokSign,
  tiktokSignedGet,
  getTiktokAppKey,
  getTiktokAppSecret,
  TIKTOK_API_BASE,
  TIKTOK_AUTH_BASE,
};
