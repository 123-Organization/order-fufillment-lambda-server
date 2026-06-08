const axios = require('axios');
const crypto = require('crypto');
const finerworksService = require('../helpers/finerworks-service');
const {
  putSquarespaceAccount,
  scanAllSquarespaceAccounts,
} = require('../helpers/squarespace-accounts-dynamo');
const debug = require('debug');
const log = debug('app:squarespaceAuth');
require('dotenv').config();
const { validateAccountKey } = require('../validators/accountKey.validator');

const base64UrlEncode = (input) => {
  const b64 = Buffer.from(input, 'utf8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const base64UrlDecode = (input) => {
  const b64 = String(input).replace(/-/g, '+').replace(/_/g, '/');
  // Pad to a valid base64 length
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  return Buffer.from(b64 + pad, 'base64').toString('utf8');
};

const getApiBaseUrl = (req) => (req.baseUrl ? req.baseUrl : '/api');

const buildRedirectUri = (req) => {
  // Keep redirect_uri consistent between initiate + callback.
  return (
    process.env.SQUARESPACE_REDIRECT_URI ||
    `${req.protocol}://${req.get('host')}${getApiBaseUrl(req)}/squarespace/callback`
  );
};

/**
 * Initiates Squarespace OAuth connection by redirecting user to Squarespace /authorize.
 * Expected query/body:
 * - account_key (required): OFA/FinerWorks tenant account key
 * - website_id (optional): Squarespace site id (if Squarespace provides it on initiate URL)
 * - scope (optional): comma-separated squarespace permissions
 * - access_type (optional): use "offline" to receive refresh_token
 */
const handleSquarespaceAuth = async (req, res) => {
  try {
    const account_key = req.query?.account_key || req.body?.account_key || req.query?.accountKey;

    const { valid, error } = validateAccountKey(account_key);
    if (!valid) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    const clientId = process.env.SQUARESPACE_CLIENT_ID;
    const scopes =
      req.query?.scope ||
      req.body?.scope ||
      process.env.SQUARESPACE_SCOPES ||
      'website.inventory,website.products,website.orders';

    if (!clientId) {
      return res.status(500).json({
        success: false,
        message: 'SQUARESPACE_CLIENT_ID not configured',
      });
    }

    if (!process.env.SQUARESPACE_CLIENT_SECRET) {
      return res.status(500).json({
        success: false,
        message: 'SQUARESPACE_CLIENT_SECRET not configured',
      });
    }

    // Required by Squarespace OAuth to prevent CSRF.
    // We embed account_key into state so the callback can associate tokens with a tenant.
    const nonce = crypto.randomBytes(16).toString('hex');
    const state = base64UrlEncode(JSON.stringify({ account_key, nonce }));

    const redirectUri = buildRedirectUri(req);
    console.log('redirectUri', redirectUri);

    // Optional: Squarespace will pass website_id to the initiate URL for logged-in users.
    const website_id = req.query?.website_id || req.query?.websiteId || req.body?.website_id;

    const access_type =
      req.query?.access_type ||
      req.body?.access_type ||
      process.env.SQUARESPACE_ACCESS_TYPE ||
      'offline';

    // Required authorize URL
    const authUrlBase = 'https://login.squarespace.com/api/1/login/oauth/provider/authorize';

    const qs = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes,
      state,
    });

    if (website_id) qs.set('website_id', String(website_id));
    if (access_type) qs.set('access_type', String(access_type));

    const authUrl = `${authUrlBase}?${qs.toString()}`;
    console.log('authUrl====>>>', authUrl);
    return res.redirect(authUrl);
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Failed to initiate Squarespace OAuth',
      error: err?.message || 'Unknown error',
    });
  }
};

/**
 * OAuth callback handler:
 * - exchanges `code` for access_token/refresh_token via POST /tokens
 * - saves the tokens into FinerWorks tenant connections
 * - optionally redirects the browser (if return_url provided)
 */
