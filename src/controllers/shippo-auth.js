const finerworksService = require('../helpers/finerworks-service');
const shippoService = require('../helpers/shippo-service');
const { cloneConnections, findConnectionIndex } = require('../helpers/platform-connections');
const debug = require('debug');
const log = debug('app:shippoAuth');

const SHIPPO_CONNECTION_NAME = 'Shippo';

exports.connectShippo = async (req, res) => {
  const { account_key } = req.body;
  if (!account_key) {
    return res.status(400).json({ statusCode: 400, status: false, message: 'account_key is required.' });
  }

  await shippoService.VALIDATE_CONNECTION();

  const getInfo = await finerworksService.GET_INFO({ account_key });
  const connections = cloneConnections(getInfo?.user_account?.connections);

  const idx = findConnectionIndex(connections, SHIPPO_CONNECTION_NAME);
  const connectionData = JSON.stringify({ isConnected: true });

  if (idx >= 0) {
    connections[idx] = { ...connections[idx], data: connectionData };
  } else {
    connections.push({ name: SHIPPO_CONNECTION_NAME, data: connectionData });
  }

  await finerworksService.UPDATE_INFO({ account_key, connections });
  log('Shippo connected for account_key=%s', account_key);

  return res.status(200).json({ statusCode: 200, status: true, message: 'Shippo connected successfully.' });
};

exports.disconnectShippo = async (req, res) => {
  const { account_key } = req.body;
  if (!account_key) {
    return res.status(400).json({ statusCode: 400, status: false, message: 'account_key is required.' });
  }

  const getInfo = await finerworksService.GET_INFO({ account_key });
  const connections = cloneConnections(getInfo?.user_account?.connections).filter(
    (c) => c.name !== SHIPPO_CONNECTION_NAME
  );

  await finerworksService.UPDATE_INFO({ account_key, connections });
  log('Shippo disconnected for account_key=%s', account_key);

  return res.status(200).json({ statusCode: 200, status: true, message: 'Shippo disconnected.' });
};

exports.getShippoStatus = async (req, res) => {
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
};
