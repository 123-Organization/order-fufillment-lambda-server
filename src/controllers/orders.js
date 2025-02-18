const createEvent = require("../helpers/create-event");
const finerworksService = require("../helpers/finerworks-service");
const debug = require("debug");
const log = debug("app:uploadOrders");
const Joi = require("joi");
const { validateOrderPayload } = require("./validate-order");
log("Orders");
exports.viewAllOrders = async (req, res) => {
  try {
    const reqBody = JSON.parse(JSON.stringify(req.body));
    if (!reqBody || !reqBody.accountId) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Bad Request",
      });
    } else {
      log("Request comes to get order details for", JSON.stringify(reqBody));
      const selectPayload = {
        query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE FulfillmentAccountID=${reqBody.accountId} AND FulfillmentDeleted=0 ORDER BY FulfillmentID DESC`,
      };
      const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(
        selectPayload
      );
      log("Order received", JSON.stringify(selectData));
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
    log("Error while fetching all the orders", JSON.stringify(err));
    res.status(400).json({
      statusCode: 400,
      status: true,
      message: "Something went wrong",
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
    log("Select query to fetch the orders", JSON.stringify(selectPayload));
    const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(
      selectPayload
    );
    log("Order Data", JSON.stringify(selectData));
    if (!selectData?.data.length) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Invalid order. Please try with valid order.",
      });
    }
    const orderDetails = selectData.data[0];
    // If order exist then find the product details
    const { skuCode, productCode } = reqBody;
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
    const getProductDetails = await finerworksService.LIST_VIRTUAL_INVENTORY(
      searchListVirtualInventoryParams
    );
    log("Get product details", JSON.stringify(getProductDetails));
    if (getProductDetails?.status?.success) {
      const { products } = getProductDetails;
      const previousOrder = urlDecodeJSON(orderDetails.FulfillmentData);
      const orderData = {
        product_qty: products[0].quantity,
        product_sku: products[0].sku,
        product_title: products[0].name,
        product_guid: products[0].image_guid,
        template: null,
        custom_data_1: null,
        custom_data_2: null,
        custom_data_3: null,
      };
      if (previousOrder?.order_items) {
        previousOrder.order_items.push(orderData);
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
  } catch (err) {
    const errorMessage = err.response.data;
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: errorMessage,
    });
  }
};
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
    const { accountId,  payment_token} = reqBody;
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
