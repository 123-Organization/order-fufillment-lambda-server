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
    const orderId = req.body?.orderId || req.query?.orderId;

    if (!access_token || !account_key || !orderNumber || !orderId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters: access_token or account_key or orderNumber or orderId'
      });
    }
    let headers = {
      Authorization: `Bearer ${access_token}`,
      'User-Agent': process.env.SQUARESPACE_USER_AGENT || 'ofa-node',
      'Content-Type': 'application/json'
    };
    let orderResp = null;
    try {
      orderResp = await axios.get(`https://api.squarespace.com/1.0/commerce/store_pages`, { headers, timeout: 120000 });
    } catch (error) {
      // Major reason for this error block is unauthorized access to the squarespace api.
      const getInformation = await finerworksService.GET_INFO({ account_key });
      const connections = getInformation?.user_account?.connections || [];
      const squarespaceConnection = connections.find((c) => c?.name === 'Squarespace');
      if (squarespaceConnection) {
        let squarespaceData = {};
        try {
          squarespaceData =
            typeof squarespaceConnection?.data === 'string'
              ? JSON.parse(squarespaceConnection.data)
              : (squarespaceConnection?.data && typeof squarespaceConnection.data === 'object'
                ? squarespaceConnection.data
                : {});
        } catch (_) {
          squarespaceData = {};
        }

        const refresh_token = squarespaceData?.refresh_token;
        // create a new access token using the refresh token
        const clientId = process.env.SQUARESPACE_CLIENT_ID;
        const clientSecret = process.env.SQUARESPACE_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          return res.status(500).json({
            success: false,
            message: 'Squarespace OAuth credentials not configured'
          });
        }
        const tokenUrl = 'https://login.squarespace.com/api/1/login/oauth/provider/tokens';
        const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

        const tokenResp = await axios.post(
          tokenUrl,
          {
            grant_type: 'refresh_token',
            refresh_token: String(refresh_token).trim()
          },
          {
            headers: {
              Authorization: `Basic ${basicAuth}`,
              'Content-Type': 'application/json',
              'User-Agent': process.env.SQUARESPACE_USER_AGENT || 'ofa-node'
            },
            timeout: 20000
          }
        );

        const tokenData = tokenResp?.data || {};
        if (!tokenData?.access_token) {
          return res.status(400).json({
            success: false,
            message: 'Token refresh succeeded but access_token missing',
            data: tokenData
          });
        }

        // IMPORTANT: Squarespace may rotate refresh tokens on refresh.
        // Persist the latest access/refresh token back into the tenant connection,
        // otherwise the next refresh attempt will use an invalidated refresh_token.
        try {
          const nextConnections = Array.isArray(connections) ? JSON.parse(JSON.stringify(connections)) : [];
          const idx = nextConnections.findIndex((c) => c && c.name === 'Squarespace');

          const merged = {
            ...squarespaceData,
            ...tokenData,
            // Ensure we never lose the refresh token if Squarespace doesn't return it.
            refresh_token: tokenData.refresh_token || refresh_token
          };

          const nextConn = {
            ...(idx !== -1 ? nextConnections[idx] : {}),
            name: 'Squarespace',
            id: tokenData.access_token,
            data: JSON.stringify(merged)
          };

          if (idx !== -1) nextConnections[idx] = nextConn;
          else nextConnections.push(nextConn);

          await finerworksService.UPDATE_INFO({
            account_key,
            connections: nextConnections
          });
        } catch (persistErr) {
          // Don't fail fulfillment if persistence fails; just continue with refreshed access token.
          console.log('Failed to persist refreshed Squarespace token', persistErr?.message || persistErr);
        }

        headers = {
          ...headers,
          Authorization: `Bearer ${tokenData.access_token}`,
        };
      } else {
        return res.status(400).json({
          success: false,
          message: 'Squarespace connection not found'
        });
      }
    }
    // Common code to get the tracking number and tracking url from the order status data. Then we update the squarespace order.
    const selectOrderId = {
      "order_pos": [
        orderNumber
      ],
      "account_key": account_key
    }
    console.log("selectOrderIds", selectOrderId);

    let orderStatusData = null;
    try {
      orderStatusData = await finerworksService.GET_ORDER_STATUS(
        selectOrderId
      );
      var result = orderNumber.replace("sku_", "");
      console.log(result); // "1"
    } catch (error) {
      console.log("error in order status data", error);
      return res.status(500).json({
        success: false,
        message: 'Failed to get order status data',
        error: error?.message || 'Unknown error'
      });
    }
    console.log("orderStatusData", orderStatusData);
    const trackingNumber = orderStatusData?.orders[0]?.shipments[0]?.tracking_number;
    const trackingUrl = orderStatusData?.orders[0]?.shipments[0]?.tracking_url;
    const carrierName = orderStatusData?.orders[0]?.shipments[0]?.carrier;
    const service = orderStatusData?.orders[0]?.shipments[0]?.service;
    const shipDate = orderStatusData?.orders[0]?.shipments[0]?.shipment_date;

    const url = `${SQUARESPACE_ORDERS_URL}/${orderId}/fulfillments`;
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
    if (!carrierName || !service || !shipDate || !trackingNumber) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters: carrier name or service or ship date or tracking number'
      });
    }
    const resp = await axios.post(url, JSON.stringify(payload), { headers });
    return res.status(200).json({
      success: true,
      message: 'Squarespace order fulfilled with tracking info',
      data: resp.data
    });
  } catch (err) {
    console.log("API error", err);
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