const handleSquarespaceCallback = async (req, res) => {
  try {
    const code = req.query?.code;
    const state = req.query?.state;
    const error = req.query?.error;
    const access_denied = req.query?.access_denied;
    const return_url = req.query?.return_url;
    log('handleSquarespaceCallback', { code, state, error, access_denied, return_url });
    if (error || access_denied) {
      return res.status(400).json({
        success: false,
        message: access_denied ? 'access_denied' : error || 'oauth_error',
      });
    }

    if (!code || !state) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters: code, state',
      });
    }

    let stateObj = null;
    try {
      stateObj = JSON.parse(base64UrlDecode(state));
    } catch (_e) {
      // Not a state we generated; treat as invalid.
      return res.status(400).json({
        success: false,
        message: 'Invalid state',
      });
    }

    const account_key = stateObj?.account_key;
    if (!account_key) {
      return res.status(400).json({
        success: false,
        message: 'Invalid state: missing account_key',
      });
    }

    const clientId = process.env.SQUARESPACE_CLIENT_ID;
    const clientSecret = process.env.SQUARESPACE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return res.status(500).json({
        success: false,
        message: 'Squarespace OAuth credentials not configured',
      });
    }

    const redirectUri = buildRedirectUri(req);

    const tokenUrl = 'https://login.squarespace.com/api/1/login/oauth/provider/tokens';

    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const tokenResp = await axios.post(
      tokenUrl,
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      },
      {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/json',
          // Docs: a User-Agent header is required.
          'User-Agent': 'ofa-node',
        },
        timeout: 20000,
      }
    );

    const tokenData = tokenResp?.data;
    if (!tokenData?.access_token) {
      return res.status(400).json({
        success: false,
        message: 'Token exchange succeeded but access_token missing',
        data: tokenData,
      });
    }

    const getInformation = await finerworksService.GET_INFO({ account_key });
    const connections = getInformation?.user_account?.connections || [];

    // Replace existing Squarespace connection (if any).
    const nextConnections = Array.isArray(connections)
      ? (() => {
          const idx = connections.findIndex((c) => c && c.name === 'Squarespace');
          const copy = JSON.parse(JSON.stringify(connections));
          const previous = idx !== -1 ? copy[idx] : null;
          let previousData = {};
          if (previous?.data) {
            try {
              previousData =
                typeof previous.data === 'string'
                  ? JSON.parse(previous.data)
                  : { ...previous.data };
            } catch (_) {
              previousData = {};
            }
          }
          if (idx !== -1) copy.splice(idx, 1);
          const mergedData = {
            ...previousData,
            ...tokenData,
            redirect_uri: redirectUri,
            state_nonce: stateObj?.nonce,
            needs_reauth: false,
          };
          if (previous?.order_sync === true && mergedData.order_sync === undefined) {
            mergedData.order_sync = true;
          }

          copy.push({
            name: 'Squarespace',
            // Keep the same pattern as Shopify: id stores access token.
            id: tokenData.access_token,
            data: JSON.stringify(mergedData),
          });
          return copy;
        })()
      : [
          {
            name: 'Squarespace',
            id: tokenData.access_token,
            data: JSON.stringify({
              ...tokenData,
              needs_reauth: false,
            }),
          },
        ];

    await finerworksService.UPDATE_INFO({
      account_key,
      connections: nextConnections,
    });

    try {
      await putSquarespaceAccount({
        id: crypto.randomUUID(),
        account_key,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token || null,
        expires_in: tokenData.expires_in ?? null,
        token_type: tokenData.token_type ?? null,
        redirect_uri: redirectUri,
        scope: tokenData.scope ?? null,
        needs_reauth: false,
      });
    } catch (dynamoErr) {
      console.error('Failed to write Squarespace account to DynamoDB', dynamoErr);
    }

    if (return_url) {
      const sep = return_url.includes('?') ? '&' : '?';
      return res.redirect(`${return_url}${sep}success=1`);
    }

    return res.status(200).json({
      success: true,
      message: 'Squarespace connection added successfully',
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Failed to process Squarespace callback',
      error: err?.message || 'Unknown error',
    });
  }
};

const exchangeSquarespaceRefreshToken = async (refresh_token) => {
  const clientId = process.env.SQUARESPACE_CLIENT_ID;
  const clientSecret = process.env.SQUARESPACE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Squarespace OAuth credentials not configured');
  }

  const tokenUrl = 'https://login.squarespace.com/api/1/login/oauth/provider/tokens';
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const tokenResp = await axios.post(
    tokenUrl,
    {
      grant_type: 'refresh_token',
      refresh_token: String(refresh_token).trim(),
    },
    {
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/json',
        'User-Agent': process.env.SQUARESPACE_USER_AGENT || 'ofa-node',
      },
      timeout: 20000,
    }
  );

  return tokenResp?.data || {};
};

/** Squarespace returns 401 + structured body when refresh token is dead; only then try FinerWorks fallback. */
function isSquarespaceInvalidRefreshTokenError(err) {
  const d = err?.response?.data;
  if (!d || typeof d !== 'object') return false;
  if (d.subtype === 'invalid-refresh-token') return true;
  if (d.details?.refresh_token?.errorCode === 'invalid-refresh-token') return true;
  return false;
}

/**
 * Reads OAuth material from FinerWorks `connections` Squarespace entry (may be newer than Dynamo after a web re-link).
 */
