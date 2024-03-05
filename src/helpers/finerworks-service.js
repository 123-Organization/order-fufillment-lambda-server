const axios = require('axios');
/** Common header settings for all the finer work apis */
const getHeaders = () =>{
    return {
        'web_api_key':process.env.FINER_WORKS_WEB_API_KEY,
        'app_key':process.env.FINER_WORKS_APP_KEY
    };
};


exports.UPDATE_INFO = async(payload) => {
  const postData = await axios({
    method: 'put',
    url: process.env.FINER_WORKS_URL+'update_user',
    headers: getHeaders(),
    data: payload
  });
  return postData.data;
};


exports.GET_INFO = async(payload) => {
  const postData = await axios({
    method: 'get',
    url: process.env.FINER_WORKS_URL+'get_user?account_key='+payload.account_key,
    headers: getHeaders()
  });
  return postData.data;
};