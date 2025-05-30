const debug = require("debug");
const Joi = require("joi");
const log = debug("app:virtualInventory");
const finerworksService = require("../helpers/finerworks-service");
const axios = require('axios');
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
    console.log("reqBody=========",reqBody);
    const productDetails = await finerworksService.GET_PRODUCTS_DETAILS(reqBody);
    console.log("productDetails==========>>>>>>>>>>",productDetails);

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



exports.exportToWoocomercev1 = async (req, res) => {
  try {
    // Step 1: Validate if domainName and auth_code exist in the request payload
    const { domainName, auth_code, productsList } = req.body;

    if (!domainName || !auth_code || productsList.length === 0)   {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Missing required fields: domainName and auth_code or Products",
      });
    }


    // // Step 4: Prepare the products to send in the request to the import APIproducts
    const productsPayload = {
      products: productsList.map(product => ({
        monetary_format: "USD",
        quantity: 1,
        sku: product.sku,
        product_code: product.product_code,
        price_details: null,
        per_item_price: product.per_item_price,
        total_price: product.total_price,
        asking_price: product.asking_price,
        name: product.name,
        description_short: product.description_short,
        description_long: product.description_long,
        image_url_1: product.image_url_1,
        image_url_2: product.image_url_2,
        image_url_3: product.image_url_3,
        image_url_4: product.image_url_4,
        image_url_5: product.image_url_5,
        image_guid: product.image_guid,
        product_size: product.product_size,
        third_party_integrations: product.third_party_integrations,
        debug: product.debug
      }))
    };

    // Step 5: Construct API URL dynamically with domainName and auth_code
    const apiUrl = `https://${domainName}/wp-json/finerworks-media/v1/import-products?auth_code=${auth_code}`;

    // Step 6: Send the POST request to the import API
    const response = await axios.post(apiUrl, productsPayload);

    const finalPayload = createVirtualInventory(productsList, response.data.wc_product_ids);
     await finerworksService.UPDATE_VIRTUAL_INVENTORY(
      finalPayload
    );
    return res.status(200).json({
      statusCode: 200,
      status: true,
      message: "Products successfully exported",
      // data: response.data
      data: finalPayload
    });
  } catch (error) {
    console.error("Error during product export:", error);

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


function createVirtualInventory(productsList, wcProductIds) {
  // Create a mapping for wc_product_id to SKU
  const wcProductIdToSku = {};
  wcProductIds.forEach(item => {
    const sku = item.find(i => i.fw_product_sku)?.fw_product_sku;
    const wcProductId = item.find(i => i.wc_product_id)?.wc_product_id;
    if (sku && wcProductId) {
      wcProductIdToSku[wcProductId] = sku;
    }
  });

  // Map the payload products to the virtual_inventory structure
  const virtualInventory = productsList.map(product => {
    const wcProductId = wcProductIds.find(item => item.some(i => i.fw_product_sku === product.sku))?.[0]?.wc_product_id;

    return {
      sku: product.sku,
      asking_price: product.asking_price,
      name: product.name,
      description: product.description_long,
      quantity_in_stock: product.quantity_in_stock,
      track_inventory: true,
      third_party_integrations: {
        etsy_product_id: 0,
        shopify_product_id: 123456, // You can replace it with actual data
        shopify_variant_id: 123456, // You can replace it with actual data
        squarespace_product_id: null,
        squarespace_variant_id: null,
        wix_inventory_id: null,
        wix_product_id: null,
        wix_variant_id: null,
        woocommerce_product_id: wcProductId || 0,
        woocommerce_variant_id: 0
      }
    };
  });

  return { virtual_inventory: virtualInventory };
}
// # endregion