async function getFinerworksSquarespaceOAuthSnapshot(account_key) {
  const getInformation = await finerworksService.GET_INFO({ account_key });
  const connections = getInformation?.user_account?.connections;
  if (!Array.isArray(connections)) return null;
  const conn = connections.find((c) => c && c.name === 'Squarespace');
  if (!conn) return null;

  let data = {};
  if (typeof conn.data === 'string') {
    try {
      data = JSON.parse(conn.data);
    } catch (_) {
      data = {};
    }
  } else if (conn.data && typeof conn.data === 'object') {
    data = { ...conn.data };
  }

  const refresh_token = data.refresh_token != null ? String(data.refresh_token).trim() : '';
  const access_token =
    data.access_token != null
      ? String(data.access_token).trim()
      : conn.id != null
        ? String(conn.id).trim()
        : '';

  return {
    refresh_token: refresh_token || null,
    access_token: access_token || null,
    redirect_uri: data.redirect_uri ?? null,
    scope: data.scope ?? null,
  };
}

/**
 * Marks Squarespace connection in FinerWorks so the app/UI can prompt for OAuth again.
 * Does not remove existing tokens (so partial recovery / support is still possible).
 */
async function markSquarespaceNeedsReauthInFinerworks(account_key, reasonCode) {
  const getInformation = await finerworksService.GET_INFO({ account_key });
  const connections = Array.isArray(getInformation?.user_account?.connections)
    ? JSON.parse(JSON.stringify(getInformation.user_account.connections))
    : [];
  const idx = connections.findIndex((c) => c && c.name === 'Squarespace');
  if (idx === -1) return;

  const existingDataRaw = connections[idx]?.data;
  let existingData = {};
  if (typeof existingDataRaw === 'string') {
    try {
      existingData = JSON.parse(existingDataRaw);
    } catch (_) {
      existingData = {};
    }
  } else if (existingDataRaw && typeof existingDataRaw === 'object') {
    existingData = { ...existingDataRaw };
  }

  const mergedData = {
    ...existingData,
    needs_reauth: true,
    needs_reauth_reason: reasonCode || 'invalid-refresh-token',
    needs_reauth_at: new Date().toISOString(),
  };

  connections[idx] = {
    name: 'Squarespace',
    id: connections[idx].id,
    data: JSON.stringify(mergedData),
  };

  await finerworksService.UPDATE_INFO({ account_key, connections });
}

/**
 * Refreshes tokens using Dynamo row first; if Squarespace rejects the refresh token, retries with FinerWorks
 * `connections[].data` refresh_token when it differs (e.g. user re-linked in browser but cron still had stale Dynamo).
 * New pairs can only be issued by Squarespace after user completes OAuth again — there is no server-side mint.
 */
async function refreshSquarespaceTokensForRenewalJob(account_key, dynamoRefreshToken) {
  const rtDynamo = String(dynamoRefreshToken || '').trim();
  try {
    return await refreshSquarespaceTokensCore(account_key, rtDynamo);
  } catch (primaryErr) {
    if (!isSquarespaceInvalidRefreshTokenError(primaryErr)) {
      throw primaryErr;
    }

    let fw = null;
    try {
      fw = await getFinerworksSquarespaceOAuthSnapshot(account_key);
    } catch (fwErr) {
      log('renewal: FinerWorks snapshot failed', { account_key, message: fwErr?.message });
    }

    const rtFw = fw?.refresh_token ? String(fw.refresh_token).trim() : '';
    if (rtFw && rtFw !== rtDynamo) {
      log('renewal: retry refresh with FinerWorks refresh_token', { account_key });
      return await refreshSquarespaceTokensCore(account_key, rtFw);
    }

    throw primaryErr;
  }
}

const saveSquarespaceTokensToFinerworks = async (account_key, tokenData) => {
  if (!tokenData?.access_token) {
    throw new Error('Squarespace token payload missing access_token');
  }

  const getInformation = await finerworksService.GET_INFO({ account_key });
  const connections = Array.isArray(getInformation?.user_account?.connections)
    ? JSON.parse(JSON.stringify(getInformation.user_account.connections))
    : [];

  const idx = connections.findIndex((c) => c && c.name === 'Squarespace');
  const existingDataRaw = idx !== -1 ? connections[idx]?.data : null;
  let existingData = {};
  if (typeof existingDataRaw === 'string') {
    try {
      existingData = JSON.parse(existingDataRaw);
    } catch (_) {
      existingData = {};
    }
  } else if (existingDataRaw && typeof existingDataRaw === 'object') {
    existingData = existingDataRaw;
  }

  const mergedData = {
    ...existingData,
    ...tokenData,
    needs_reauth: false,
  };
  delete mergedData.needs_reauth_reason;
  delete mergedData.needs_reauth_at;

  if (idx !== -1 && connections[idx]?.order_sync === true && mergedData.order_sync === undefined) {
    mergedData.order_sync = true;
  }

  const nextConnection = {
    name: 'Squarespace',
    id: tokenData.access_token,
    data: JSON.stringify(mergedData),
  };

  if (idx !== -1) {
    connections[idx] = nextConnection;
  } else {
    connections.push(nextConnection);
  }

  await finerworksService.UPDATE_INFO({
    account_key,
    connections,
  });
};

