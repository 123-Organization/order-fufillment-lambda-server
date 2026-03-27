const axios = require('axios');
const crypto = require('crypto');
const finerworksService = require('../helpers/finerworks-service');

require('dotenv').config();

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
    const account_key =
      req.query?.account_key || req.body?.account_key || req.query?.accountKey;

    if (!account_key) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameter: account_key'
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
        message: 'SQUARESPACE_CLIENT_ID not configured'
      });
    }

    if (!process.env.SQUARESPACE_CLIENT_SECRET) {
      return res.status(500).json({
        success: false,
        message: 'SQUARESPACE_CLIENT_SECRET not configured'
      });
    }

    // Required by Squarespace OAuth to prevent CSRF.
    // We embed account_key into state so the callback can associate tokens with a tenant.
    const nonce = crypto.randomBytes(16).toString('hex');
    const state = base64UrlEncode(JSON.stringify({ account_key, nonce }));

    const redirectUri = buildRedirectUri(req);

    // Optional: Squarespace will pass website_id to the initiate URL for logged-in users.
    const website_id = req.query?.website_id || req.query?.websiteId || req.body?.website_id;

    const access_type =
      req.query?.access_type ||
      req.body?.access_type ||
      process.env.SQUARESPACE_ACCESS_TYPE ||
      'offline';

    // Required authorize URL
    const authUrlBase =
      'https://login.squarespace.com/api/1/login/oauth/provider/authorize';

    const qs = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes,
      state
    });

    if (website_id) qs.set('website_id', String(website_id));
    if (access_type) qs.set('access_type', String(access_type));

    const authUrl = `${authUrlBase}?${qs.toString()}`;
    return res.redirect(authUrl);
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Failed to initiate Squarespace OAuth',
      error: err?.message || 'Unknown error'
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

    if (error || access_denied) {
      return res.status(400).json({
        success: false,
        message: access_denied ? 'access_denied' : (error || 'oauth_error')
      });
    }

    if (!code || !state) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters: code, state'
      });
    }

    let stateObj = null;
    try {
      stateObj = JSON.parse(base64UrlDecode(state));
    } catch (e) {
      // Not a state we generated; treat as invalid.
      return res.status(400).json({
        success: false,
        message: 'Invalid state'
      });
    }

    const account_key = stateObj?.account_key;
    if (!account_key) {
      return res.status(400).json({
        success: false,
        message: 'Invalid state: missing account_key'
      });
    }

    const clientId = process.env.SQUARESPACE_CLIENT_ID;
    const clientSecret = process.env.SQUARESPACE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return res.status(500).json({
        success: false,
        message: 'Squarespace OAuth credentials not configured'
      });
    }

    const redirectUri = buildRedirectUri(req);

    const tokenUrl =
      'https://login.squarespace.com/api/1/login/oauth/provider/tokens';

    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const tokenResp = await axios.post(
      tokenUrl,
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
      },
      {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/json',
          // Docs: a User-Agent header is required.
          'User-Agent': 'ofa-node'
        },
        timeout: 20000
      }
    );

    const tokenData = tokenResp?.data;
    if (!tokenData?.access_token) {
      return res.status(400).json({
        success: false,
        message: 'Token exchange succeeded but access_token missing',
        data: tokenData
      });
    }

    const getInformation = await finerworksService.GET_INFO({ account_key });
    const connections = getInformation?.user_account?.connections || [];

    // Replace existing Squarespace connection (if any).
    const nextConnections = Array.isArray(connections)
      ? (() => {
          const idx = connections.findIndex((c) => c && c.name === 'Squarespace');
          const copy = JSON.parse(JSON.stringify(connections));
          if (idx !== -1) copy.splice(idx, 1);
          copy.push({
            name: 'Squarespace',
            // Keep the same pattern as Shopify: id stores access token.
            id: tokenData.access_token,
            data: JSON.stringify({
              ...tokenData,
              redirect_uri: redirectUri,
              state_nonce: stateObj?.nonce
            })
          });
          return copy;
        })()
      : [
          {
            name: 'Squarespace',
            id: tokenData.access_token,
            data: JSON.stringify(tokenData)
          }
        ];

    await finerworksService.UPDATE_INFO({
      account_key,
      connections: nextConnections
    });

    if (return_url) {
      const sep = return_url.includes('?') ? '&' : '?';
      return res.redirect(`${return_url}${sep}success=1`);
    }

    return res.status(200).json({
      success: true,
      message: 'Squarespace connection added successfully'
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Failed to process Squarespace callback',
      error: err?.message || 'Unknown error'
    });
  }
};

module.exports = {
  handleSquarespaceAuth,
  handleSquarespaceCallback
};

