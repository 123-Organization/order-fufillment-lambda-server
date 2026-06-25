const finerworksService = require('../helpers/finerworks-service');
const shippoService = require('../helpers/shippo-service');
const { cloneConnections, findConnectionIndex } = require('../helpers/platform-connections');
const { sendApiError } = require('../helpers/api-error');
const debug = require('debug');
const log = debug('app:shippoAuth');

const SHIPPO_CONNECTION_NAME = 'Shippo';

exports.connectShippo = async (req, res) => {
  try {
    const { account_key, live_key, test_key } = req.body;
    if (!account_key || !live_key || !test_key) {
      return res.status(400).json({ statusCode: 400, status: false, message: 'Account key and Shippo API Keys are required.' });
    }

    await shippoService.VALIDATE_CONNECTION(live_key, test_key);

    const getInfo = await finerworksService.GET_INFO({ account_key });
    const connections = cloneConnections(getInfo?.user_account?.connections);

    const idx = findConnectionIndex(connections, SHIPPO_CONNECTION_NAME);
    const connectionData = JSON.stringify({ isConnected: true, live_key, test_key });

    if (idx >= 0) {
      connections[idx] = { ...connections[idx], data: connectionData };
    } else {
      connections.push({ name: SHIPPO_CONNECTION_NAME, data: connectionData });
    }

    await finerworksService.UPDATE_INFO({ account_key, connections });
    log('Shippo connected for account_key=%s', account_key);

    return res.status(200).json({ statusCode: 200, status: true, message: 'Shippo connected successfully.' });
  } catch (err) {
    const isShippoError = err?.response?.config?.url?.includes('shippo') || err?.config?.url?.includes('shippo');
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'shippo',
      source: isShippoError ? 'shippo_api' : (isFinerworksError ? 'finerworks_api' : 'lambda'),
      function: 'connectShippo',
      account_key: req.body?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Shippo connection setup failed: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.detail || err?.response?.data?.message || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in connectShippo: %s', errorJson);
    return sendApiError(res, err);
  }
};

exports.getShippoStatus = async (req, res) => {
  try {
    const { account_key } = req.body;
    if (!account_key) {
      return res.status(400).json({ statusCode: 400, status: false, message: 'account_key is required.' });
    }

    const getInfo = await finerworksService.GET_INFO({ account_key });
    const connections = getInfo?.user_account?.connections || [];
    const shippoConn = connections.find((c) => c.name === SHIPPO_CONNECTION_NAME);

    let isConnected = false;
    if (shippoConn) {
      try {
        isConnected = JSON.parse(shippoConn.data || '{}')?.isConnected === true;
      } catch (_) {
        isConnected = false;
      }
    }

    return res.status(200).json({ statusCode: 200, status: true, isConnected });
  } catch (err) {
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'shippo',
      source: 'finerworks_api',
      function: 'getShippoStatus',
      account_key: req.body?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to retrieve Shippo connection status from FinerWorks: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in getShippoStatus: %s', errorJson);
    return sendApiError(res, err);
  }
};
