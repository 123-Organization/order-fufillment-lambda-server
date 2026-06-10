const finerworksService = require('../helpers/finerworks-service');
const { deleteSquarespaceAccountsByAccountKey } = require('../helpers/squarespace-accounts-dynamo');
const { sendApiError } = require('../helpers/api-error');

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
  return null;
}

/**
 * Disconnect a 3rd-party store integration by removing its connection object.
 *
 * Query:
 * - slug: "wix" | "squarespace"
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

    return res.status(200).json({
      success: true,
      message: `${connectionName} disconnected successfully`,
      connections: nextConnections,
    });
  } catch (err) {
    return sendApiError(res, err);
  }
};
