const axios = require('axios');

const SHIPPO_BASE_URL = 'https://api.goshippo.com';

const getApiKey = () => {
  const mode = String(process.env.SHIPPO_MODE || 'live').toLowerCase();
  return mode === 'test' ? process.env.SHIPPO_TEST_KEY : process.env.SHIPPO_LIVE_KEY;
};

const getHeaders = () => ({
  Authorization: `ShippoToken ${getApiKey()}`,
  'Content-Type': 'application/json',
});

exports.GET_ORDERS = async ({ status, page = 1, results = 100 } = {}) => {
  const params = { page, results };
  if (status) params.order_status = status;
  const response = await axios.get(`${SHIPPO_BASE_URL}/orders/`, {
    headers: getHeaders(),
    params,
  });
  return response.data;
};

exports.GET_ORDER = async (orderId) => {
  const response = await axios.get(`${SHIPPO_BASE_URL}/orders/${orderId}/`, {
    headers: getHeaders(),
  });
  return response.data;
};

exports.VALIDATE_CONNECTION = async () => {
  const response = await axios.get(`${SHIPPO_BASE_URL}/orders/`, {
    headers: getHeaders(),
    params: { results: 1 },
  });
  return response.data;
};
