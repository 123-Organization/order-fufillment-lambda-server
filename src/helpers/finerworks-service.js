const axios = require('axios');

/**
 * Common header settings for all the finer work APIs.
 * @returns {Object} - The headers object.
 */
const getHeaders = () => {
  return {
    'web_api_key': process.env.FINER_WORKS_WEB_API_KEY,
    'app_key': process.env.FINER_WORKS_APP_KEY
  };
};

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET']);

/**
 * axios wrapper with a bounded timeout and a small retry-with-backoff for transient failures
 * (429/5xx/timeout/connection reset). Without an explicit timeout these calls can hang until the
 * API Gateway's hard 29s integration ceiling kills them — well before our Lambda's own much
 * longer configured timeout — which is what turns a slow FinerWorks response under concurrent
 * load into an outright failure. Only use this for idempotent calls (safe to repeat).
 */
const requestWithRetry = async (config, { retries = 2, baseDelayMs = 500, timeout = 25000 } = {}) => {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await axios({ timeout, ...config });
    } catch (err) {
      const status = err?.response?.status;
      const isRetryable = RETRYABLE_STATUS_CODES.has(status) || RETRYABLE_ERROR_CODES.has(err?.code) || !err?.response;
      if (!isRetryable || attempt >= retries) throw err;
      const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 200);
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt += 1;
    }
  }
};

/**
 * Updates the user information.
 * @param {Object} payload - The payload containing the user information to be updated.
 * @returns {Promise<Object>} - The response data from the API.
 */
