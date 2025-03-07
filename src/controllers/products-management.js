const debug = require("debug");
const Joi = require("joi");
const log = debug("app:virtualInventory");
const finerworksService = require("../helpers/finerworks-service");
log("Products");
// # region Add Product
// Define the validation schema
const imageSchema = Joi.object({
  title: Joi.string().required(),
  description: Joi.string().required(),
  file_name: Joi.string().required(),
  file_size: Joi.number().required(),
  thumbnail_file_name: Joi.string().required(),
  preview_file_name: Joi.string().required(),
  hires_file_name: Joi.string().required(),
  public_thumbnail_uri: Joi.string().uri().required(),
  public_preview_uri: Joi.string().uri().required(),
  private_hires_uri: Joi.string().uri().required(),
  pix_w: Joi.number().integer().positive().required(),
  pix_h: Joi.number().integer().positive().required(),
});

const librarySchema = Joi.object({
  name: Joi.string().required(),
  session_id: Joi.string().required(),
  account_key: Joi.string().allow(""),
  site_id: Joi.number().integer().min(0).required(),
});

const requestBodySchema = Joi.object({
  images: Joi.array().items(imageSchema).min(1).required(),
  library: librarySchema.required(),
});
// Middleware for validation
exports.validateAddProduct = async (req, res, next) => {
  const { error, value } = requestBodySchema.validate(req.body);
  if (error) {
    return res.status(400).json({
      statusCode: 400,
      status: false,
      message: error.details[0].message,
    });
  }
  req.body = value;
  next();
};

exports.addProduct = async (req, res) => {
  try {
    const reqBody = JSON.parse(JSON.stringify(req.body));
    const getInformation = await finerworksService.ADD_PRODUCT(reqBody);
    if (
      getInformation &&
      getInformation.status &&
      getInformation.status.success
    ) {
      res.status(200).json({
        statusCode: 200,
        status: true,
        data: getInformation?.images,
      });
    } else {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Something went wrong",
      });
    }
  } catch (error) {
    log("Error while adding a new product : ", error);
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: JSON.stringify(error),
    });
  }
};

// # endregion


exports.getProductDetails = async (req, res) => {
  try {
    const reqBody = req.body;

    if (!reqBody || Object.keys(reqBody).length === 0) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Bad Request: Request body is missing or invalid",
      });
    }

    const productDetails = await finerworksService.GET_PRODUCTS_DETAILS(reqBody);

    if (!productDetails || !productDetails.status) {
      return res.status(404).json({
        statusCode: 404,
        status: false,
        message: "Product details not found",
      });
    }

    // Calculate total price if product list exists
    const totalPrice = productDetails.product_list?.reduce(
      (sum, product) => sum + (product.total_price || 0),
      0
    );

    return res.status(200).json({
      statusCode: 200,
      status: true,
      message: "Product details retrieved successfully",
      data: productDetails,
      totalPrice,
    });
  } catch (error) {
    console.error("Error fetching product details:", error);

    return res.status(500).json({
      statusCode: 500,
      status: false,
      message: "Internal Server Error",
      error: error?.message || "An unexpected error occurred",
    });
  }
};


exports.increaseProductQuantity = async (req, res) => {
  try {
    const reqBody = req.body;
    console.log("Request body is", reqBody);

    if (!reqBody || Object.keys(reqBody).length === 0) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Bad Request: Request body is missing or invalid",
      });
    }

    // Ensure required fields are present
    if (!reqBody.orderFullFillmentId || !reqBody.product_guid || !reqBody.new_quantity) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Missing required fields: orderFullFillmentId, product_guid, new_quantity",
      });
    }

    // Select payload for database query
    const selectPayload = {
      query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE FulfillmentID=${reqBody.orderFullFillmentId}`,
    };

    // Fetch fulfillment data
    const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(selectPayload);

    if (!selectData || !selectData.data || selectData.data.length === 0) {
      return res.status(404).json({
        statusCode: 404,
        status: false,
        message: "Fulfillment data not found",
      });
    }
    // Decode and parse FulfillmentData
    const decodedFulfillmentData = decodeURIComponent(selectData.data[0].FulfillmentData);
    let fulfillmentJSON = JSON.parse(decodedFulfillmentData);

    // Function to update product quantity in order_items
    fulfillmentJSON.order_items = fulfillmentJSON.order_items.map(item => {
      if (item.product_guid === reqBody.product_guid) {
        return { ...item, product_qty: reqBody.new_quantity };
      }
      return item;
    });
     const urlEncodedData = urlEncodeJSON(fulfillmentJSON);
                const updatePayload = {
                  tablename: process.env.FINER_fwAPI_FULFILLMENTS_TABLE,
                  fieldupdates: `FulfillmentData='${urlEncodedData}'`,
                  where: `FulfillmentID=${reqBody.orderFullFillmentId}`,
                };
                const updateQueryExecute = await finerworksService.UPDATE_QUERY_FINERWORKS(
                  updatePayload
                );

    return res.status(200).json({
      statusCode: 200,
      status: true,
      message: "Product quantity updated successfully",
      updatedData: updateQueryExecute,
    });

  } catch (error) {
    console.error("Error updating product quantity:", error);

    return res.status(500).json({
      statusCode: 500,
      status: false,
      message: "Internal Server Error",
      error: error?.message || "An unexpected error occurred",
    });
  }
};

function urlEncodeJSON(data) {
  const jsonString = JSON.stringify(data);
  const encodedString = encodeURIComponent(jsonString);
  return encodedString;
}


// # endregion
