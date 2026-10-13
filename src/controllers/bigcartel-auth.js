const axios = require('axios');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const finerworksService = require('../helpers/finerworks-service');
const debug = require('debug');
const { sendApiError } = require('../helpers/api-error');
const { logIncomingRequest } = require('../helpers/request-log');
const log = debug('app:bigcartelAuth');
require('dotenv').config();

/**
 * Big Cartel API host map — confirmed from Big Cartel's own official docs
 * (developers.bigcartel.com/api/v1), fetched directly (not from a third-party guide):
 *   - Seller "authorize app" link lives on my.bigcartel.com.
 *   - OAuth token exchange + deauthorize, and every REST resource (accounts, orders,
 *     products, shipments, ...), live on api.bigcartel.com, versioned under /v1.
 * UNCONFIRMED, flagged for live testing before go-live: Big Cartel's docs never show a
 * `grant_type` param or a Content-Type for the token exchange POST — sent here as JSON with
 * grant_type=authorization_code (the OAuth2 RFC 6749 default), which is a reasonable guess
 * for what's very likely a Rails/Doorkeeper-based provider, but isn't verified against a real
 * Big Cartel app yet. If the token exchange 400s in testing, try form-urlencoded instead.
 */
const BIGCARTEL_AUTHORIZE_BASE = process.env.BIGCARTEL_AUTHORIZE_BASE || 'https://my.bigcartel.com';
const BIGCARTEL_API_BASE = process.env.BIGCARTEL_API_BASE || 'https://api.bigcartel.com';

const getBigcartelClientId = () => process.env.BIGCARTEL_CLIENT_ID;
const getBigcartelClientSecret = () => process.env.BIGCARTEL_CLIENT_SECRET;
const getInstallCtxSecret = () => process.env.BIGCARTEL_INSTALL_CTX_SECRET || getBigcartelClientSecret();

/**
 * Big Cartel's authorize endpoint DOES echo a `state` param back on the callback (confirmed:
 * "state (optional): An arbitrary value, sent back with each response" in Big Cartel's own
 * docs), so — same technique as Wix/TikTok in this codebase — account_key rides through as a
 * signed JWT state param rather than needing an install-context cookie (BigCommerce's approach).
 */
function buildBigcartelRedirectUri(req) {
  const fromEnv = String(process.env.BIGCARTEL_REDIRECT_URI || '').trim();
  if (fromEnv) return fromEnv;
  const apiBase = req?.baseUrl ? req.baseUrl : '/api';
  return `${req.protocol}://${req.get('host')}${apiBase}/bigcartel/callback`;
}

function buildBigcartelAuthorizeUrl(state, redirectUri) {
  const clientId = getBigcartelClientId();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
  });
  return `${BIGCARTEL_AUTHORIZE_BASE}/oauth/authorize?${params.toString()}`;
}

function parseConnectionData(conn) {
  if (!conn?.data) return {};
  try {
    return typeof conn.data === 'string' ? JSON.parse(conn.data) : conn.data;
  } catch (_e) {
    return {};
  }
}

async function saveBigcartelConnection({ account_key, access_token, token_type, account_id, account_info }) {
  const getInformation = await finerworksService.GET_INFO({ account_key });
  const connections = Array.isArray(getInformation?.user_account?.connections)
    ? JSON.parse(JSON.stringify(getInformation.user_account.connections))
    : [];
  const idx = connections.findIndex((c) => c && c.name === 'Big Cartel');

  const data = {
    access_token,
    token_type: token_type || 'bearer',
    account_id,
    account_info: account_info || null,
    connected_at: new Date().toISOString(),
  };

  const entry = { name: 'Big Cartel', id: access_token, data: JSON.stringify(data) };
  if (idx === -1) connections.push(entry);
  else connections[idx] = entry;

  await finerworksService.UPDATE_INFO({ account_key, connections });
  return data;
}

async function getBigcartelConnection(account_key) {
  const getInformation = await finerworksService.GET_INFO({ account_key });
  const connections = getInformation?.user_account?.connections || [];
  const conn = connections.find((c) => c && c.name === 'Big Cartel');
  if (!conn) return null;
  const data = parseConnectionData(conn);
  return {
    access_token: data.access_token || (conn.id != null ? String(conn.id) : null),
    token_type: data.token_type || 'bearer',
    account_id: data.account_id != null ? String(data.account_id) : null,
    account_info: data.account_info || null,
  };
}

/**
 * Initiates connecting a merchant's Big Cartel shop to OFA.
 * Expected query: account_key (required), return_url (optional).
 */