exports.UPDATE_INFO = async (payload) => {
  const postData = await axios({
    method: 'PUT',
    url: process.env.FINER_WORKS_URL + 'update_user',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};

/**
 * Retrieves the user information.
 * @param {Object} payload - The payload containing the account key.
 * @returns {Promise<Object>} - The response data from the API.
 */
exports.GET_INFO = async (payload) => {
  console.log("payload==============>>>>>>>", payload);
  const postData = await axios({
    method: 'get',
    url: process.env.FINER_WORKS_URL + 'get_user?account_key=' + payload.account_key,
    headers: getHeaders()
  });
  return postData.data;
};

/**
 * Submits orders.
 * @param {Object} payload - The payload containing the order details.
 * @returns {Promise<Object>} - The response data from the API.
 */
exports.SUBMIT_ORDERS = async (payload) => {
  const postData = await axios({
    method: 'POST',
    url: process.env.FINER_WORKS_URL + 'submit_orders_v2',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};

/**
 * Inserts a query into the finerworks database.
 * @param {Object} payload - The payload containing the query details.
 * @returns {Promise<Object>} - The response data from the API.
 */
exports.INSERT_QUERY_FINERWORKS = async (payload) => {
  const postData = await axios({
    method: 'POST',
    url: process.env.FINER_WORKS_URL + 'finerworks_insert_query',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};

/**
 * Saves pending orders into the FinerWorks fulfillment tables via the structured endpoint
 * (replaces building a raw SQL insert with INSERT_QUERY_FINERWORKS).
 * @param {Object} payload - { orders: [order_details], source, account_key }.
 * @returns {Promise<Object>} - The response data from the API.
 */
exports.SAVE_PENDING_ORDERS = async (payload) => {
  const postData = await axios({
    method: 'POST',
    url: process.env.FINER_WORKS_URL + 'save_pending_orders',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};

/**
 * Updates a query in the finerworks database.
 * @param {Object} payload - The payload containing the query details.
 * @returns {Promise<Object>} - The response data from the API.
 */
exports.UPDATE_QUERY_FINERWORKS = async (payload) => {
  const postData = await axios({
    method: 'POST',
    url: process.env.FINER_WORKS_URL + 'finerworks_update_query',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};

/**
 * Selects a query from the finerworks database.
 * @param {Object} payload - The payload containing the query details.
 * @returns {Promise<Object>} - The response data from the API.
 */
exports.SELECT_QUERY_FINERWORKS = async (payload) => {
  const postData = await axios({
    method: 'POST',
    url: process.env.FINER_WORKS_URL + 'finerworks_select_query',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};


exports.GET_ORDER_STATUS = async (payload) => {
  const postData = await axios({
    method: 'POST',
    url: process.env.FINER_WORKS_URL + 'fetch_order_status',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};

/**
 * Retrieves the prices of orders.
 * @param {Object} payload - The payload containing the order details.
 * @returns {Promise<Object>} - The response data from the API.
 */
exports.GET_ORDERS_PRICE = async (payload) => {
  const postData = await axios({
    method: 'POST',
    url: process.env.FINER_WORKS_URL + 'get_prices',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};

/**
 * Retrieves the details of products.
 * @param {Object} payload - The payload containing the product details.
 * @returns {Promise<Object>} - The response data from the API.
 */
exports.GET_PRODUCTS_DETAILS = async (payload) => {
  const postData = await axios({
    method: 'POST',
    url: process.env.FINER_WORKS_URL + 'get_product_details',
    headers: getHeaders(),
    data: payload,
    validateStatus: (status) => {
      return status >= 200 && status < 500; // Allow status codes from 200 to 499
    },
  });
  return postData.data;
};

/**
 * Retrieves the shipping options for multiple orders.
 * @param {Object} payload - The payload containing the order details.
 * @returns {Promise<Object>} - The response data from the API.
 */
exports.SHIPPING_OPTIONS_MULTIPLE = async (payload) => {
  const postData = await axios({
    method: 'POST',
    url: process.env.FINER_WORKS_URL + 'list_shipping_options_multiple',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};

/**
 * Retrieves the virtual inventory list.
 * @param {Object} payload - The payload containing the inventory details.
 * @returns {Promise<Object>} - The response data from the API.
 */
exports.LIST_VIRTUAL_INVENTORY = async (payload) => {
  const postData = await axios({
    method: 'POST',
    url: process.env.FINER_WORKS_URL + 'list_virtual_inventory',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};

/**
 * Updates the virtual inventory with the given payload.
 * @param {Object} payload - The payload containing the data to update the virtual inventory.
 * @returns {Promise<Object>} - The response data from the API.
 */
exports.UPDATE_VIRTUAL_INVENTORY = async (payload) => {
  const postData = await axios({
    method: 'PUT',
    url: process.env.FINER_WORKS_URL + 'update_virtual_inventory',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};

/**
 * Same as LIST_VIRTUAL_INVENTORY, but with a bounded timeout and retry-with-backoff for
 * transient failures (see requestWithRetry). Split out as its own function rather than changing
 * LIST_VIRTUAL_INVENTORY itself, since that one is called from other places too and this
 * behavior change (timeout + retries) shouldn't silently apply to all of them.
 * @param {Object} payload - The payload containing the inventory details.
 * @returns {Promise<Object>} - The response data from the API.
 */
exports.LIST_VIRTUAL_INVENTORY_WITH_RETRY = async (payload) => {
  const postData = await requestWithRetry({
    method: 'POST',
    url: process.env.FINER_WORKS_URL + 'list_virtual_inventory',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};

/**
 * Same as UPDATE_VIRTUAL_INVENTORY, but with a bounded timeout and retry-with-backoff for
 * transient failures (see requestWithRetry). Split out as its own function rather than changing
 * UPDATE_VIRTUAL_INVENTORY itself, since that one is called from other places too and this
 * behavior change (timeout + retries) shouldn't silently apply to all of them.
 * @param {Object} payload - The payload containing the data to update the virtual inventory.
 * @returns {Promise<Object>} - The response data from the API.
 */
exports.UPDATE_VIRTUAL_INVENTORY_WITH_RETRY = async (payload) => {
  const postData = await requestWithRetry({
    method: 'PUT',
    url: process.env.FINER_WORKS_URL + 'update_virtual_inventory',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};

/**
 * Deletes the virtual inventory with the given payload.
 * @param {Object} payload - The payload containing the data to delete the virtual inventory.
 * @returns {Promise<Object>} - The response data from the API.
 */
exports.DELETE_VIRTUAL_INVENTORY = async (payload) => {
  const postData = await axios({
    method: 'DELETE',
    url: process.env.FINER_WORKS_URL + 'delete_virtual_inventory',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};

exports.ADD_PRODUCT = async (payload) => {
  const postData = await axios({
    method: 'POST',
    url: process.env.FINER_WORKS_URL + 'add_images',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};


/**
 * Retrieves the get payment token.
 * @param {Object} payload - The payload containing the payment token details.
 * @returns {Promise<Object>} - The response data from the API.
 */
exports.GET_PAYMENT_TOKEN = async (payload) => {
  console.log("payload", payload);
  const postData = await axios({
    method: 'GET',
    url: process.env.FINER_WORKS_URL + 'get_payment_tokens?payment_profile_id=' + payload.payment_profile_id + '&sandbox=false',
    headers: getHeaders()
  });
  return postData.data;
};


exports.UPDATE_VIRTUAL_INVENTORY = async (payload) => {
  const postData = await axios({
    method: 'PUT',
    url: process.env.FINER_WORKS_URL + 'update_virtual_inventory',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};

exports.DISCONNECT_VIRTUAL_INVENTORY = async (payload) => {
  const postData = await axios({
    method: 'PUT',
    url: process.env.FINER_WORKS_URL + 'disconnect_virtual_inventory',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};

exports.GET_COMPANY_INFO = async () => {
  const postData = await axios({
    method: 'GET',
    url: `${process.env.FINER_WORKS_URL}get_company_info?web_api_key=${process.env.FINER_WORKS_WEB_API_KEY}&app_key=${process.env.FINER_WORKS_APP_KEY}`,
    headers: getHeaders(),
  });

  return postData;
};


exports.DELETE_PENDING_ORDER = async (payload) => {
  const postData = await axios({
    method: 'POST',
    url: process.env.FINER_WORKS_URL + 'delete_pending_orders',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};

/**
 * Retrieves the list of pending orders.
 * @param {Object} payload - The payload containing the query details.
 * @returns {Promise<Object>} - The response data from the API.
 */
exports.LIST_PENDING_ORDERS = async (payload) => {
  console.log("payload===", payload);
  const postData = await axios({
    method: 'POST',
    url: process.env.FINER_WORKS_URL + 'list_pending_orders',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};

/**
 * Lists existing (real/submitted) orders, filtered by `order_pos`. Used to skip re-saving orders
 * that already exist in FinerWorks.
 * @param {Object} payload - { account_key, order_pos: [string] }.
 * @returns {Promise<Object>} - The response data from the API ({ orders, total_count, status }).
 */
exports.LIST_ORDERS = async (payload) => {
  const postData = await axios({
    method: 'POST',
    url: process.env.FINER_WORKS_URL + 'list_orders',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};


exports.SHIPPING_OPTIONS_LIST = async (type) => {
  try {
    const params = {};
    if (type) {
      params.type = type; // only add if provided
    }

    const response = await axios.get(
      `${process.env.FINER_WORKS_URL}get_shipping_options_ids`,
      {
        headers: getHeaders(),
        params, // ?type=value (only if type exists)
      }
    );

    return response.data;
  } catch (error) {
    console.error("Error fetching shipping options:", error.message);
    throw error;
  }
};

/**
 * Lists account images (supports pagination payload keys when provided by callers).
 * @param {Object} payload - Optional filter/pagination payload.
 * @returns {Promise<Object>} - Response data from FinerWorks.
 */
exports.LIST_IMAGES = async (payload = {}) => {
  const postData = await axios({
    method: 'POST',
    url: process.env.FINER_WORKS_URL + 'list_images',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};
