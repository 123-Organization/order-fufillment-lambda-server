const finerworksService = require('../helpers/finerworks-service');
const shippoService = require('../helpers/shippo-service');
const debug = require('debug');
const log = debug('app:shippoOrders');

const SHIPPO_CONNECTION_NAME = 'Shippo';
const UPLOAD_SOURCE = 'Shippo';

function generateGUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function splitFullName(fullName = '') {
  const parts = String(fullName).trim().split(/\s+/);
  if (parts.length === 1) return { first_name: parts[0], last_name: '' };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

function mapShippoOrder(shippoOrder) {
  const addr = shippoOrder.to_address || {};
  const { first_name, last_name } = splitFullName(addr.name);
  const isUS = String(addr.country || '').toUpperCase() === 'US';

  const recipient = {
    first_name,
    last_name,
    company_name: addr.company || '',
    address_1: addr.street1 || '',
    address_2: addr.street2 || '',
    city: addr.city || '',
    state_code: addr.state || '',
    province: isUS ? '' : (addr.state || ''),
    zip_postal_code: addr.zip || '',
    country_code: addr.country || 'US',
    phone: addr.phone || '',
    email: addr.email || '',
    address_order_po: '',
  };

  const order_items = (shippoOrder.line_items || []).map((item) => ({
    product_qty: item.quantity || 1,
    product_sku: item.sku || '',
    product_title: item.title || '',
    product_guid: generateGUID(),
    product_image: {
      product_url_file: '',
      product_url_thumbnail: '',
    },
    custom_data_1: '',
    custom_data_2: '',
    custom_data_3: '',
  }));

  const rawOrderNumber = String(shippoOrder.order_number || '').replace(/^#/, '').trim();
  const order_po = rawOrderNumber || `SHIPPO_${shippoOrder.object_id}`;

  return {
    order_po,
    shipping_code: 'SD',
    test_mode: false,
    order_status: shippoOrder.order_status || '',
    recipient,
    order_items,
  };
}

function urlEncodeJSON(data) {
  const jsonString = JSON.stringify(data);
  return encodeURIComponent(jsonString).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

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
  const shippoResponse = await shippoService.GET_ORDERS({ status, page, results });
  const shippoOrders = shippoResponse.results || [];

  if (!shippoOrders.length) {
    return res.status(200).json({
      statusCode: 200,
      status: true,
      message: 'No orders found for the given filters.',
      data: [],
      skipped: [],
    });
  }

  const selectPayload = {
    query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE FulfillmentAccountID=${accountId} AND FulfillmentSubmitted=0 AND FulfillmentDeleted=0 AND FulfillmentAppName='${UPLOAD_SOURCE}'`,
  };
  const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(selectPayload);
  const existingOrderKeys = new Set(
    (selectData.data || []).map((row) => {
      const decoded = JSON.parse(decodeURIComponent(row.FulfillmentData));
      return `${decoded.order_po}|${row.FulfillmentAppName}`;
    })
  );

  const inserted = [];
  const skipped = [];

  for (const shippoOrder of shippoOrders) {
    const order = mapShippoOrder(shippoOrder);
    const orderKey = `${order.order_po}|${UPLOAD_SOURCE}`;

    if (existingOrderKeys.has(orderKey)) {
      log('Skipping duplicate order_po=%s', order.order_po);
      skipped.push(order.order_po);
      continue;
    }

    order.createdAt = new Date();
    order.submittedAt = null;
    order.source = UPLOAD_SOURCE;

    const urlEncodedData = urlEncodeJSON(order);
    const insertPayload = {
      tablename: process.env.FINER_fwAPI_FULFILLMENTS_TABLE,
      fields: 'FulfillmentAccountID, FulfillmentData, FulfillmentSubmitted, FulfillmentAppName',
      values: `'${accountId}', '${urlEncodedData}', 0, '${UPLOAD_SOURCE}'`,
    };
    const insertData = await finerworksService.INSERT_QUERY_FINERWORKS(insertPayload);
    order.orderFullFillmentId = insertData.record_id;
    inserted.push(order);
  }

  log('Shippo import done: inserted=%d skipped=%d', inserted.length, skipped.length);

  return res.status(200).json({
    statusCode: 200,
    status: true,
    message: `${inserted.length} order(s) imported, ${skipped.length} duplicate(s) skipped.`,
    data: inserted,
    skipped,
    pagination: {
      count: shippoResponse.count,
      next: shippoResponse.next,
      previous: shippoResponse.previous,
    },
  });
};
