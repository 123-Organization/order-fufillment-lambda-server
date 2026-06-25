const finerworksService = require('../helpers/finerworks-service');
const shippoService = require('../helpers/shippo-service');
const { sendApiError } = require('../helpers/api-error');
const debug = require('debug');
const log = debug('app:shippoOrders');

const SHIPPO_CONNECTION_NAME = 'Shippo';

exports.fetchShippoOrders = async (req, res) => {
  try {
    const { account_key, status, page, results } = req.body;

    if (!account_key) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: 'account_key is required.',
      });
    }

    const getInfo = await finerworksService.GET_INFO({ account_key });
    const accountId = getInfo?.user_account?.account_id;
    if (!accountId) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: 'Could not resolve account ID from account_key.',
      });
    }

    const connections = getInfo?.user_account?.connections || [];
    const shippoConn = connections.find((c) => c.name === SHIPPO_CONNECTION_NAME);
    if (!shippoConn) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: 'Shippo is not connected to this account. Call POST /shippo/connect first.',
      });
    }

    log('Fetching Shippo orders status=%s page=%s results=%s', status, page, results);
    const { live_key, test_key } = JSON.parse(shippoConn.data || '{}');
    const shippoResponse = await shippoService.GET_ORDERS({ status, page, results, liveKey: live_key, testKey: test_key });
    const shippoOrders = shippoResponse.results || [];
    const etsyOrders = shippoOrders.filter((o) => o.shop_app === 'Etsy');

    if (!etsyOrders.length) {
      return res.status(200).json({
        statusCode: 200,
        status: true,
        message: 'No orders found for the given filters.',
        data: [],
        skipped: [],
      });
    }

    return res.status(200).json({
      statusCode: 200,
      status: true,
      message: `Etsy orders fetched successfully from Shippo. Total: ${etsyOrders.length}`,
      data: etsyOrders,
      pagination: {
        count: etsyOrders.length,
      },
    });
  } catch (err) {
    const isShippoError = err?.response?.config?.url?.includes('shippo') || err?.config?.url?.includes('shippo');
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'shippo',
      source: isShippoError ? 'shippo_api' : (isFinerworksError ? 'finerworks_api' : 'lambda'),
      function: 'fetchShippoOrders',
      account_key: req.body?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to fetch Shippo orders: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.detail || err?.response?.data?.message || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in fetchShippoOrders: %s', errorJson);
    return sendApiError(res, err);
  }
};
