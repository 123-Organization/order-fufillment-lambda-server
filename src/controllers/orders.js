const createEvent = require("../helpers/create-event");
const finerworksService = require("../helpers/finerworks-service");
const debug = require("debug");
const log = debug("app:uploadOrders");
const Joi = require("joi");
const { validateOrderPayload } = require("./validate-order");
log("Orders");
const axios = require('axios'); // Import axios for making HTTP requests



exports.viewAllOrders = async (req, res) => {
  try {
    // Validate request body format
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Invalid request format. Expected a JSON object.",
      });
    }

    const { accountId } = req.body;
    if (!accountId) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Account ID is missing or invalid.",
      });
    }

    log("Request to get order details for", JSON.stringify(req.body));

    const selectPayload = {
      query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE FulfillmentAccountID=${accountId} AND FulfillmentDeleted=0 ORDER BY FulfillmentID DESC`,
    };

    const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(selectPayload);

    if (!selectData || !selectData.data || !Array.isArray(selectData.data)) {
      log("No orders found for account ID:", accountId);
      return res.status(404).json({
        statusCode: 404,
        status: false,
        message: "No orders found for the provided account ID.",
      });
    }

    // Process orders
    let allOrders = selectData.data.map((order) => {
      let orderData = urlDecodeJSON(order.FulfillmentData);
      orderData.orderFullFillmentId = order.FulfillmentID;
      return orderData;
    });

    // Handle empty order array case
    if (allOrders.length === 0) {
      log("No orders found after processing for account ID:", accountId);
      return res.status(404).json({
        statusCode: 404,
        status: false,
        message: "No orders available for this account.",
        data: [],
      });
    }

    res.status(200).json({
      statusCode: 200,
      status: true,
      message: "Orders found successfully.",
      data: allOrders,
    });

  } catch (err) {
    log("Error while fetching orders:", err?.message || JSON.stringify(err));

    res.status(500).json({
      statusCode: 500,
      status: false,
      message: "Internal server error. Please try again later.",
      error: err?.message || "Unknown error",
    });
  }
};


exports.viewOrderDetails = async (req, res) => {
  try {
    const reqBody = JSON.parse(JSON.stringify(req.body));

    if (!reqBody || !reqBody.accountId || !reqBody.orderFullFillmentId) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Bad Request",
      });
    } else {
      log("Request comes to get order details for", JSON.stringify(reqBody));
      const selectPayload = {
        query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE  FulfillmentID=${reqBody.orderFullFillmentId}`,
      };
      log("select payload is", JSON.stringify(selectPayload));
      const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(
        selectPayload
      );
      log("selectData", JSON.stringify(selectData));
      if (selectData) {
        let allOrders = [];
        selectData.data.forEach((order) => {
          let latestOrderToBePushed = urlDecodeJSON(order.FulfillmentData);
          latestOrderToBePushed.orderFullFillmentId = order.FulfillmentID;
          allOrders.push(latestOrderToBePushed);
        });
        res.status(200).json({
          statusCode: 200,
          status: true,
          message: "Orders Found",
          data: allOrders,
        });
      }
    }
  } catch (err) {
    throw err;
  }
};
exports.updateOrderByProductSkuCode = async (req, res) => {
  try {
    const reqBody = JSON.parse(JSON.stringify(req.body));
    console.log("testinggggggggg",req.body);
    var getProductDetails

    if (!reqBody.orderFullFillmentId) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Orderfullfillment Id is required.",
      });
    }
    if (!reqBody.skuCode && !reqBody.productCode) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Sku code or Product Guid is required",
      });
    }

    // Fetch first if order is exist
    log(
      "Request comes to get order details to update product details",
      JSON.stringify(reqBody)
    );
    const selectPayload = {
      query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE  FulfillmentID=${reqBody.orderFullFillmentId}`,
    };
    console.log("selectPayload=====>>>>>",selectPayload);
    log("Select query to fetch the orders", JSON.stringify(selectPayload));
    const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(
      selectPayload
    );
    console.log("selectData=====>>>>>",selectData);

    log("Order Data", JSON.stringify(selectData));
    if (selectData?.data.length===0) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Invalid order. Please try with valid order.",
      });
    }
    const orderDetails = selectData.data[0];
    // If order exist then find the product details
    const { skuCode, productCode,fromTheInventory } = reqBody;
    const searchListVirtualInventoryParams = {};
    if (skuCode != "") {
      searchListVirtualInventoryParams.sku_filter = [skuCode];
    }
    if (productCode != "") {
      searchListVirtualInventoryParams.product_code_filter = [productCode];
    }
    log(
      "Request come to search product from virtual inventory for the payload",
      JSON.stringify(searchListVirtualInventoryParams)
    );
    console.log("okkkkkkkkkkkkkkkkkkkkkkkkkk")
    if (skuCode || fromTheInventory) {
       getProductDetails = await finerworksService.LIST_VIRTUAL_INVENTORY(
        searchListVirtualInventoryParams
      );
      console.log("only sku",getProductDetails)
      if (getProductDetails?.status?.success) {
        let product = getProductDetails.products;
        console.log("product====",product)
        const previousOrder = urlDecodeJSON(orderDetails.FulfillmentData);
        const orderData ={
          product_qty: product?.[0]?.quantity ?? null,
        product_sku: product?.[0]?.sku ? product?.[0]?.sku : product?.[0]?.product_code,
        product_title: product?.[0]?.name ?? null,
        product_guid: product?.[0]?.image_guid === '00000000-0000-0000-0000-000000000000'
          ? null
          : product?.[0]?.image_guid ?? null,
        template: null,
        custom_data_1: null,
        custom_data_2: null,
        custom_data_3: null,
        }
        console.log("orderData====>>>>",orderData);
        previousOrder.order_items.push(orderData);
        console.log(previousOrder,"previousOrder")
        const urlEncodedData = urlEncodeJSON(previousOrder);
        const updatePayload = {
          tablename: process.env.FINER_fwAPI_FULFILLMENTS_TABLE,
          fieldupdates: `FulfillmentData='${urlEncodedData}'`,
          where: `FulfillmentID=${reqBody.orderFullFillmentId}`,
        };
        const updateQueryExecute =
          await finerworksService.UPDATE_QUERY_FINERWORKS(updatePayload);
        if (updateQueryExecute) {
          res.status(200).json({
            statusCode: 200,
            status: true,
            message: "Orders have been successfully updated",
            data: previousOrder,
          });
        } else {
          res.status(400).json({
            statusCode: 400,
            status: true,
            message: "Something went wrong!",
          });
        }

        
      }
    } else if(productCode) {
      var payload = [{
        "product_order_po": "ORDER_PO_927668",
        "product_qty": 1,
        "product_sku": skuCode?skuCode:productCode,
        "product_image": {
          "pixel_width": reqBody.pixel_width,
          "pixel_height": reqBody.pixel_height,
          "product_url_file":reqBody.product_url_file[0],
          "product_url_thumbnail": reqBody.product_url_thumbnail[0]
        }
      }];
      log("Product details from API", JSON.stringify(getProductDetails));
      getProductDetails = await finerworksService.GET_PRODUCTS_DETAILS(payload);
      log("Get product details", JSON.stringify(getProductDetails));    
    if (getProductDetails?.status?.success) {
      let products = skuCode
      ? getProductDetails.products
      : getProductDetails.product_list;
      const previousOrder = urlDecodeJSON(orderDetails.FulfillmentData);
      const orderData = reqBody.product_url_file.map((url, index) => ({
        product_qty: products?.[0]?.quantity ?? null,
        product_sku: products?.[0]?.sku ? products?.[0]?.sku : products?.[0]?.product_code,
        product_title: products?.[0]?.name ?? null,
        product_guid: generateGUID(),
        template: null,
        custom_data_1: null,
        custom_data_2: null,
        custom_data_3: null,
        product_url_file: url,
        product_url_thumbnail: reqBody.product_url_thumbnail[index],
        pixel_width: reqBody.pixel_width ?? "",
        pixel_height: reqBody.pixel_height ?? "",
      }));      
      
      if (previousOrder?.order_items) {
        orderData.forEach((item, index) => {       
           previousOrder.order_items.push(item);
        })
      }
      log("Previous order is", JSON.stringify(previousOrder));
      // update order
      const urlEncodedData = urlEncodeJSON(previousOrder);
      const updatePayload = {
        tablename: process.env.FINER_fwAPI_FULFILLMENTS_TABLE,
        fieldupdates: `FulfillmentData='${urlEncodedData}'`,
        where: `FulfillmentID=${reqBody.orderFullFillmentId}`,
      };
      const updateQueryExecute =
        await finerworksService.UPDATE_QUERY_FINERWORKS(updatePayload);
      if (updateQueryExecute) {
        res.status(200).json({
          statusCode: 200,
          status: true,
          message: "Orders have been successfully updated",
          data: previousOrder,
        });
      } else {
        res.status(400).json({
          statusCode: 400,
          status: true,
          message: "Something went wrong!",
        });
      }
    }
    }
    
  } catch (err) {
    const errorMessage = err.response.data;
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: errorMessage,
    });
  }
};


function generateGUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
exports.createNewOrder = async (req, res) => {
  try {
    const reqBody = JSON.parse(JSON.stringify(req.body));
    if (
      !reqBody.accountId ||
      !reqBody.product_code ||
      !reqBody.recipient ||
      !reqBody.shipping_code
    ) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message:
          "Account Id, product code, shipping code & recipient details are required.",
      });
    }
    // First create order PO number
    const orderPoNumber = `ORDER_PO_${Math.floor(
      100000 + Math.random() * 900000
    )}`;
    // Fetch the product details
    const { product_code, recipient, accountId, shipping_code, thumbnailUrl } =
      reqBody;
    const searchListVirtualInventoryParams = {};
    if (product_code != "") {
      searchListVirtualInventoryParams.product_code_filter = [product_code];
    }
    log(
      "Request come to search product from virtual inventory for the payload",
      JSON.stringify(searchListVirtualInventoryParams)
    );
    let productPayload = [];
    const getProductDetails = await finerworksService.LIST_VIRTUAL_INVENTORY(
      searchListVirtualInventoryParams
    );
    log("Get product details", JSON.stringify(getProductDetails));
    if (getProductDetails?.status?.success) {
      const { products } = getProductDetails;
      if (!products.length) {
        productPayload = [
          {
            product_order_po: `PO_${Math.floor(
              100000 + Math.random() * 900000
            )}`,
            product_qty: 1,
            product_sku: product_code,
            product_image: {
              product_url_file: thumbnailUrl,
              product_url_thumbnail: thumbnailUrl,
            },
            template: null,
            custom_data_1: null,
            custom_data_2: null,
            custom_data_3: null,
          },
        ];
      } else {
        productPayload = [
          {
            product_order_po: `PO_${Math.floor(
              100000 + Math.random() * 900000
            )}`,
            product_qty: products[0].quantity,
            product_sku: products[0].sku,
            product_image: {
              product_url_file: products[0].image_url_1 || thumbnailUrl,
              product_url_thumbnail: products[0].image_url_1 || thumbnailUrl,
            },
            product_title: products[0].name,
            template: null,
            product_guid: products[0].image_guid,
            custom_data_1: null,
            custom_data_2: null,
            custom_data_3: null,
          },
        ];
      }
    }

    const newOrderToBeCreated = [
      {
        order_po: orderPoNumber,
        recipient,
        shipping_code,
        order_items: productPayload,
      },
    ];
    log("new order created is", JSON.stringify(newOrderToBeCreated));
    // validate order
    const isValidOrder = await validateOrderPayload(newOrderToBeCreated);
    if (isValidOrder) {
      const ordersToBeSubmitted = newOrderToBeCreated;
      for (const order of ordersToBeSubmitted) {
        const urlEncodedData = urlEncodeJSON(order);
        const insertPayload = {
          tablename: process.env.FINER_fwAPI_FULFILLMENTS_TABLE,
          fields:
            "FulfillmentAccountID, FulfillmentData, FulfillmentSubmitted, FulfillmentAppName ",
          values: `'${accountId}', '${urlEncodedData}', 0, 'web'`,
        };
        log("insertPayload", JSON.stringify(insertPayload));
        const insertData = await finerworksService.INSERT_QUERY_FINERWORKS(
          insertPayload
        );
        log("insertData", JSON.stringify(insertData));
        order.orderFullFillmentId = insertData.record_id;
      }
      res.status(200).json({
        statusCode: 200,
        status: true,
        message: "Orders have been created successfully",
        data: ordersToBeSubmitted,
      });
    }
  } catch (err) {
    log("Error comes while creating a new order", JSON.stringify(err), err);
    const errorMessage = err.response.data;
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: errorMessage,
    });
  }
};
exports.deleteOrder = async (req, res) => {
  try {
    const reqBody = JSON.parse(JSON.stringify(req.body));
    if (!reqBody.accountId || !reqBody.orderFullFillmentId) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Account Id and order fullfillment Id are required.",
      });
    } else {
      const { orderFullFillmentId, accountId } = reqBody;
      log("Request comes to delete order for", JSON.stringify(reqBody));
      const selectPayload = {
        query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE FulfillmentID=${orderFullFillmentId} AND FulfillmentAccountID = ${accountId}`,
      };
      const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(
        selectPayload
      );
      if (selectData?.data.length) {
        const orderDetails = selectData?.data[0];
        if (orderDetails.FulfillmentDeleted) {
          res.status(400).json({
            statusCode: 400,
            status: false,
            message: "This order has already deleted.",
          });
        } else {
          const updatePayload = {
            tablename: process.env.FINER_fwAPI_FULFILLMENTS_TABLE,
            fieldupdates: `FulfillmentDeleted=1`,
            where: `FulfillmentID=${orderFullFillmentId}`,
          };
          const updateQueryExecute =
            await finerworksService.UPDATE_QUERY_FINERWORKS(updatePayload);
          if (updateQueryExecute) {
            log(
              "Order has been successfully deleted for",
              JSON.stringify(reqBody)
            );
            res.status(200).json({
              statusCode: 200,
              status: true,
              message: `Order with fulfillment ID ${orderFullFillmentId} has been successfully deleted.`,
            });
          } else {
            res.status(400).json({
              statusCode: 400,
              status: true,
              message: `Something went wrong while deleting the order of fulfillment ID ${orderFullFillmentId}`,
            });
          }
        }
      }
    }
  } catch (err) {
    log("Error comes while creating a new order", JSON.stringify(err), err);
    const errorMessage = err.response.data;
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: errorMessage,
    });
  }
};
exports.submitOrders = async (req, res) => {
  try {
    const reqBody = JSON.parse(JSON.stringify(req.body));
    if (!reqBody?.orders || !reqBody?.payment_token || !reqBody?.accountId) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Bad Request.",
      });
    }
    const { accountId, payment_token } = reqBody;
    const ordersToBeSubmitted = reqBody.orders;
    if (ordersToBeSubmitted?.length) {
      let orderFulfillmentIds = [];
      const finalOrders = orders.map((order) => {
        if (!order.orderFullFillmentId) {
          throw new Error("Bad request: Missing orderFullFillmentId");
        }
        orderFulfillmentIds.push(order.orderFullFillmentId);
        const orderData = urlDecodeJSON(order.FulfillmentData);
        delete orderData.orderFullFillmentId;
        delete orderData.createdAt;
        delete orderData.submittedAt;
        return orderData;
      });
      // Create a final payload to submit the order in finerworks
      const finalPayload = {
        orders: finalOrders,
        validate_only: false,
        payment_token,
      };
      log("Submit order in finerwork database", JSON.stringify(finalPayload));
      const submitData = await finerworksService.SUBMIT_ORDERS(finalPayload);
      log(
        "Response after submitted to the final database",
        JSON.stringify(submitData)
      );
      // once it gets submitted Now update each order fulfillment Id with submitted status & submitted at time
      if (orderFulfillmentIds.length) {
        await Promise.all(
          orderFulfillmentIds.map(async (fulfillmentId) => {
            log("Fetch details for the order fulfillment Id", fulfillmentId);
            const selectPayload = {
              query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE FulfillmentID=${fulfillmentId} AND FulfillmentAccountID=${accountId}`,
            };

            const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(selectPayload);
            if (!selectData?.data.length) return;

            const orderDetails = selectData.data[0];
            const orderDetail = urlDecodeJSON(orderDetails.FulfillmentData);
            orderDetail.submittedAt = new Date();
            orderDetail.payment_token = payment_token;

            const urlEncodedData = urlEncodeJSON(orderDetail);
            const updatePayload = {
              tablename: process.env.FINER_fwAPI_FULFILLMENTS_TABLE,
              fieldupdates: `FulfillmentSubmitted=1, FulfillmentData='${urlEncodedData}'`,
              where: `FulfillmentID=${fulfillmentId}`,
            };

            await finerworksService.UPDATE_QUERY_FINERWORKS(updatePayload);
          })
        );
      }
    }
  } catch (err) {
    log("Error comes while submitting a new order", JSON.stringify(err), err);
    const errorMessage = err.response.data;
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: errorMessage,
    });
  }
};
exports.orderSubmitStatus = async (req, res) => {
  try {
    const reqBody = JSON.parse(JSON.stringify(req.body));
    if (!reqBody.accountId || !reqBody.orderFullFillmentId) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Account Id and order fullfillment Id are required.",
      });
    } else {
      const { orderFullFillmentId, accountId } = reqBody;
      log("Request comes to delete order for", JSON.stringify(reqBody));
      const selectPayload = {
        query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE FulfillmentID=${orderFullFillmentId} AND FulfillmentAccountID = ${accountId}`,
      };
      const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(
        selectPayload
      );
      if (selectData?.data.length) {
        const orderDetails = selectData?.data[0];
        const orderDetail = urlDecodeJSON(orderDetails.FulfillmentData);
        if (orderDetails.FulfillmentDeleted) {
          res.status(400).json({
            statusCode: 400,
            status: false,
            message: "This is a deleted order.",
          });
        } else if (orderDetails.FulfillmentSubmitted) {
          log(
            "Order has been successfully deleted for",
            JSON.stringify(reqBody)
          );
          res.status(200).json({
            statusCode: 200,
            status: true,
            createdAt: orderDetail?.createdAt ?? "N/A",
            submittedAt: orderDetail?.submittedAt ?? "N/A",
            orderStatus: true,
          });
        } else {
          res.status(200).json({
            statusCode: 200,
            status: true,
            createdAt: orderDetail?.createdAt,
            submittedAt: orderDetail?.submittedAt ?? "N/A",
            orderStatus: false,
          });
        }
      }
    }
  } catch (err) {
    log("Error comes while creating a new order", JSON.stringify(err), err);
    const errorMessage = err.response.data;
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: errorMessage,
    });
  }
};

