const createEvent = require("../helpers/create-event");
const finerworksService = require("../helpers/finerworks-service");
const debug = require("debug");
const log = debug("app:uploadOrders");
const Joi = require("joi");
log("Upload order");
// # region Validate order schema
const guidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Define the validation schema
const ordersSchema = Joi.object({
  accountId: Joi.number().required(),
  payment_token: Joi.string().required(),
  orders: Joi.array()
    .items(
      Joi.object({
        order_po: Joi.string().required(),
        order_key: Joi.string(),
        shipping_code: Joi.string().max(2).required(),
        ship_by_date: Joi.string().allow(""),
        gift_message: Joi.string().allow(""),
        test_mode: Joi.boolean().required(),
        order_status: Joi.string().allow(""),
        customs_tax_info: Joi.object({
          tax_id: Joi.string().max(50).allow(""),
          tax_type: Joi.number().valid(0, 1, 2),
        }),
        webhook_order_status_url: Joi.string().allow(""),
        document_url: Joi.string().max(200).allow(""),
        acct_number_ups: Joi.string().max(50).allow(""),
        acct_number_fedex: Joi.string().max(50).allow(""),
        custom_data_1: Joi.string().max(255).allow(""),
        custom_data_2: Joi.string().max(255).allow(""),
        custom_data_3: Joi.string().max(255).allow(""),
        recipient: Joi.object({
          first_name: Joi.string().required(),
          last_name: Joi.string().required(),
          company_name: Joi.string().allow(""),
          address_1: Joi.string().required(),
          address_2: Joi.string().allow(""),
          address_3: Joi.string().allow(""),
          city: Joi.string(),
          state_code: Joi.string().length(2).required(),
          province: Joi.string().allow(""),
          zip_postal_code: Joi.string().required(),
          country_code: Joi.string().length(2).required(),
          phone: Joi.string().allow(""),
          email: Joi.string().email(),
          address_order_po: Joi.string().allow(""),
        }),
        order_items: Joi.array()
          .items(
            Joi.object({
              product_order_po: Joi.string().allow(""),
              product_qty: Joi.number(),
              product_sku: Joi.string(),
              product_code: Joi.string(),
              product_image: Joi.object({
                pixel_width: Joi.number(),
                pixel_height: Joi.number(),
                product_url_file: Joi.string().required(),
                product_url_thumbnail: Joi.string().required(),
                library_file: Joi.object({
                  id: Joi.number(),
                  guid: Joi.string().regex(guidRegex),
                  title: Joi.string().allow(""),
                  description: Joi.string().allow(""),
                  file_name: Joi.string().required(),
                  file_size: Joi.number().required(),
                  thumbnail_file_name: Joi.string().required(),
                  preview_file_name: Joi.string().required(),
                  hires_file_name: Joi.string().required(),
                  public_thumbnail_uri: Joi.string().uri().required(),
                  public_preview_uri: Joi.string().uri().required(),
                  private_hires_uri: Joi.string().uri().required(),
                  personal_gallery_title: Joi.string().allow(""),
                  members_gallery_category: Joi.string().allow(""),
                  pix_w: Joi.number().required(),
                  pix_h: Joi.number().required(),
                  date_added: Joi.string().allow(""),
                  date_expires: Joi.string().allow(""),
                  active: Joi.boolean(),
                  products: Joi.array().items(
                    Joi.object({
                      monetary_format: Joi.string().allow(""),
                      quantity: Joi.number(),
                      quantity_in_stock: Joi.number(),
                      sku: Joi.string().allow(""),
                      product_code: Joi.string().allow(""),
                      price_details: Joi.object({
                        product_qty: Joi.number(),
                        product_sku: Joi.string(),
                        product_code: Joi.string(),
                        product_price: Joi.number(),
                        add_frame_price: Joi.number(),
                        product_price: Joi.number().precision(2),
                        add_frame_price: Joi.number().precision(2),
                        add_mat_1_price: Joi.number().precision(2),
                        add_mat_2_price: Joi.number().precision(2),
                        add_glazing_price: Joi.number().precision(2),
                        add_color_correct_price: Joi.number().precision(2),
                        total_price: Joi.number().precision(2),
                        info: Joi.string(),
                      }),
                      per_item_price: Joi.number().precision(2),
                      total_price: Joi.number().precision(2),
                      asking_price: Joi.number().precision(2),
                      name: Joi.string().allow(""),
                      description_short: Joi.string().allow(""),
                      description_long: Joi.string().allow(""),
                      image_url_1: Joi.string().uri(),
                      image_url_2: Joi.string().uri(),
                      image_url_3: Joi.string().uri(),
                      image_url_4: Joi.string().uri(),
                      image_url_5: Joi.string().uri(),
                      image_guid: Joi.string().regex(guidRegex),
                      product_size: Joi.object({
                        width: Joi.number().precision(2),
                        height: Joi.number().precision(2),
                        depth: Joi.number().precision(2),
                        ounces: Joi.number().precision(2),
                        cubic_volume: Joi.number().precision(2),
                        is_rigid: Joi.boolean(),
                      }),
                      third_party_integrations: Joi.object({
                        etsy_product_id: Joi.any().allow(null),
                        shopify_product_id: Joi.any().allow(null),
                        shopify_variant_id: Joi.any().allow(null),
                        squarespace_product_id: Joi.any().allow(null),
                        squarespace_variant_id: Joi.any().allow(null),
                        wix_inventory_id: Joi.any().allow(null),
                        wix_product_id: Joi.any().allow(null),
                        wix_variant_id: Joi.any().allow(null),
                        woocommerce_product_id: Joi.any().allow(null),
                        woocommerce_variant_id: Joi.any().allow(null),
                      }),
                    })
                  ),
                }),
              }),
              template: Joi.object({
                id: Joi.string().regex(guidRegex).required(),
                thumbnail_url: Joi.string().uri().required(),
                product_code: Joi.string().uri().required(),
              }),
              product_guid: Joi.string().regex(guidRegex),
              custom_data_1: Joi.string().allow(""),
              custom_data_2: Joi.string().allow(""),
              custom_data_3: Joi.string().allow(""),
              product_title: Joi.string().required(),
            })
          )
          .required(),
      })
    )
    .required(),
});

