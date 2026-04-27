const axios = require('axios');
const finerworksService = require('../helpers/finerworks-service');

function maskSecret(s) {
  const str = String(s || '');
  if (str.length <= 10) return '***';
  return `${str.slice(0, 6)}***${str.slice(-4)}`;
}

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

module.exports = {
  connectWix
};

