const finerworksService = require("../helpers/finerworks-service");
const debug = require("debug");
const log = debug("app:getUserPaymentToken");
log("Payment Tokens");
exports.getUserPaymentToken = async (req, res) => {
  try {
    const reqBody = JSON.parse(JSON.stringify(req.query));
    if (!reqBody || !reqBody.payment_profile_id) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Bad Request",
      });
    } else {
      const { payment_profile_id } = req.query;
      log("Request comes to get payment token for", JSON.stringify(reqBody));
      const requestPayload = {
        payment_profile_id: payment_profile_id,
      };
      console.log("requestPayload", requestPayload);
      const getInformation = await finerworksService.GET_PAYMENT_TOKEN(
        requestPayload
      );
      const successLog = JSON.stringify({
        level: 'INFO',
        platform: 'finerworks',
        method: req.method,
        api: req.originalUrl || req.url,
        function: 'getUserPaymentToken',
        operation: 'User payment token fetched successfully',
        account_key: req.body?.account_key || req.query?.account_key || 'unknown',
        result: { hasTokens: !!(getInformation?.payment_tokens?.length) },
        timestamp: new Date().toISOString()
      });
      console.log(successLog);
      log('Success in getUserPaymentToken: %s', successLog);
      res.status(200).json({
        statusCode: 200,
        status: true,
        payment_tokens: getInformation?.payment_tokens,
      });
    }
  } catch (err) {
    log("Error while fetching all the orders", JSON.stringify(err), err);
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'finerworks',
      source: isFinerworksError ? 'finerworks_api' : 'lambda',
      function: 'getUserPaymentToken',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to fetch user payment token: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.error || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in getUserPaymentToken: %s', errorJson);
    res.status(400).json({
      statusCode: 400,
      status: true,
      payment_tokens: [],
    });
  }
};


exports.getCompanyInfo = async (req, res) => {
  try {
    // Prepare the request payload with only the necessary credentials

    console.log("came herererererere")
    // Perform the API call
    const response = await finerworksService.GET_COMPANY_INFO();

    // Return the response from the external API
    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'finerworks',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'getCompanyInfo',
      operation: 'Company info fetched successfully',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      result: { hasData: !!response.data },
      timestamp: new Date().toISOString()
    });
    console.log(successLog);
    log('Success in getCompanyInfo: %s', successLog);
    res.status(200).json({
      statusCode: 200,
      status: true,
      data: response.data,
    });
  } catch (err) {
    console.error("Error while fetching company info:", err);
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'finerworks',
      source: isFinerworksError ? 'finerworks_api' : 'lambda',
      function: 'getCompanyInfo',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to fetch company info: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.error || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in getCompanyInfo: %s', errorJson);
    res.status(500).json({
      statusCode: 500,
      status: false,
      message: "Internal Server Error",
    });
  }
};
