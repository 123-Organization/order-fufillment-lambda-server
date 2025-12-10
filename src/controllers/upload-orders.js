const createEvent = require("../helpers/create-event");
const finerworksService = require("../helpers/finerworks-service");
const debug = require("debug");
const log = debug("app:uploadOrders");
const Joi = require("joi");
log("Upload order");


const recipientSchema = Joi.object({
  country_code: Joi.string().length(2).required().label("Country Code"), // ISO 3166-1 alpha-2
  company_name: Joi.string().allow("").optional().label("Company Name"),
  first_name: Joi.string().min(1).max(100).required().label("First Name"),
  last_name: Joi.string().min(1).max(100).required().label("Last Name"),
  address_1: Joi.string().min(1).max(255).required().label("Address 1"),
  address_2: Joi.string().allow("").optional().label("Address 2"),
  address_3: Joi.string().allow("").optional().label("Address 3"),
  city: Joi.string().min(1).max(100).required().label("City"),
  state: Joi.string().min(1).max(100).optional().label("State"),
  state_code: Joi.string().length(2)
    .when('country_code', {
      is: 'US',
      then: Joi.required(),
      otherwise: Joi.optional().allow("")
    })
    .required(),
  province: Joi.string()
    .when('country_code', {
      is: Joi.not('US'),
      then: Joi.required(),
      otherwise: Joi.optional().allow("")
    })
    .optional(),
  zip_postal_code: Joi.number().required().allow("").label("ZIP/Postal Code"),
  phone: Joi.string().allow("").label("Phone Number"),
  email: Joi.string().allow("").optional().label("email"),
  address_order_po: Joi.string().allow("").optional().label("Address order po"),


});
// # region Validate order schema
const guidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Define the validation schema
// const ordersSchema = Joi.object({
//   accountId: Joi.number().required(),
//   payment_token: Joi.string().required(),
//   orders: Joi.array()
//     .items(
//       Joi.object({
//         order_po: Joi.string().required(),
//         order_key: Joi.string(),
//         shipping_code: Joi.string().max(2).required(),
//         ship_by_date: Joi.string().allow(""),
//         gift_message: Joi.string().allow(""),
//         test_mode: Joi.boolean().required(),
//         order_status: Joi.string().allow(""),
//         customs_tax_info: Joi.object({
//           tax_id: Joi.string().max(50).allow(""),
//           tax_type: Joi.number().valid(0, 1, 2),
//         }),
//         webhook_order_status_url: Joi.string().allow(""),
//         document_url: Joi.string().max(200).allow(""),
//         acct_number_ups: Joi.string().max(50).allow(""),
//         acct_number_fedex: Joi.string().max(50).allow(""),
//         custom_data_1: Joi.string().max(255).allow(""),
//         custom_data_2: Joi.string().max(255).allow(""),
//         custom_data_3: Joi.string().max(255).allow(""),
//         recipient: Joi.object({
//           first_name: Joi.string().required(),
//           last_name: Joi.string().required(),
//           company_name: Joi.string().allow(""),
//           address_1: Joi.string().required(),
//           address_2: Joi.string().allow(""),
//           address_3: Joi.string().allow(""),
//           city: Joi.string(),
//           state_code: Joi.string().length(2).required(),
//           province: Joi.string().allow("").optional(),
//           zip_postal_code: Joi.number().required(),
//           country_code: Joi.string().length(2).required(),
//           phone: Joi.string().allow(""),
//           email: Joi.string().email(),
//           address_order_po: Joi.string().allow(""),
//         }),
//         order_items: Joi.array()
//           .items(
//             Joi.object({
//               product_order_po: Joi.string().allow(""),
//               product_qty: Joi.number(),
//               product_sku: Joi.string(),
//               product_code: Joi.string(),
//               product_image: Joi.object({
//                 pixel_width: Joi.number(),
//                 pixel_height: Joi.number(),
//                 product_url_file: Joi.string().required(),
//                 product_url_thumbnail: Joi.string().required(),
//                 library_file: Joi.object({
//                   id: Joi.number(),
//                   guid: Joi.string().regex(guidRegex),
//                   title: Joi.string().allow(""),
//                   description: Joi.string().allow(""),
//                   file_name: Joi.string().required(),
//                   file_size: Joi.number().required(),
//                   thumbnail_file_name: Joi.string().required(),
//                   preview_file_name: Joi.string().required(),
//                   hires_file_name: Joi.string().required(),
//                   public_thumbnail_uri: Joi.string().uri().required(),
//                   public_preview_uri: Joi.string().uri().required(),
//                   private_hires_uri: Joi.string().uri().required(),
//                   personal_gallery_title: Joi.string().allow(""),
//                   members_gallery_category: Joi.string().allow(""),
//                   pix_w: Joi.number().required(),
//                   pix_h: Joi.number().required(),
//                   date_added: Joi.string().allow(""),
//                   date_expires: Joi.string().allow(""),
//                   active: Joi.boolean(),
//                   products: Joi.array().items(
//                     Joi.object({
//                       monetary_format: Joi.string().allow(""),
//                       quantity: Joi.number(),
//                       quantity_in_stock: Joi.number(),
//                       sku: Joi.string().allow(""),
//                       product_code: Joi.string().allow(""),
//                       price_details: Joi.object({
//                         product_qty: Joi.number(),
//                         product_sku: Joi.string(),
//                         product_code: Joi.string(),
//                         product_price: Joi.number(),
//                         add_frame_price: Joi.number(),
//                         product_price: Joi.number().precision(2),
//                         add_frame_price: Joi.number().precision(2),
//                         add_mat_1_price: Joi.number().precision(2),
//                         add_mat_2_price: Joi.number().precision(2),
//                         add_glazing_price: Joi.number().precision(2),
//                         add_color_correct_price: Joi.number().precision(2),
//                         total_price: Joi.number().precision(2),
//                         info: Joi.string(),
//                       }),
//                       per_item_price: Joi.number().precision(2),
//                       total_price: Joi.number().precision(2),
//                       asking_price: Joi.number().precision(2),
//                       name: Joi.string().allow(""),
//                       description_short: Joi.string().allow(""),
//                       description_long: Joi.string().allow(""),
//                       image_url_1: Joi.string().uri(),
//                       image_url_2: Joi.string().uri(),
//                       image_url_3: Joi.string().uri(),
//                       image_url_4: Joi.string().uri(),
//                       image_url_5: Joi.string().uri(),
//                       image_guid: Joi.string().regex(guidRegex),
//                       product_size: Joi.object({
//                         width: Joi.number().precision(2),
//                         height: Joi.number().precision(2),
//                         depth: Joi.number().precision(2),
//                         ounces: Joi.number().precision(2),
//                         cubic_volume: Joi.number().precision(2),
//                         is_rigid: Joi.boolean(),
//                       }),
//                       third_party_integrations: Joi.object({
//                         etsy_product_id: Joi.any().allow(null),
//                         shopify_product_id: Joi.any().allow(null),
//                         shopify_variant_id: Joi.any().allow(null),
//                         squarespace_product_id: Joi.any().allow(null),
//                         squarespace_variant_id: Joi.any().allow(null),
//                         wix_inventory_id: Joi.any().allow(null),
//                         wix_product_id: Joi.any().allow(null),
//                         wix_variant_id: Joi.any().allow(null),
//                         woocommerce_product_id: Joi.any().allow(null),
//                         woocommerce_variant_id: Joi.any().allow(null),
//                       }),
//                     })
//                   ),
//                 }),
//               }),
//               template: Joi.object({
//                 id: Joi.string().regex(guidRegex).required(),
//                 thumbnail_url: Joi.string().uri().required(),
//                 product_code: Joi.string().uri().required(),
//               }),
//               product_guid: Joi.string().regex(guidRegex),
//               custom_data_1: Joi.string().allow(""),
//               custom_data_2: Joi.string().allow(""),
//               custom_data_3: Joi.string().allow(""),
//               product_title: Joi.string().optional(),
//             })
//           )
//           .required(),
//       })
//     )
//     .required(),
// });

