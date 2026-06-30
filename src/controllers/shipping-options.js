const debug = require("debug");
const finerworksService = require("../helpers/finerworks-service");
const log = debug("app:shippingOptions");
log("Shipping options");

exports.listShippingOptions = async (req, res) => {
  try {
    console.log("List shipping options for", JSON.stringify(req.body));

    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Bad Request: Request body is missing",
      });
    }

    const shippingOptions = await finerworksService.SHIPPING_OPTIONS_MULTIPLE(req.body);

    if (!shippingOptions || !shippingOptions.orders || shippingOptions.orders.length === 0) {
      return res.status(404).json({
        statusCode: 404,
        status: false,
        message: "No shipping options found",
      });
    }

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'finerworks',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'listShippingOptions',
      operation: 'Shipping options fetched successfully',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      result: { count: shippingOptions.orders?.length || 0 },
      timestamp: new Date().toISOString()
    });
    console.log(successLog);
    log('Success in listShippingOptions: %s', successLog);
    return res.status(200).json({
      statusCode: 200,
      status: true,
      data: shippingOptions.orders,
    });
  } catch (err) {
    console.error("Error fetching shipping options:", err);
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'finerworks',
      source: isFinerworksError ? 'finerworks_api' : 'lambda',
      function: 'listShippingOptions',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to fetch shipping options: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.error || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in listShippingOptions: %s', errorJson);
    return res.status(err?.response?.status || 500).json({
      statusCode: err?.response?.status || 500,
      status: false,
      message: err?.response?.data?.message || "Internal Server Error",
      error: err?.response?.data || err.message,
    });
  }
};


exports.listShippingOptionsV2 = async (req, res) => {
  try {
    console.log("List shipping options for", JSON.stringify(req.body));

    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Bad Request: Request body is missing",
      });
    }
      // Correcting the map function to ensure 'order_po' and 'shipping_code' are set
    const orders = req.body.orders.map((item) => {
      return {
        ...item,
        order_po: generateRandomUniqueNumber(), // Add random unique order number
        shipping_code: "EC", // Set shipping code to "EC"
      };
    });

    // Pass the modified orders array to the shipping service
    const shippingOptions = await finerworksService.SHIPPING_OPTIONS_MULTIPLE({
      account_key: req.body.account_key, // Retain the account key
      orders: orders, // Send the modified orders
    });
    if (!shippingOptions || !shippingOptions.orders || shippingOptions.orders.length === 0) {
      return res.status(404).json({
        statusCode: 404,
        status: false,
        message: "No shipping options found",
      });
    }

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'finerworks',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'listShippingOptionsV2',
      operation: 'Shipping options V2 fetched successfully',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      result: { count: shippingOptions.orders?.length || 0 },
      timestamp: new Date().toISOString()
    });
    console.log(successLog);
    log('Success in listShippingOptionsV2: %s', successLog);
    return res.status(200).json({
      statusCode: 200,
      status: true,
      data: shippingOptions.orders,
    });
  } catch (err) {
    console.error("Error fetching shipping options:", err);
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'finerworks',
      source: isFinerworksError ? 'finerworks_api' : 'lambda',
      function: 'listShippingOptionsV2',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to fetch shipping options V2: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.error || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in listShippingOptionsV2: %s', errorJson);
    return res.status(err?.response?.status || 500).json({
      statusCode: err?.response?.status || 500,
      status: false,
      message: err?.response?.data?.message || "Internal Server Error",
      error: err?.response?.data || err.message,
    });
  }
};

exports.listShippingOptionsV3 = async (req, res) => {
  try {
    // Pass the modified orders array to the shipping service
    const shippingOptions = await finerworksService.SHIPPING_OPTIONS_LIST();
    if (!shippingOptions) {
      return res.status(404).json({
        statusCode: 404,
        status: false,
        message: "No shipping options found",
      });
    }

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'finerworks',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'listShippingOptionsV3',
      operation: 'Shipping options list V3 fetched successfully',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      result: { hasData: !!shippingOptions },
      timestamp: new Date().toISOString()
    });
    console.log(successLog);
    log('Success in listShippingOptionsV3: %s', successLog);
    return res.status(200).json({
      statusCode: 200,
      status: true,
      data: shippingOptions,
    });
  } catch (err) {
    console.error("Error fetching shipping options:", err);
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'finerworks',
      source: isFinerworksError ? 'finerworks_api' : 'lambda',
      function: 'listShippingOptionsV3',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to fetch shipping options V3: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.error || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in listShippingOptionsV3: %s', errorJson);
    return res.status(err?.response?.status || 500).json({
      statusCode: err?.response?.status || 500,
      status: false,
      message: err?.response?.data?.message || "Internal Server Error",
      error: err?.response?.data || err.message,
    });
  }
};

function generateRandomUniqueNumber() {
    const randomNumber = Math.floor(10000 + Math.random() * 90000); // Generates a 5-digit number
    return randomNumber;
}