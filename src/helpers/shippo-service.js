const axios = require('axios');

const SHIPPO_BASE_URL = 'https://api.goshippo.com';

const getHeaders = (liveKey, testKey) => {
    if (!liveKey || !testKey) {
        throw new Error('Both live Key and test Key are required to determine the API key for Shippo requests.');
    }
    const apiKey = String(process.env.SHIPPO_MODE || 'live').toLowerCase() === 'test' ? testKey : liveKey;
    return {
        Authorization: `ShippoToken ${apiKey}`,
        'Content-Type': 'application/json',
    };
};

exports.GET_ORDERS = async ({ status, page = 1, results = 10, liveKey, testKey } = {}) => {
    const params = { page, results };
    if (status) params.order_status = status;
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