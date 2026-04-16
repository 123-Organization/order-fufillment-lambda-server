const axios = require('axios');

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
    console.log("resp===>>>",resp)

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

module.exports = {
  getSquarespaceOrders,
  getSquarespaceOrderByNumber,
  validateSquarespaceAccessToken
};