const refreshSquarespaceTokensCore = async (account_key, refresh_token) => {
  const tokenData = await exchangeSquarespaceRefreshToken(refresh_token);
  if (!tokenData?.access_token) {
    const err = new Error('Token refresh response missing access_token');
    err.tokenData = tokenData;
    throw err;
  }
  await saveSquarespaceTokensToFinerworks(account_key, tokenData);
  return tokenData;
};

/**
 * Refreshes Squarespace access token using refresh_token and persists
 * the new access/refresh token into tenant connections.
 *
 * Expected body/query:
 * - account_key (required)
 * - refresh_token (required)
 */
const refreshSquarespaceToken = async (req, res) => {
  try {
    const account_key =
      req.body?.account_key ||
      req.body?.accountKey ||
      req.query?.account_key ||
      req.query?.accountKey;
    const refresh_token =
      req.body?.refresh_token ||
      req.body?.refreshToken ||
      req.query?.refresh_token ||
      req.query?.refreshToken;

    if (!account_key || !refresh_token) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters: account_key and refresh_token',
      });
    }

    const tokenData = await refreshSquarespaceTokensCore(account_key, refresh_token);

    return res.status(200).json({
      success: true,
      message: 'Squarespace token refreshed successfully',
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || refresh_token,
      expires_in: tokenData.expires_in ?? null,
    });
  } catch (err) {
    if (err?.tokenData) {
      return res.status(400).json({
        success: false,
        message: err.message,
        data: err.tokenData,
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Failed to refresh Squarespace token',
      error: err?.response?.data || err?.message || 'Unknown error',
    });
  }
};

/**
 * Scans `squarespace-accounts` DynamoDB table, refreshes tokens, updates FinerWorks
 * connections, and writes refreshed tokens back to DynamoDB.
 */
const runSquarespaceTokenRenewalJob = async () => {
  const rows = await scanAllSquarespaceAccounts();
  const summary = { renewed: [], skipped: [], errors: [], needs_reauth: [] };

  for (const row of rows) {
    log('runSquarespaceTokenRenewalJob', { row });
    const account_key = row.account_key;
    const refresh_token = row.refresh_token;
    if (!account_key || !refresh_token) {
      summary.skipped.push({
        account_key: account_key || null,
        reason: 'missing account_key or refresh_token',
      });
      continue;
    }

    if (row.id == null || String(row.id).trim() === '') {
      summary.skipped.push({
        account_key,
        reason: 'missing id on DynamoDB item',
      });
      continue;
    }

    try {
      const tokenData = await refreshSquarespaceTokensForRenewalJob(account_key, refresh_token);
      await putSquarespaceAccount({
        id: row.id,
        account_key,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token || refresh_token,
        expires_in: tokenData.expires_in ?? null,
        token_type: tokenData.token_type ?? null,
        redirect_uri: row.redirect_uri ?? null,
        scope: tokenData.scope ?? row.scope ?? null,
        needs_reauth: false,
      });
      summary.renewed.push(account_key);
    } catch (err) {
      console.error(
        'Squarespace token renewal failed',
        account_key,
        err?.response?.data || err?.message
      );
      summary.errors.push({
        account_key,
        message: err?.message || 'Unknown error',
        ...(isSquarespaceInvalidRefreshTokenError(err) ? { code: 'invalid-refresh-token' } : {}),
      });

      if (isSquarespaceInvalidRefreshTokenError(err)) {
        try {
          await markSquarespaceNeedsReauthInFinerworks(account_key, 'invalid-refresh-token');
        } catch (markFwErr) {
          console.error(
            'Failed to mark Squarespace needs_reauth in FinerWorks',
            account_key,
            markFwErr?.message
          );
        }
        try {
          await putSquarespaceAccount({
            id: row.id,
            account_key,
            access_token: row.access_token,
            refresh_token: row.refresh_token,
            expires_in: row.expires_in ?? null,
            token_type: row.token_type ?? null,
            redirect_uri: row.redirect_uri ?? null,
            scope: row.scope ?? null,
            needs_reauth: true,
            needs_reauth_reason: 'invalid-refresh-token',
            needs_reauth_at: new Date().toISOString(),
          });
          summary.needs_reauth.push(account_key);
        } catch (dynamoErr) {
          console.error(
            'Failed to write needs_reauth to DynamoDB',
            account_key,
            dynamoErr?.message
          );
        }
      }
    }
  }

  return summary;
};

module.exports = {
  handleSquarespaceAuth,
  handleSquarespaceCallback,
  refreshSquarespaceToken,
  runSquarespaceTokenRenewalJob,
};