const handleBigcartelAuthStart = async (req, res) => {
  try {
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'handleBigcartelAuthStart',
      accountKey: req.query?.account_key || req.body?.account_key,
      body: req.body,
      query: req.query,
    });

    const account_key = req.query?.account_key || req.body?.account_key;
    if (!account_key || !String(account_key).trim()) {
      return sendApiError(res, 400, 'Missing required parameter: account_key');
    }

    const clientId = getBigcartelClientId();
    if (!clientId) {
      return sendApiError(res, 500, 'BIGCARTEL_CLIENT_ID not configured');
    }
    const ctxSecret = getInstallCtxSecret();
    if (!ctxSecret) {
      return sendApiError(res, 500, 'Set BIGCARTEL_CLIENT_SECRET or BIGCARTEL_INSTALL_CTX_SECRET to sign the OAuth state.');
    }

    const nonce = crypto.randomBytes(16).toString('hex');
    const return_url = req.query?.return_url || req.body?.return_url || 'https://fa.finerworks.com/';
    const redirectUri = buildBigcartelRedirectUri(req);

    const state = jwt.sign(
      {
        purpose: 'bigcartel_install',
        account_key: String(account_key).trim(),
        nonce,
        return_url: String(return_url).trim(),
      },
      ctxSecret,
      { expiresIn: '15m' }
    );

    const authorizeUrl = buildBigcartelAuthorizeUrl(state, redirectUri);
    log('handleBigcartelAuthStart: redirecting to %s', authorizeUrl);

    console.log(JSON.stringify({
      level: 'INFO',
      platform: 'bigcartel',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'handleBigcartelAuthStart',
      operation: 'Big Cartel authorize redirect sent successfully',
      account_key: String(account_key).trim(),
      result: { authorizeUrl, nonce },
      timestamp: new Date().toISOString(),
    }));

    return res.redirect(authorizeUrl);
  } catch (err) {
    console.error(JSON.stringify({
      level: 'ERROR',
      platform: 'bigcartel',
      source: 'lambda',
      function: 'handleBigcartelAuthStart',
      account_key: req.query?.account_key || req.body?.account_key || 'unknown',
      message: `Big Cartel authorize initiation failed: ${err?.message || 'Unknown error'}`,
      timestamp: new Date().toISOString(),
    }));
    return sendApiError(res, err);
  }
};

/**
 * OAuth callback — exchanges `code` for an access token, fetches the account so we can store
 * its name/subdomain for display, and saves the connection.
 */
