const axios = require('axios');

const SHIPPO_BASE_URL = 'https://api.goshippo.com';

const getHeaders = (liveKey, testKey) => {
  if (!liveKey) {
    throw new Error('Live Key is required to determine the connection for Shippo requests.');
  }
  const apiKey = String(process.env.SHIPPO_MODE || 'live').toLowerCase() === 'test' ? testKey : liveKey;
  return {
    Authorization: `ShippoToken ${apiKey}`,
    'Content-Type': 'application/json',
  };
};

/**
 * Lists Shippo orders. Shippo filters server-side, so pass through the supported params:
 * - `start_date` / `end_date`: ISO 8601 UTC; filter on the order's `placed_at` (when the customer
 *   placed the order, not when Shippo created the object).
 * - `shop_app`: restrict to one store platform (e.g. `Etsy`).
 * - `order_status`, `page`, `results`.
 * @see https://docs.goshippo.com/docs/Orders/Orders
 */
exports.GET_ORDERS = async ({
  status,
  page = 1,
  results = 10,
  start_date,
  end_date,
  shop_app,
  liveKey,
  testKey,
} = {}) => {
  const params = { page, results };
  if (status) params.order_status = status;
  if (start_date) params.start_date = start_date;
  if (end_date) params.end_date = end_date;
  if (shop_app) params.shop_app = shop_app;
  const response = await axios.get(`${SHIPPO_BASE_URL}/orders/`, {
    headers: getHeaders(liveKey, testKey),
    params,
  });
  return response.data;
};

exports.GET_ORDER = async (orderId, liveKey, testKey) => {
  const response = await axios.get(`${SHIPPO_BASE_URL}/orders/${orderId}/`, {
    headers: getHeaders(liveKey, testKey),
  });
  return response.data;
};

exports.VALIDATE_CONNECTION = async (liveKey, testKey) => {
  const response = await axios.get(`${SHIPPO_BASE_URL}/orders/`, {
    headers: getHeaders(liveKey, testKey),
    params: { results: 1 },
  });
  return response.data;
};