const ordersSchema = Joi.object({
  accountId: Joi.number().required(),
  payment_token: Joi.string().required(),
  account_key: Joi.string().optional(),
  validate_only: Joi.boolean().required(),  // Added validate_only field
  orders: Joi.array()
    .items(
      Joi.object({
        order_po: Joi.string().required(),
        order_key: Joi.string().optional(),
        shipping_code: Joi.string().max(2).required(),
        ship_by_date: Joi.string().optional().allow(""),
        gift_message: Joi.string().optional().allow(""),
        test_mode: Joi.boolean().optional().required(),
        order_status: Joi.string().optional().allow(""),
        customs_tax_info: Joi.object({
          tax_id: Joi.string().max(50).optional().allow(""),
          tax_type: Joi.number().valid(0, 1, 2).optional(),
        }).optional(),
        webhook_order_status_url: Joi.string().optional().allow(""),
        document_url: Joi.string().max(200).optional().allow(""),
        acct_number_ups: Joi.string().max(50).optional().allow(""),
        acct_number_fedex: Joi.string().max(50).optional().allow(""),
        custom_data_1: Joi.string().max(255).optional().allow(""),
        custom_data_2: Joi.string().max(255).optional().allow(""),
        custom_data_3: Joi.string().max(255).optional().allow(""),
        recipient: Joi.object({
          first_name: Joi.string().required(),
          last_name: Joi.string().required(),
          company_name: Joi.string().optional().allow(""),
          address_1: Joi.string().required(),
          address_2: Joi.string().optional().allow(""),
          address_3: Joi.string().optional().allow(""),
          city: Joi.string().optional(),
          state_code: Joi.string().length(2)
            .when('country_code', {
              is: Joi.string().valid('US').insensitive(),
              then: Joi.required(),
              otherwise: Joi.optional().allow("")
            })
            .required(),
          province: Joi.string()
            .when('country_code', {
              is: Joi.string().valid(Joi.not('US')).insensitive(),
              then: Joi.required(),
              otherwise: Joi.optional().allow("")
            })
            .optional(),
          zip_postal_code: Joi.string().required(),
          country_code: Joi.string().length(2).required(),
          phone: Joi.alternatives().try(Joi.string(), Joi.number()).optional().allow(""),
          email: Joi.string().email().optional(),
          address_order_po: Joi.string().optional().allow(""),
        }).required(),
        order_items: Joi.array()
          .items(
            Joi.object({
              product_order_po: Joi.string().optional().allow(""),
              product_qty: Joi.number().required(),
              product_sku: Joi.string().optional(),
              product_code: Joi.string().optional(),
              product_cropping: Joi.string()
                .valid('crop', 'fit')
                .optional()
                .allow(""),
              product_image: Joi.object({
                pixel_width: Joi.number().optional(),
                pixel_height: Joi.number().optional(),
                product_url_file: Joi.string().optional().required(),
                product_url_thumbnail: Joi.string().optional().required(),
                library_file: Joi.object({
                  id: Joi.number().optional(),
                  guid: Joi.string().regex(guidRegex).optional(),
                  title: Joi.string().optional().allow(""),
                  description: Joi.string().optional().allow(""),
                  file_name: Joi.string().optional().required(),
                  file_size: Joi.number().optional().required(),
                  thumbnail_file_name: Joi.string().optional().required(),
                  preview_file_name: Joi.string().optional().required(),
                  hires_file_name: Joi.string().optional().required(),
                  public_thumbnail_uri: Joi.string().uri().optional().required(),
                  public_preview_uri: Joi.string().uri().optional().required(),
                  private_hires_uri: Joi.string().uri().optional().required(),
                  personal_gallery_title: Joi.string().optional().allow(""),
                  members_gallery_category: Joi.string().optional().allow(""),
                  pix_w: Joi.number().optional().required(),
                  pix_h: Joi.number().optional().required(),
                  date_added: Joi.string().optional().allow(""),
                  date_expires: Joi.string().optional().allow(""),
                  active: Joi.boolean().optional(),
                  products: Joi.array().items(
                    Joi.object({
                      monetary_format: Joi.string().optional().allow(""),
                      quantity: Joi.number().optional(),
                      quantity_in_stock: Joi.number().optional(),
                      sku: Joi.string().optional().allow(""),
                      product_code: Joi.string().optional().allow(""),
                      price_details: Joi.object({
                        product_qty: Joi.number().optional(),
                        product_sku: Joi.string().optional(),
                        product_code: Joi.string().optional(),
                        product_price: Joi.number().precision(2).optional(),
                        add_frame_price: Joi.number().precision(2).optional(),
                        add_mat_1_price: Joi.number().precision(2).optional(),
                        add_mat_2_price: Joi.number().precision(2).optional(),
                        add_glazing_price: Joi.number().precision(2).optional(),
                        add_color_correct_price: Joi.number().precision(2).optional(),
                        total_price: Joi.number().precision(2).optional(),
                        info: Joi.string().optional(),
                      }).optional(),
                      per_item_price: Joi.number().precision(2).optional(),
                      total_price: Joi.number().precision(2).optional(),
                      asking_price: Joi.number().precision(2).optional(),
                      name: Joi.string().optional().allow(""),
                      description_short: Joi.string().optional().allow(""),
                      description_long: Joi.string().optional().allow(""),
                      image_url_1: Joi.string().uri().optional(),
                      image_url_2: Joi.string().uri().optional(),
                      image_url_3: Joi.string().uri().optional(),
                      image_url_4: Joi.string().uri().optional(),
                      image_url_5: Joi.string().uri().optional(),
                      image_guid: Joi.string().regex(guidRegex).optional(),
                      product_size: Joi.object({
                        width: Joi.number().precision(2).optional(),
                        height: Joi.number().precision(2).optional(),
                        depth: Joi.number().precision(2).optional(),
                        ounces: Joi.number().precision(2).optional(),
                        cubic_volume: Joi.number().precision(2).optional(),
                        is_rigid: Joi.boolean().optional(),
                      }).optional(),
                      third_party_integrations: Joi.object({
                        etsy_product_id: Joi.any().optional().allow(null),
                        shopify_product_id: Joi.any().optional().allow(null),
                        shopify_variant_id: Joi.any().optional().allow(null),
                        squarespace_product_id: Joi.any().optional().allow(null),
                        squarespace_variant_id: Joi.any().optional().allow(null),
                        wix_inventory_id: Joi.any().optional().allow(null),
                        wix_product_id: Joi.any().optional().allow(null),
                        wix_variant_id: Joi.any().optional().allow(null),
                        woocommerce_product_id: Joi.any().optional().allow(null),
                        woocommerce_variant_id: Joi.any().optional().allow(null),
                      }).optional(),
                    })
                  ).optional(),
                }).optional(),
              }).optional(),
              template: Joi.object({
                id: Joi.string().regex(guidRegex).required(),
                thumbnail_url: Joi.string().uri().required(),
                product_code: Joi.string().uri().required(),
              }).optional(),
              product_guid: Joi.string().regex(guidRegex).optional(),
              custom_data_1: Joi.string().optional().allow(""),
              custom_data_2: Joi.string().optional().allow(""),
              custom_data_3: Joi.string().optional().allow(""),
              product_title: Joi.string().optional().allow(""),
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


exports.updateOrder = async (req, res) => {
  try {
    const reqBody = JSON.parse(JSON.stringify(req.body));

    const { error } = recipientSchema.validate(reqBody?.orders?.[0]?.recipient);
    if (error) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: `Validation error: ${error.details[0].message}`,
      });
    }
    if (!reqBody || !reqBody?.accountId) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Bad request. This request should contain account ID",
      });
    } else {
      const orders = reqBody.orders;
      if (orders?.length) {
        for (const order of orders) {
          log('Order come to update', order.orderFullFillmentId);
          const selectPayload = {
            query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE FulfillmentAccountID=${reqBody.accountId} AND FulfillmentID=${order.orderFullFillmentId} limit 1`,
          };
          const selectDataQueryExecute = await finerworksService.SELECT_QUERY_FINERWORKS(
            selectPayload
          );
          log('selectDataQueryExecute', selectDataQueryExecute);
          if (!selectDataQueryExecute) {
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

          if (updateQueryExecute) {
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
        account_key: reqBody.account_key
      };
      console.log("payloadToBeSubmitted=====", payloadToBeSubmitted);
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

exports.uploadOrdersToLocalDatabaseFromExcel = async (req, res) => {
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
        console.log("order.order_items[0]?.image_url_1", order.order_items[0]?.product_url_thumbnail)
        if (
          (order.order_items[0]?.product_image.product_url_file && order.order_items[0].product_image.product_url_file.trim() !== "") &&
          (order.order_items[0]?.product_image.product_url_thumbnail && order.order_items[0].product_image.product_url_thumbnail.trim() !== "")
        ) {
          order.source = "excel"
          console.log("order===========>>>>", order);
          order.createdAt = new Date();
          order.submittedAt = null;
          if (Array.isArray(order.order_items)) {
            for (const item of order.order_items) {
              item.product_guid = generateGUID();
            }
          }
          const urlEncodedData = urlEncodeJSON(order);

          const selectPayload = {
            query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE FulfillmentAccountID=${reqBody.accountId} AND FulfillmentSubmitted=0 AND FulfillmentDeleted=0 AND FulfillmentAppName='excel'`,
          };

          const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(selectPayload);

          const orderPos = getFulfillmentData(selectData.data);

          const filteredObject = orderPos.find(item => item.order_po === order.order_po);

          if (filteredObject) {
            console.log("enter in this block");
            const updatePayload = {
              tablename: process.env.FINER_fwAPI_FULFILLMENTS_TABLE,
              fieldupdates: `FulfillmentData='${urlEncodedData}'`,
              where: `FulfillmentID=${filteredObject.FulfillmentID}`,
            };
            console.log("updatePayload=========>>>>", updatePayload);
            const updateQueryExecute = await finerworksService.UPDATE_QUERY_FINERWORKS(updatePayload);
          } else {
            // console.log("yessssssssssssssssssssssssssss")
            const insertPayload = {
              tablename: process.env.FINER_fwAPI_FULFILLMENTS_TABLE,
              fields:
                "FulfillmentAccountID, FulfillmentData, FulfillmentSubmitted, FulfillmentAppName ",
              values: `'${reqBody.accountId}', '${urlEncodedData}', 0, 'excel'`,

            };
            console.log("insertPayload============>>>>>", insertPayload);
            log("insertPayload for the creation of the order in the local database", JSON.stringify(insertPayload));
            const insertData = await finerworksService.INSERT_QUERY_FINERWORKS(
              insertPayload
            );
            log("Response after submitted to the local database", JSON.stringify(insertData));
            order.orderFullFillmentId = insertData.record_id;
          }
        }

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
        order.source = "woocommerece"
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

exports.uploadOrdersToLocalDatabaseShopify = async (req, res) => {
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
        order.source = "Shopify"
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

const getFulfillmentData = (data) => {
  return data.map(item => {
    const fulfillmentDataDecoded = decodeURIComponent(item.FulfillmentData);
    const fulfillmentDataJson = JSON.parse(fulfillmentDataDecoded);

    return {
      FulfillmentID: item.FulfillmentID,
      order_po: fulfillmentDataJson.order_po
    };
  });
};

function generateGUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}