// Middleware for validation
exports.validateSubmitOrders = async (req, res, next) => {
  const { error, value } = ordersSchema.validate(req.body);
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


exports.updateOrder = async (req, res)  => {
  try{
    const reqBody = JSON.parse(JSON.stringify(req.body));
      if (!reqBody || !reqBody?.accountId) {
        res.status(400).json({
          statusCode: 400,
          status: false,
          message: "Bad request. This request should contain account ID",
        });
      } else {
        const orders = reqBody.orders;
        if(orders?.length){
          for(const order of orders){
            log('Order come to update', order.orderFullFillmentId);
            const selectPayload = {
              query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE FulfillmentAccountID=${reqBody.accountId} AND FulfillmentID=${order.orderFullFillmentId} limit 1`,
            };
            const selectDataQueryExecute = await finerworksService.SELECT_QUERY_FINERWORKS(
              selectPayload
            );
            log('selectDataQueryExecute', selectDataQueryExecute);
            if(!selectDataQueryExecute){
              res.status(400).json({
                statusCode: 400,
                status: false,
                message: "Bad request. Request does't contain valid fullfillment app ID",
              });
            }
            const urlEncodedData = urlEncodeJSON(order);
            const updatePayload = {
              tablename: process.env.FINER_fwAPI_FULFILLMENTS_TABLE,
              fieldupdates: `FulfillmentData='${urlEncodedData}'`,
              where: `FulfillmentID=${order.orderFullFillmentId}`,
            };
            const updateQueryExecute = await finerworksService.UPDATE_QUERY_FINERWORKS(
              updatePayload
            );
            
            if(updateQueryExecute){
              log(`Order with ${order.orderFullFillmentId} has been successfully updated`);
            }
          }
          res.status(200).json({
            statusCode: 200,
            status: true,
            message: "Orders have been successfully updated",
            data: orders,
          });
        }
      }
    } catch (err) {
      throw err;
    }
  }
/** Validate Orders
 *
 * @param {*} req
 * @param {*} res
 */
exports.validateOrders = async (req, res) => {
  try {
    const reqBody = JSON.parse(JSON.stringify(req.body));
    if (!reqBody || !reqBody.orders) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Bad Request",
      });
    } else {
      const orders = reqBody.orders;
      const consolidatedOrdersData = consolidateOrderItems(orders);
      const payloadToBeSubmitted = {
        orders: consolidatedOrdersData.orders,
        payment_token: reqBody.payment_token,
        validate_only: true,
      };
      const submitOrders = await finerworksService.SUBMIT_ORDERS(
        payloadToBeSubmitted
      );
      if (submitOrders) {
        res.status(200).json({
          statusCode: 200,
          status: true,
          message: "Orders have been validated successfully",
          data: submitOrders,
        });
      }
    }
  } catch (err) {
    const errorMessage = err.response.data;
    console.log("errorMessage", JSON.stringify(errorMessage));
    const getErrorReason = Object.keys(errorMessage.ModelState)[0];
    const finalMessage = errorMessage.ModelState[getErrorReason][0];
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: finalMessage,
    });
  }
};

/** Upload orders in local database */
exports.uploadOrdersToLocalDatabase = async (req, res) => {
  try {
    const reqBody = JSON.parse(JSON.stringify(req.body));
    if (!reqBody?.orders) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Bad Request. Orders are required.",
      });
    } else {
      const uploadedFromAppName = reqBody.uploadedFrom ?? 'Finerworks';
      const ordersToBeSubmitted = reqBody.orders;
      const consolidatedOrdersData = consolidateOrderItems(ordersToBeSubmitted);
      const payloadToBeSubmitted = {
        orders: consolidatedOrdersData.orders,
        validate_only: false,
        payment_token: reqBody.payment_token,
      };
      const { orders } = payloadToBeSubmitted;
      for (const order of orders) {
        order.createdAt = new Date();
        order.submittedAt = null;
        const urlEncodedData = urlEncodeJSON(order);
        const insertPayload = {
          tablename: process.env.FINER_fwAPI_FULFILLMENTS_TABLE,
          fields:
            "FulfillmentAccountID, FulfillmentData, FulfillmentSubmitted, FulfillmentAppName ",
          values: `'${reqBody.accountId}', '${urlEncodedData}', 0, '${uploadedFromAppName}'`,
        };
        log("insertPayload for the creation of the order in the local database", JSON.stringify(insertPayload));
        const insertData = await finerworksService.INSERT_QUERY_FINERWORKS(
          insertPayload
        );
        log("Response after submitted to the local database", JSON.stringify(insertData));
        order.orderFullFillmentId = insertData.record_id;
      }
      res.status(200).json({
        statusCode: 200,
        status: true,
        message: "Orders have been submitted successfully",
        data: orders,
      });
    }
  } catch (err) {
    console.log('error is', JSON.stringify(err), err);
  }
};


function urlEncodeJSON(data) {
  const jsonString = JSON.stringify(data);
  const encodedString = encodeURIComponent(jsonString);
  return encodedString;
}

function consolidateOrderItems(ordersData) {
  const consolidatedOrders = {};

  ordersData.forEach((order) => {
    const orderPO = order.order_po;
    if (!consolidatedOrders[orderPO]) {
      // If the order PO doesn't exist in consolidated orders, add it
      consolidatedOrders[orderPO] = { ...order };
      // Remove order items from this order
      delete consolidatedOrders[orderPO].order_items;
      // Initialize an empty array to store order items
      consolidatedOrders[orderPO].order_items = [];
    }

    // Add order items to the consolidated order
    consolidatedOrders[orderPO].order_items.push(...order.order_items);
  });

  // Convert the consolidated orders object into an array
  const result = Object.values(consolidatedOrders);

  return { orders: result, validate_only: ordersData.validate_only };
}




