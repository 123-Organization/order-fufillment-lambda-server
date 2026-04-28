const finerworksService = require('../helpers/finerworks-service');

/**
 * Wix App Instance Installed webhook handler.
 *
 * Wix sends `metadata.instanceId` (app instance GUID) and may send `metadata.accountInfo.siteId`.
 * We persist these into the tenant's `connections[]` so future calls can mint access tokens
 * using the OAuth client-credentials flow (requires WIX_CLIENT_SECRET).
 *
 * IMPORTANT: This server does not currently validate Wix webhook signatures. If you expose this
 * publicly, add verification using Wix's webhook signing guidance.
 *
 * How we associate a Wix install to an OFA tenant:
 * - We require `account_key` to be provided (query/body/header). In a production-grade setup,
 *   you'd typically map instanceId->tenant via your own installation UI or signed state.
 */
const handleWixAppInstanceInstalled = async (req, res) => {
  try {
    const account_key =
      req.query?.account_key ||
      req.body?.account_key ||
      req.headers['x-account-key'] ||
      req.query?.accountKey ||
      req.body?.accountKey;

    if (!account_key || !String(account_key).trim()) {
      return res.status(400).json({
        success: false,
        message:
          'Missing required parameter: account_key. Provide it as query `account_key`, body `account_key`, or header `x-account-key` so we can store the install against the correct tenant.'
      });
    }

    const instanceId = req.body?.metadata?.instanceId || req.body?.instanceId || null;
    const siteId = req.body?.metadata?.accountInfo?.siteId || req.body?.siteId || null;
    const appId = req.body?.data?.appId || req.body?.appId || null;
    const originInstanceId = req.body?.data?.originInstanceId || null;

    if (!instanceId || !String(instanceId).trim()) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field from Wix webhook payload: metadata.instanceId'
      });
    }

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
      instance_id: String(instanceId).trim(),
      site_id: siteId ? String(siteId).trim() : (existingData?.site_id || null),
      app_id: appId ? String(appId).trim() : (existingData?.app_id || null),
      origin_instance_id: originInstanceId ? String(originInstanceId).trim() : (existingData?.origin_instance_id || null),
      installed_at: new Date().toISOString()
    };

    const conn = {
      name: 'Wix',
      // Keep `id` as "last known access token" if we ever minted one; otherwise leave existing id.
      id: existing?.id || '',
      data: JSON.stringify(nextData)
    };

    if (idx !== -1) connections[idx] = conn;
    else connections.push(conn);

    await finerworksService.UPDATE_INFO({
      account_key: String(account_key).trim(),
      connections
    });

    return res.status(200).json({
      success: true,
      message: 'Wix app installation recorded',
      wix: {
        instance_id: nextData.instance_id,
        site_id: nextData.site_id,
        app_id: nextData.app_id
      }
    });
  } catch (err) {
    const status = err?.response?.status || 500;
    return res.status(status).json({
      success: false,
      message: 'Failed to process Wix app instance installed webhook',
      error: err?.response?.data || err?.message || 'Unknown error'
    });
  }
};

module.exports = {
  handleWixAppInstanceInstalled
};

