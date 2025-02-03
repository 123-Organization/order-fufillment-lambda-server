const debug = require("debug");
const log = debug("app:shippingOptions");
log("Shipping options");
exports.listShippingOptions = async (req, res) => {
    try {
      log("List shipping options for", JSON.stringify(req?.body));
      const reqBody = JSON.parse(JSON.stringify(req.body));
      if (!reqBody) {
        res.status(400).json({
          statusCode: 400,
          status: false,
          message: "Bad Request",
        });
      } else {
        const getProductDetails =
          await finerworksService.SHIPPING_OPTIONS_MULTIPLE(reqBody);
        if (getProductDetails) {
          res.status(200).json({
            statusCode: 200,
            status: true,
            data: getProductDetails?.orders,
          });
        } else {
          res.status(404).json({
            statusCode: 404,
            status: false,
            message: "Product Details Not Found",
          });
        }
      }
    } catch (err) {
      console.log("error", JSON.stringify(err));
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: err?.response?.data,
      });
    }
  };  