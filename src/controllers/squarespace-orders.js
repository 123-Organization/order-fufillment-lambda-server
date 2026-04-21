const axios = require('axios');
const finerworksService = require('../helpers/finerworks-service');

const SQUARESPACE_ORDERS_URL = 'https://api.squarespace.com/1.0/commerce/orders';

function toIsoOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function fetchAllSquarespaceOrders({ accessToken, startDate, endDate, fulfillmentStatus, customerId }) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': process.env.SQUARESPACE_USER_AGENT || 'ofa-node'
  };

  const orders = [];
  let cursor = null;

  for (let i = 0; i < 100; i++) {
    const params = {};
    if (cursor) {
      params.cursor = cursor;
    } else {
      const modifiedAfter = toIsoOrNull(startDate);
      const modifiedBefore = toIsoOrNull(endDate);
      if (modifiedAfter && modifiedBefore) {
        params.modifiedAfter = modifiedAfter;
        params.modifiedBefore = modifiedBefore;
      }
      if (fulfillmentStatus) params.fulfillmentStatus = String(fulfillmentStatus).trim().toUpperCase();
      if (customerId) params.customerId = String(customerId).trim();
    }

    const resp = await axios.get(SQUARESPACE_ORDERS_URL, { headers, params, timeout: 120000 });
    const data = resp?.data || {};
    const pageOrders = Array.isArray(data.result) ? data.result : [];
    orders.push(...pageOrders);

    const pagination = data.pagination || {};
    if (!pagination.hasNextPage || !pagination.nextPageCursor) break;
    cursor = pagination.nextPageCursor;
  }

  return orders;
}

const getSquarespaceOrders = async (req, res) => {
  try {
    let accessToken = req.body?.access_token || req.headers['x-squarespace-access-token'];
    const authHeader = req.headers?.authorization || req.headers?.Authorization;
    if (!accessToken && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      accessToken = authHeader.slice(7).trim();
    }

    const startDate = req.body?.startDate || req.body?.start_date || req.query?.startDate || req.query?.start_date;
    const endDate = req.body?.endDate || req.body?.end_date || req.query?.endDate || req.query?.end_date;
    const fulfillmentStatus =
      req.body?.fulfillmentStatus || req.body?.fulfillment_status || req.query?.fulfillmentStatus;
    const customerId = req.body?.customerId || req.body?.customer_id || req.query?.customerId;

    if (!accessToken) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameter: access_token'
      });
    }

    const orders = await fetchAllSquarespaceOrders({
      accessToken,
      startDate,
      endDate,
      fulfillmentStatus,
      customerId
    });

    return res.status(200).json({
      success: true,
      count: orders.length,
      orders
    });
  } catch (err) {
    const status = err?.response?.status || 500;
    const data = err?.response?.data;
    return res.status(status).json({
      success: false,
      message: 'Failed to retrieve Squarespace orders',
      error:
        (typeof data?.message === 'string' && data.message) ||
        (typeof data?.error === 'string' && data.error) ||
        err?.message ||
        'Unknown error',
      ...(data && typeof data === 'object' ? { squarespaceError: data } : {})
    });
  }
};