const handleBigcartelAuthCallback = async (req, res) => {
  try {
    const { code, state } = req.query || {};
    if (!code) {
      return sendApiError(res, 400, 'Missing required query parameter: code');
    }
    if (!state) {
      return sendApiError(res, 400, 'Missing required query parameter: state');
    }

    const ctxSecret = getInstallCtxSecret();
    let statePayload;
    try {
      statePayload = jwt.verify(state, ctxSecret);
    } catch (verifyErr) {
      log('handleBigcartelAuthCallback: state verification failed: %s', verifyErr?.message);
      return sendApiError(res, 400, 'Invalid or expired state parameter');
    }
    if (statePayload?.purpose !== 'bigcartel_install' || !statePayload?.account_key) {
      return sendApiError(res, 400, 'Invalid state payload');
    }
    const account_key = String(statePayload.account_key).trim();

    const clientId = getBigcartelClientId();
    const clientSecret = getBigcartelClientSecret();
    if (!clientId || !clientSecret) {
      return sendApiError(res, 500, 'Big Cartel OAuth credentials not configured');
    }

    const redirectUri = buildBigcartelRedirectUri(req);

    let tokenResp;
    try {
      tokenResp = await axios.post(
        `${BIGCARTEL_API_BASE}/oauth/token`,
        {
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
      );
    } catch (tokenErr) {
      log('handleBigcartelAuthCallback: token exchange failed: %s', tokenErr?.message);
      return sendApiError(res, tokenErr?.response?.status || 502, 'Big Cartel token exchange failed', {
        detail: tokenErr?.response?.data || null,
      });
    }

    const { access_token, token_type, account_id } = tokenResp?.data || {};
    if (!access_token || !account_id) {
      return sendApiError(res, 502, 'Big Cartel did not return an access_token/account_id');
    }

    let accountInfo = null;
    try {
      const accountResp = await axios.get(`${BIGCARTEL_API_BASE}/v1/accounts/${account_id}`, {
        headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/vnd.api+json' },
        timeout: 20000,
      });
      accountInfo = accountResp?.data?.data?.attributes || null;
    } catch (acctErr) {
      log('handleBigcartelAuthCallback: account info fetch failed (continuing): %s', acctErr?.message);
    }

    await saveBigcartelConnection({ account_key, access_token, token_type, account_id, account_info: accountInfo });

    console.log(JSON.stringify({
      level: 'INFO',
      platform: 'bigcartel',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'handleBigcartelAuthCallback',
      operation: 'Big Cartel OAuth callback handled and connection saved successfully',
      account_key,
      result: { account_id },
      timestamp: new Date().toISOString(),
    }));

    const return_url = statePayload.return_url || 'https://fa.finerworks.com/';
    if (req.query?.redirect === 'false') {
      return res.status(200).json({ success: true, message: 'Big Cartel connection added successfully', account_id });
    }
    return res.redirect(return_url);
  } catch (err) {
    console.error(JSON.stringify({
      level: 'ERROR',
      platform: 'bigcartel',
      source: err?.response ? 'bigcartel_api' : 'lambda',
      function: 'handleBigcartelAuthCallback',
      account_key: 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Big Cartel OAuth callback failed: ${err?.message || 'Unknown error'}`,
      timestamp: new Date().toISOString(),
    }));
    return sendApiError(res, err);
  }
};

/**
 * Disconnects a Big Cartel connection: revokes the token via Big Cartel's deauthorize endpoint
 * (HTTP Basic auth with client_id:client_secret — confirmed from Big Cartel's own docs), then
 * clears the stored connection. Deliberately does NOT echo the full connections array back —
 * same discipline applied to TikTok's disconnect handler earlier in this codebase, after an
 * audit flagged Square/Shopify/BigCommerce's existing disconnect handlers for leaking every
 * other connected platform's live tokens in the response.
 */
const handleBigcartelDisconnect = async (req, res) => {
  try {
    const account_key = req.body?.account_key || req.query?.account_key;
    if (!account_key || !String(account_key).trim()) {
      return sendApiError(res, 400, 'Missing required parameter: account_key');
    }
    const trimmedKey = String(account_key).trim();

    const conn = await getBigcartelConnection(trimmedKey);
    if (!conn) {
      return res.status(200).json({ success: true, message: 'No Big Cartel connection found; nothing to disconnect' });
    }

    const clientId = getBigcartelClientId();
    const clientSecret = getBigcartelClientSecret();
    if (clientId && clientSecret && conn.account_id) {
      try {
        const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        await axios.post(`${BIGCARTEL_API_BASE}/oauth/deauthorize/${conn.account_id}`, null, {
          headers: { Authorization: `Basic ${basicAuth}` },
          timeout: 20000,
        });
      } catch (revokeErr) {
        // Don't block disconnecting locally over a revoke failure (e.g. already revoked).
        log('handleBigcartelDisconnect: deauthorize call failed (continuing): %s', revokeErr?.message);
      }
    }

    const getInformation = await finerworksService.GET_INFO({ account_key: trimmedKey });
    const connections = JSON.parse(JSON.stringify(getInformation?.user_account?.connections || []));
    const idx = connections.findIndex((c) => c && c.name === 'Big Cartel');
    if (idx !== -1) {
      connections[idx] = { name: 'Big Cartel', id: null, data: null };
      await finerworksService.UPDATE_INFO({ account_key: trimmedKey, connections });
    }

    console.log(JSON.stringify({
      level: 'INFO',
      platform: 'bigcartel',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'handleBigcartelDisconnect',
      operation: 'Big Cartel disconnected successfully',
      account_key: trimmedKey,
      result: { disconnected: true },
      timestamp: new Date().toISOString(),
    }));

    return res.status(200).json({ success: true, message: 'Big Cartel disconnected successfully' });
  } catch (err) {
    console.error(JSON.stringify({
      level: 'ERROR',
      platform: 'bigcartel',
      source: 'lambda',
      function: 'handleBigcartelDisconnect',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      message: `Big Cartel disconnect failed: ${err?.message || 'Unknown error'}`,
      timestamp: new Date().toISOString(),
    }));
    return sendApiError(res, err);
  }
};

module.exports = {
  handleBigcartelAuthStart,
  handleBigcartelAuthCallback,
  handleBigcartelDisconnect,
  getBigcartelConnection,
  getBigcartelClientId,
  getBigcartelClientSecret,
  BIGCARTEL_API_BASE,
  BIGCARTEL_AUTHORIZE_BASE,
};
