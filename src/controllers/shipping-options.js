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

    return res.status(200).json({
      statusCode: 200,
      status: true,
      data: shippingOptions.orders,
    });
  } catch (err) {
    console.error("Error fetching shipping options:", err);

    return res.status(err?.response?.status || 500).json({
      statusCode: err?.response?.status || 500,
      status: false,
      message: err?.response?.data?.message || "Internal Server Error",
      error: err?.response?.data || err.message,
    });
  }
};