exports.getOrderPrice = async (req, res) => {
  try {
    const reqBody = JSON.parse(JSON.stringify(req.body));
    if (!reqBody?.orderId) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Bad Request",
      });
    }
    const getPricesData = await finerworksService.GET_ORDERS_PRICE(reqBody);
    if (getPricesData) {
      res.status(200).json({
        statusCode: 200,
        status: true,
        message: "Prices Found",
        data: getPricesData,
      });
    } else {
      res.status(404).json({
        statusCode: 404,
        status: false,
        message: "Prices Not Found",
      });
    }
  } catch (err) {
    throw err;
  }
};


exports.getOrderDetailsById = async (req, res) => {
  try {
    const reqBody = JSON.parse(JSON.stringify(req.query));
    if (!reqBody || !reqBody.orderId || !reqBody.platformName) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Bad Request, missing orderId or PlatformName",
      });
    }

    const { orderId, platformName } = req.query;
    log("Request comes to get order details for orderId:", orderId, "Platform:", platformName);

    let orderDetails;

    // Dummy API calls based on platform name
    if (platformName === 'woocommerce') {
      try {
        // Simulating the API call for WooCommerce
        const response = await axios.post(
          'https://artsafenet.com/wp-json/finerworks-media/v1/get-order-by-id',
          {
            orderid: orderId,  // Passing the orderId in the request body
          }
        );

        orderDetails = response.data; // Assuming the API returns order details in the data field
      } catch (error) {
        return res.status(500).json({
          statusCode: 500,
          status: false,
          message: "Error fetching order details from WooCommerce",
        });
      }
    } else if (platformName === 'PlatformB') {
      try {
        // Simulate an API call for PlatformB
        orderDetails = await dummyPlatformBCall(orderId); // Assuming dummyPlatformBCall is a function you defined elsewhere
      } catch (error) {
        return res.status(500).json({
          statusCode: 500,
          status: false,
          message: "Error fetching order details from PlatformB",
        });
      }
    } else {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Platform not supported",
      });
    }

    return res.status(200).json({
      statusCode: 200,
      status: true,
      order_details: orderDetails,
    });
  } catch (err) {
    log("Error while fetching order details", JSON.stringify(err), err);
    return res.status(400).json({
      statusCode: 400,
      status: false,
      message: "Error while fetching order details",
    });
  }
};



function urlDecodeJSON(data) {
  const decodedJsonString = decodeURIComponent(data);
  const decodedJsonObject = JSON.parse(decodedJsonString);
  return decodedJsonObject;
}
function urlEncodeJSON(data) {
  const jsonString = JSON.stringify(data);
  const encodedString = encodeURIComponent(jsonString);
  return encodedString;
}
