const finerworksService = require('../helpers/finerworks-service');
const shippoService = require('../helpers/shippo-service');
const { sendApiError } = require('../helpers/api-error');
const debug = require('debug');
const log = debug('app:shippoOrders');

const SHIPPO_CONNECTION_NAME = 'Shippo';

exports.fetchShippoOrders = async (req, res) => {
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
};

/**
 * Fulfills a Shippo order by fetching tracking info from FinerWorks and updating
 * the Shippo order status to SHIPPED with the tracking number.
 *
 * Body: account_key (required), order_id (Shippo order object_id), order_number (FinerWorks order_pos).
 */
exports.fulfillShippoOrderWithTrackingInfo = async (req, res) => {
  const account_key = req.body?.account_key || req.query?.account_key;
  const order_id = req.body?.order_id || req.query?.order_id;
  const order_number = req.body?.order_number || req.query?.order_number;

  if (!account_key) {
    return res.status(400).json({ statusCode: 400, status: false, message: 'account_key is required.' });
  }
  if (!order_id || !String(order_id).trim()) {
    return res.status(400).json({ statusCode: 400, status: false, message: 'Missing required parameter: order_id (Shippo order object_id).' });
  }
  if (!order_number || !String(order_number).trim()) {
    return res.status(400).json({ statusCode: 400, status: false, message: 'Missing required parameter: order_number (FinerWorks order_pos).' });
  }

  const getInfo = await finerworksService.GET_INFO({ account_key });
  const connections = getInfo?.user_account?.connections || [];
  const shippoConn = connections.find((c) => c.name === SHIPPO_CONNECTION_NAME);
  if (!shippoConn) {
    return res.status(400).json({ statusCode: 400, status: false, message: 'Shippo is not connected to this account. Call POST /shippo/connect first.' });
  }

  const { live_key, test_key } = JSON.parse(shippoConn.data || '{}');

  let orderStatusData;
  try {
    orderStatusData = await finerworksService.GET_ORDER_STATUS({ order_pos: [order_number], account_key });
  } catch (error) {
    return sendApiError(res, error);
  }

  const shipment = orderStatusData?.orders?.[0]?.shipments?.[0] || {};
  const trackingNumber = shipment?.tracking_number != null ? String(shipment.tracking_number).trim() : '';
  const trackingUrl = shipment?.tracking_url != null ? String(shipment.tracking_url).trim() : '';
  const carrierName = shipment?.carrier != null ? String(shipment.carrier).trim() : '';
  const service = shipment?.service != null ? String(shipment.service).trim() : '';

  if (!trackingNumber) {
    return res.status(400).json({ statusCode: 400, status: false, message: 'Missing tracking number in FinerWorks shipment data.' });
  }

  log('Fulfilling Shippo order order_id=%s tracking=%s', order_id, trackingNumber);

  const updatePayload = {
    order_status: 'SHIPPED',
    tracking_number: trackingNumber,
    ...(trackingUrl && { tracking_url_provider: trackingUrl }),
    ...(carrierName && { carrier_account: carrierName }),
    ...(service && { servicelevel_token: service }),
  };

  const updatedOrder = await shippoService.UPDATE_ORDER(String(order_id).trim(), updatePayload, live_key, test_key);

  return res.status(200).json({
    statusCode: 200,
    status: true,
    message: 'Shippo order fulfilled with tracking info.',
    data: updatedOrder,
  });
};