const getSquarespaceOrderByNumber = async (req, res) => {
  try {
    let accessToken = req.body?.access_token || req.headers['x-squarespace-access-token'];
    const authHeader = req.headers?.authorization || req.headers?.Authorization;
    if (!accessToken && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      accessToken = authHeader.slice(7).trim();
    }

    const orderNumberRaw =
      req.body?.orderNumber ||
      req.body?.order_number ||
      req.body?.orderName ||
      req.body?.order_name ||
      req.query?.orderNumber ||
      req.query?.order_number;

    if (!accessToken || !orderNumberRaw) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters: access_token and orderNumber'
      });
    }

    const normalized = String(orderNumberRaw).replace('#', '').trim();
    const orders = await fetchAllSquarespaceOrders({ accessToken });
    const order =
      orders.find((o) => String(o?.orderNumber || '').trim() === normalized) ||
      orders.find((o) => String(o?.orderNumber || '').trim() === String(orderNumberRaw).trim()) ||
      null;

    if (!order) {
      return res.status(404).json({
        success: false,
        message: `Order not found for orderNumber: ${orderNumberRaw}`
      });
    }

    return res.status(200).json({
      success: true,
      order
    });
  } catch (err) {
    const status = err?.response?.status || 500;
    const data = err?.response?.data;
    return res.status(status).json({
      success: false,
      message: 'Failed to retrieve Squarespace order by number',
      error:
        (typeof data?.message === 'string' && data.message) ||
        (typeof data?.error === 'string' && data.error) ||
        err?.message ||
        'Unknown error',
      ...(data && typeof data === 'object' ? { squarespaceError: data } : {})
    });
  }
};

const validateSquarespaceAccessToken = async (req, res) => {
  try {
    let accessToken = req.body?.access_token || req.headers['x-squarespace-access-token'];
    const authHeader = req.headers?.authorization || req.headers?.Authorization;
    if (!accessToken && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      accessToken = authHeader.slice(7).trim();
    }

    if (!accessToken) {
      return res.status(400).json({
        success: false,
        valid: false,
        message: 'Missing required parameter: access_token'
      });
    }

    const resp = await axios.get('https://api.squarespace.com/1.0/commerce/store_pages', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': process.env.SQUARESPACE_USER_AGENT || 'ofa-node'
      },
      timeout: 60000,
      validateStatus: () => true
    });
    console.log("resp===>>>", resp)

    if (resp.status >= 200 && resp.status < 300) {
      const pages = Array.isArray(resp?.data?.storePages) ? resp.data.storePages : [];
      return res.status(200).json({
        success: true,
        valid: true,
        storePageCount: pages.length
      });
    }

    const data = resp?.data;
    return res.status(resp.status || 401).json({
      success: false,
      valid: false,
      message: 'Squarespace access token is invalid or unauthorized',
      error:
        (typeof data?.message === 'string' && data.message) ||
        (typeof data?.error === 'string' && data.error) ||
        'Unauthorized',
      ...(data && typeof data === 'object' ? { squarespaceError: data } : {})
    });
  } catch (err) {
    const status = err?.response?.status || 500;
    const data = err?.response?.data;
    return res.status(status).json({
      success: false,
      valid: false,
      message: 'Failed to validate Squarespace access token',
      error:
        (typeof data?.message === 'string' && data.message) ||
        (typeof data?.error === 'string' && data.error) ||
        err?.message ||
        'Unknown error'
    });
  }
};

// 1. From the body we will get access_token, account_key, orderNumber.
// 2. Need to do a dummy call to squarespace to check if the access_token is valid.
// 3. If token is valid then we will call the order status api to get the order details from the 3rd party api. That will contain the orderTrackingNumber and trackingUrl.
// 4. using this trackingNumber and trackingUrl we will call the squarespace api to fulfill the order.
// 5. return the response to the client.

