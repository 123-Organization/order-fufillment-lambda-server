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
    data: payload
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