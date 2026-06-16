const axios = require('axios');
const crypto = require('crypto');
const finerworksService = require('../helpers/finerworks-service');
const { sendApiError } = require('../helpers/api-error');

require('dotenv').config();

// Build redirect URI for Etsy callback. Keep stable between start + callback.
const buildEtsyRedirectUri = (req) => {
  const fromEnv = process.env.ETSY_REDIRECT_URI && String(process.env.ETSY_REDIRECT_URI).trim();
  if (fromEnv) return fromEnv.split('?')[0].replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}/etsy/callback`;
};

// Start OAuth: redirect user to Etsy authorization page.
const handleEtsyAuthStart = async (req, res) => {
  try {
    const account_key = req.query?.account_key || req.body?.account_key || null;
    if (!account_key) return sendApiError(res, 400, 'Missing required parameter: account_key');

    const clientId = process.env.ETSY_CLIENT_ID || process.env.ETSY_API_KEY || null;
    if (!clientId) return sendApiError(res, 500, 'ETSY client id not configured');

    const state = crypto.randomBytes(16).toString('hex');
    // store minimal state mapping if needed; we include account_key in `state` query param for convenience
    const statePayload = Buffer.from(JSON.stringify({ state, account_key })).toString('base64');

    const redirectUri = buildEtsyRedirectUri(req);
    const scopes = process.env.ETSY_SCOPES || 'transactions_r shops_r listings_r';

    const authUrl =
      `https://www.etsy.com/oauth/connect?` +
      `response_type=code&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `scope=${encodeURIComponent(scopes)}&` +
      `client_id=${encodeURIComponent(clientId)}&` +
      `state=${encodeURIComponent(statePayload)}`;
      console.log('Redirecting to Etsy auth URL:', authUrl);

    return res.redirect(authUrl);
  } catch (err) {
    return sendApiError(res, err);
  }
};

// Callback: exchange code for tokens and persist connection
const handleEtsyCallback = async (req, res) => {
  try {
    const { code, state } = req.query || {};
    if (!code) return sendApiError(res, 400, 'Missing required parameter: code');

    const redirectUri = buildEtsyRedirectUri(req);
    const clientId = process.env.ETSY_CLIENT_ID || null;
    const clientSecret = process.env.ETSY_CLIENT_SECRET || null;
    if (!clientId || !clientSecret) return sendApiError(res, 500, 'ETSY client credentials not configured');

    const tokenUrl = 'https://api.etsy.com/v3/public/oauth/token';

    const authHeader = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;

    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('client_id', clientId);
    params.append('redirect_uri', redirectUri);
    params.append('code', code);

    const resp = await axios.post(tokenUrl, params.toString(), {
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 20000,
    });

    const tokenData = resp?.data || {};
    // Attempt to extract account_key from `state` if we encoded it earlier
    let account_key = null;
    try {
      if (state) {
        const decoded = Buffer.from(String(state), 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        account_key = parsed?.account_key || null;
      }
    } catch (_) {
      account_key = null;
    }

    // Persist connection into finerworksService connections array
    if (!account_key) {
      // If no account_key was supplied, simply return token data
      return res.status(200).json({ success: true, token: tokenData });
    }

    const getInformation = await finerworksService.GET_INFO({ account_key });
    const connections = Array.isArray(getInformation?.user_account?.connections)
      ? JSON.parse(JSON.stringify(getInformation.user_account.connections))
      : [];

    const etsyConn = {
      name: 'Etsy',
      id: tokenData?.access_token || '',
      data: JSON.stringify({
        token: tokenData,
        connected_at: new Date().toISOString(),
      }),
    };

    const idx = connections.findIndex((c) => c && c.name === 'Etsy');
    if (idx !== -1) connections[idx] = etsyConn;
    else connections.push(etsyConn);

    await finerworksService.UPDATE_INFO({ account_key, connections });

    return res.status(200).json({ success: true, message: 'Etsy connection added', etsy: etsyConn });
  } catch (err) {
    return sendApiError(res, err);
  }
};

// Disconnect Etsy: remove or nullify connection
const handleEtsyDisconnect = async (req, res) => {
  try {
    const account_key = req.body?.account_key || null;
    if (!account_key) return sendApiError(res, 400, 'Missing required parameter: account_key');

    const getInformation = await finerworksService.GET_INFO({ account_key });
    const connections = Array.isArray(getInformation?.user_account?.connections)
      ? JSON.parse(JSON.stringify(getInformation.user_account.connections))
      : [];

    const idx = connections.findIndex((c) => c && c.name === 'Etsy');
    if (idx === -1) {
      return res.status(200).json({ success: true, message: 'No Etsy connection found', connections });
    }

    connections[idx] = { name: 'Etsy', id: null, data: null };
    await finerworksService.UPDATE_INFO({ account_key, connections });

    return res.status(200).json({ success: true, message: 'Etsy disconnected', connections });
  } catch (err) {
    return sendApiError(res, err);
  }
};

module.exports = {
  handleEtsyAuthStart,
  handleEtsyCallback,
  handleEtsyDisconnect,
};