const fulfillSquareSpaceOrderWithTrackingInfo = async (req, res) => {
  try {
    const access_token = req.body?.access_token || req.query?.access_token;
    const account_key = req.body?.account_key || req.query?.account_key;
    const orderNumber = req.body?.orderNumber || req.query?.orderNumber;

    if (!access_token || !account_key || !orderNumber) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters: access_token or account_key or orderNumber'
      });
    }
    let headers = {
      Authorization: `Bearer ${access_token}`,
      'User-Agent': process.env.SQUARESPACE_USER_AGENT || 'ofa-node',
      'Content-Type': 'application/json'
    };
    let orderResp = null;
    try {
      orderResp = await axios.get(`${SQUARESPACE_ORDERS_URL}/${orderNumber}`, { headers, timeout: 120000 });
      console.log("orderResp=================>>>>>>>>>>>", orderResp);

      const selectOrderId = {
        "order_pos": [
          orderNumber
        ],
        "account_key": account_key
      }
      console.log("selectOrderId=================>>>>>>>>>>>", selectOrderId);
      const orderStatusData = await finerworksService.GET_ORDER_STATUS(
        selectOrderId
      );
      console.log("orderStatusData=================>>>>>>>>>>>", orderStatusData?.orders[0]?.shipments[0]);
      const trackingNumber = orderStatusData?.orders[0]?.shipments[0]?.tracking_number;
      const trackingUrl = orderStatusData?.orders[0]?.shipments[0]?.tracking_url;
      const carrierName = orderStatusData?.orders[0]?.shipments[0]?.carrier;
      const service = 'service';
      const shipDate = orderStatusData?.orders[0]?.shipments[0]?.shipment_date;
      
      const url = `${SQUARESPACE_ORDERS_URL}/${orderNumber}/fulfillments`;
      const payload = {
        "shipments": [
          {
            "carrierName": carrierName,
            "service": service,
            "shipDate": shipDate,
            "trackingNumber": trackingNumber,
            "trackingUrl": trackingUrl
          }
        ],
        "shouldSendNotification": true
      }
      const resp = await axios.post(url, JSON.stringify(payload), { headers });
      console.log("resp=================>>>>>>>>>>>", resp);
      return res.status(200).json({
        success: true,
        message: 'Squarespace order fulfilled with tracking info',
        data: resp.data
      });
    } catch (error) {
      // Major reason for this error block is unauthorized access to the squarespace api.
      const getInformation = await finerworksService.GET_INFO({ account_key });
      const connections = getInformation?.user_account?.connections || [];
      const squarespaceConnection = connections.find((c) => c?.name === 'Squarespace');
      if (squarespaceConnection) {
        const squarespaceData = JSON.parse(squarespaceConnection?.data);
        const access_token = squarespaceData?.refresh_token;
        headers = {
          ...headers,
          Authorization: `Bearer ${access_token}`,
        };

        const selectOrderId = {
          "order_pos": [
            orderNumber
          ],
          "account_key": account_key
        }
        console.log("selectOrderId=================>>>>>>>>>>>", selectOrderId);
        const orderStatusData = await finerworksService.GET_ORDER_STATUS(
          selectOrderId
        );
        console.log("orderStatusData=================>>>>>>>>>>>", orderStatusData?.orders[0]?.shipments[0]);
        const trackingNumber = orderStatusData?.orders[0]?.shipments[0]?.tracking_number;
        const trackingUrl = orderStatusData?.orders[0]?.shipments[0]?.tracking_url;
        const carrierName = orderStatusData?.orders[0]?.shipments[0]?.carrier;
        const service = 'service';
        const shipDate = orderStatusData?.orders[0]?.shipments[0]?.shipment_date;
        
        const url = `${SQUARESPACE_ORDERS_URL}/${orderNumber}/fulfillments`;
        const payload = {
          "shipments": [
            {
              "carrierName": carrierName,
              "service": service,
              "shipDate": shipDate,
              "trackingNumber": trackingNumber,
              "trackingUrl": trackingUrl
            }
          ],
          "shouldSendNotification": true
        }
        const resp = await axios.post(url, JSON.stringify(payload), { headers });
        console.log("resp=================>>>>>>>>>>>", resp);
        return res.status(200).json({
          success: true,
          message: 'Squarespace order fulfilled with tracking info',
          data: resp.data
        });
      }
    }
  } catch (err) {
    console.log("err=================>>>>>>>>>>>", err);
    return res.status(500).json({
      success: false,
      message: 'Failed to fulfill Squarespace order with tracking info',
      error: err?.message || 'Unknown error'
    });
  }
};

module.exports = {
  getSquarespaceOrders,
  getSquarespaceOrderByNumber,
  validateSquarespaceAccessToken,
  fulfillSquareSpaceOrderWithTrackingInfo
};
