const finerworksService = require('../helpers/finerworks-service');
const { deleteSquarespaceAccountsByAccountKey } = require('../helpers/squarespace-accounts-dynamo');
const { sendApiError } = require('../helpers/api-error');
const debug = require('debug');
const log = debug('app:disconnectStore');

function normalizeSlug(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function slugToConnectionName(slug) {
  const s = normalizeSlug(slug);
  if (s === 'wix') return 'Wix';
  if (s === 'squarespace') return 'Squarespace';
  if (s === 'shippo') return 'Shippo';
  return null;
}

/**
 * Disconnect a 3rd-party store integration by removing its connection object.
 *
 * Query:
 * - slug: "wix" | "squarespace" | "shippo"
 *
 * Body:
 * - account_key: string
 */
exports.disconnectStoreBySlug = async (req, res) => {
  try {
    const slug = req.query?.slug;
    const connectionName = slugToConnectionName(slug);
    if (!connectionName) {
      return sendApiError(res, 400, 'Invalid slug. Expected one of: squarespace, wix');
    }

    const account_key =
      req.body?.account_key ||
      req.body?.accountKey ||
      req.query?.account_key ||
      req.query?.accountKey;

    if (!account_key || !String(account_key).trim()) {
      return sendApiError(res, 400, 'Missing required parameter: account_key');
    }

    const trimmedKey = String(account_key).trim();

    const getInformation = await finerworksService.GET_INFO({ account_key: trimmedKey });
    const connections = Array.isArray(getInformation?.user_account?.connections)
      ? JSON.parse(JSON.stringify(getInformation.user_account.connections))
      : [];

    const before = connections.length;
    const nextConnections = connections.filter((c) => !(c && c.name === connectionName));

    if (nextConnections.length === before) {
      if (connectionName === 'Squarespace') {
        await deleteSquarespaceAccountsByAccountKey(trimmedKey);
      }
      const successLog = JSON.stringify({
        level: 'INFO',
        platform: connectionName?.toLowerCase() || 'unknown',
        method: req.method,
        api: req.originalUrl || req.url,
        function: 'disconnectStoreBySlug',
        operation: `No ${connectionName} connection found; nothing to disconnect`,
        account_key: req.body?.account_key || req.query?.account_key || 'unknown',
        result: { disconnected: false, reason: 'not_found' },
        timestamp: new Date().toISOString()
      });
      // console.log(successLog);
      log('Success in disconnectStoreBySlug: %s', successLog);
      return res.status(200).json({
        success: true,
        message: `No ${connectionName} connection found; nothing to disconnect`,
        connections: nextConnections,
      });
    }

    await finerworksService.UPDATE_INFO({
      account_key: trimmedKey,
      connections: nextConnections,
    });

    if (connectionName === 'Squarespace') {
      await deleteSquarespaceAccountsByAccountKey(trimmedKey);
    }

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: connectionName?.toLowerCase() || 'unknown',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'disconnectStoreBySlug',
      operation: `${connectionName} disconnected successfully`,
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      result: { disconnected: true, remainingConnections: nextConnections.length },
      timestamp: new Date().toISOString()
    });
    console.log(successLog);
    log('Success in disconnectStoreBySlug: %s', successLog);
    return res.status(200).json({
      success: true,
      message: `${connectionName} disconnected successfully`,
      connections: nextConnections,
    });
  } catch (err) {
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'unknown',
      source: isFinerworksError ? 'finerworks_api' : 'lambda',
      function: 'disconnectStoreBySlug',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to disconnect store: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.error || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in disconnectStoreBySlug: %s', errorJson);
    return sendApiError(res, err);
  }
};
