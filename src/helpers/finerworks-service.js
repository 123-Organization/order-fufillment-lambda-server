const axios = require('axios');
/** Common header settings for all the finer work apis */
const getHeaders = () => {
  return {
    'web_api_key': process.env.FINER_WORKS_WEB_API_KEY,
    'app_key': process.env.FINER_WORKS_APP_KEY
  };
};


exports.UPDATE_INFO = async (payload) => {
  const postData = await axios({
    method: 'PUT',
    url: process.env.FINER_WORKS_URL + 'update_user',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};


exports.GET_INFO = async (payload) => {
  const postData = await axios({
    method: 'get',
    url: process.env.FINER_WORKS_URL + 'get_user?account_key=' + payload.account_key,
    headers: getHeaders()
  });
  return postData.data;
};

exports.SUBMIT_ORDERS = async (payload) => {
  const postData = await axios({
    method: 'POST',
    url: process.env.FINER_WORKS_URL + 'submit_orders_v2',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};

exports.INSERT_QUERY_FINERWORKS = async (payload) => {
  const postData = await axios({
    method: 'POST',
    url: process.env.FINER_WORKS_URL + 'finerworks_insert_query',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};
exports.UPDATE_QUERY_FINERWORKS = async (payload) => {
  const postData = await axios({
    method: 'POST',
    url: process.env.FINER_WORKS_URL + 'finerworks_update_query',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};

exports.SELECT_QUERY_FINERWORKS = async (payload) => {
  const postData = await axios({
    method: 'POST',
    url: process.env.FINER_WORKS_URL + 'finerworks_select_query',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};

exports.GET_ORDERS_PRICE = async (payload) => {
  const postData = await axios({
    method: 'POST',
    url: process.env.FINER_WORKS_URL + 'get_prices',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};

exports.GET_PRODUCTS_DETAILS = async (payload) => {
  const postData = await axios({
    method: 'POST',
    url: process.env.FINER_WORKS_URL + 'get_product_details',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;

};

exports.SHIPPING_OPTIONS_MULTIPLE = async (payload) => {
  const postData = await axios({
    method: 'POST',
    url: process.env.FINER_WORKS_URL + 'list_shipping_options_multiple',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};