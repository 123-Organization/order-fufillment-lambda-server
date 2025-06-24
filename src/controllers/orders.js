const createEvent = require("../helpers/create-event");
const finerworksService = require("../helpers/finerworks-service");
const debug = require("debug");
const log = debug("app:uploadOrders");
const Joi = require("joi");
const { validateOrderPayload } = require("./validate-order");
log("Orders");
const axios = require('axios'); // Import axios for making HTTP requests



// exports.viewAllOrders = async (req, res) => {
//   try {
//     // Validate request body format
//     if (!req.body || typeof req.body !== "object") {
//       return res.status(400).json({
//         statusCode: 400,
//         status: false,
//         message: "Invalid request format. Expected a JSON object.",
//       });
//     }

//     const { accountId } = req.body;
//     if (!accountId) {
//       return res.status(400).json({
//         statusCode: 400,
//         status: false,
//         message: "Account ID is missing or invalid.",
//       });
//     }

//     log("Request to get order details for", JSON.stringify(req.body));

//     const selectPayload = {
//       query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE FulfillmentAccountID=${accountId} AND FulfillmentDeleted=0 ORDER BY FulfillmentID DESC`,
//     };

//     const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(selectPayload);

//     if (!selectData || !selectData.data || !Array.isArray(selectData.data)) {
//       log("No orders found for account ID:", accountId);
//       return res.status(200).json({
//         statusCode: 200,
//         status: false,
//         message: "No orders found for the provided account ID.",
//       });
//     }
//     console.log("selectPayload",selectData);
//     // Process orders
//     let allOrders = selectData.data.map((order) => {
//       let orderData = urlDecodeJSON(order.FulfillmentData);
//       orderData.orderFullFillmentId = order.FulfillmentID;
//       return orderData;
//     });

//     // Handle empty order array case
//     if (allOrders.length === 0) {
//       log("No orders found after processing for account ID:", accountId);
//       return res.status(200).json({
//         statusCode: 200,
//         status: false,
//         message: "No orders available for this account.",
//         data: [],
//       });
//     }

//     res.status(200).json({
//       statusCode: 200,
//       status: true,
//       message: "Orders found successfully.",
//       data: allOrders,
//     });

//   } catch (err) {
//     log("Error while fetching orders:", err?.message || JSON.stringify(err));

//     res.status(500).json({
//       statusCode: 500,
//       status: false,
//       message: "Internal server error. Please try again later.",
//       error: err?.message || "Unknown error",
//     });
//   }
// };




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

    const { accountId, page , limit  } = req.body;

    if (!accountId) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Account ID is missing or invalid.",
      });
    }

    // Convert page and limit to numbers and ensure positive integers
    const pageNum = parseInt(page, 10) > 0 ? parseInt(page, 10) : 1;
    const limitNum = parseInt(limit, 10) > 0 ? parseInt(limit, 10) : 10;

    log("Request to get order details for", JSON.stringify(req.body));

    const selectPayload = {
      query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE FulfillmentAccountID=${accountId} AND FulfillmentDeleted=0 ORDER BY FulfillmentID DESC`,
    };

    const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(selectPayload);

    if (!selectData || !selectData.data || !Array.isArray(selectData.data)) {
      log("No orders found for account ID:", accountId);
      return res.status(200).json({
        statusCode: 200,
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

    if (allOrders.length === 0) {
      log("No orders found after processing for account ID:", accountId);
      return res.status(200).json({
        statusCode: 200,
        status: false,
        message: "No orders available for this account.",
        data: [],
      });
    }

    // Pagination calculations
    const totalOrders = allOrders.length;
    const totalPages = Math.ceil(totalOrders / limitNum);
    const startIndex = (pageNum - 1) * limitNum;
    const endIndex = startIndex + limitNum;

    // Slice orders for current page
    const paginatedOrders = allOrders.slice(startIndex, endIndex);

    res.status(200).json({
      statusCode: 200,
      status: true,
      message: "Orders found successfully.",
      data: paginatedOrders,
      pagination: {
        totalOrders,
        totalPages,
        currentPage: pageNum,
        pageSize: limitNum,
      },
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
    console.log("testinggggggggg", req.body);
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
    console.log("selectPayload=====>>>>>", selectPayload);
    log("Select query to fetch the orders", JSON.stringify(selectPayload));
    const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(
      selectPayload
    );
    console.log("selectData=====>>>>>", selectData);

    log("Order Data", JSON.stringify(selectData));
    if (selectData?.data.length === 0) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Invalid order. Please try with valid order.",
      });
    }
    const orderDetails = selectData.data[0];
    // If order exist then find the product details
    const { skuCode, productCode, fromTheInventory, account_key } = reqBody;
    const searchListVirtualInventoryParams = {};
    if (skuCode != "") {
      searchListVirtualInventoryParams.sku_filter = [skuCode];
    }
    if (productCode != "") {
      searchListVirtualInventoryParams.product_code_filter = [productCode];
    }
    if (account_key) {
      searchListVirtualInventoryParams.account_key = [account_key];
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
      console.log("only sku", getProductDetails);
      if (getProductDetails.products.length === 0) {
        return res.status(200).json({
          statusCode: 200,
          status: true,
          message: "No product found!",
        });
      }

      if (getProductDetails?.status?.success) {
        let product = getProductDetails.products;
        console.log("product====", product)
        const previousOrder = urlDecodeJSON(orderDetails.FulfillmentData);
        const orderData = {
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
        console.log("orderData====>>>>", orderData);
        previousOrder.order_items.push(orderData);
        console.log(previousOrder, "previousOrder")
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
    } else if (productCode) {
      console.log("got the entry 12121212")
      // var payload = [{
      //   // "product_order_po": "ORDER_PO_927668",
      //   "product_qty": 1,
      //   "product_sku": skuCode ? skuCode : productCode,
      //   "product_image": {
      //     "pixel_width": reqBody.pixel_width,
      //     "pixel_height": reqBody.pixel_height,
      //     "product_url_file": reqBody.product_url_file[0],
      //     "product_url_thumbnail": reqBody.product_url_thumbnail[0],
          
      //   }
      // }];
      const payload = {
        products: [{
            product_qty: 1,
            product_sku: reqBody.skuCode ? reqBody.skuCode : reqBody.productCode,
            product_image: {
                pixel_width: reqBody.pixel_width,
                pixel_height: reqBody.pixel_height,
                product_url_file: reqBody.product_url_file[0],
                product_url_thumbnail: reqBody.product_url_thumbnail[0]
            }
        }],
        account_key: reqBody.account_key
    };

      log("Product details from API", JSON.stringify(getProductDetails));
      getProductDetails = await finerworksService.GET_PRODUCTS_DETAILS(payload);
      log("Get product details", JSON.stringify(getProductDetails));
      console.log("getProductDetails",getProductDetails);
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
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
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
    if (!reqBody?.orders || !reqBody?.payment_token || !reqBody?.accountId || !reqBody?.account_key) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Bad Request.",
      });
    }
    const { accountId, payment_token,account_key } = reqBody;
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
        account_key:account_key
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
    console.log("hererererere");
    const reqBody = JSON.parse(JSON.stringify(req.body));

    // Check if orderIds and platformName are provided in the request body
    if (!reqBody || !reqBody.orderIds || !Array.isArray(reqBody.orderIds) || !reqBody.orderIds.length) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Bad Request, missing orderIds or PlatformName",
      });
    }

    const { platformName } = req.query;
    const { orderIds, accountId } = reqBody;

    if (!accountId) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Account ID is missing or invalid.",
      });
    }

    let orderDetails;
    console.log("orderIds===========>>>>", orderIds);
    console.log("platformName===========>>>>", platformName);
    console.log("accountId===========>>>>", accountId);

    // Modified query based on your new requirements
    // const selectPayload = {
    //   query: `SELECT * FROM fwAPI_FULFILLMENTS WHERE FulfillmentAccountID=${accountId} AND FulfillmentAppName = 'excel' AND FulfillmentSubmitted=1 AND FulfillmentDeleted=0 AND FulfillmentPO IN ('${orderIds.join("', '")}') ORDER BY FulfillmentID DESC`,
    // };

    const selectPayload = {
      query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE FulfillmentAccountID=${accountId} AND FulfillmentDeleted=0 AND FulfillmentSubmitted=0 ORDER BY FulfillmentID DESC`,
    };

    const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(selectPayload);
    console.log(selectData);

    // // If selectData.data is empty, skip checking and directly call the API with the orderIds
    // if (!selectData || !selectData.data || selectData.data.length === 0) {
    //   return callApiWithMissingOrders(orderIds, platformName, res);
    // }

    // Parse FulfillmentData and collect order_po values
    const orderPos = selectData.data.map((row) => {
      const fulfillmentData = urlDecodeJSON(row.FulfillmentData);
      const orderPo = fulfillmentData.order_po;

      // Remove 'WC_' from the order_po
      const orderPoNumber = orderPo.replace('WC_', '');

      return orderPoNumber; // Return only the number part of order_po
    });

    console.log("Extracted order_po values:", orderPos);

    // Compare the orderIds with the orderPos array to find missing order numbers
    const missingOrders = orderIds.filter(orderId => !orderPos.includes(orderId.replace('WC_', '')));

    console.log("Missing order numbers:", missingOrders);

    // If no missing orders, return a message saying they are already present
    if (missingOrders.length === 0) {
      return res.status(200).json({
        statusCode: 200,
        status: true,
        message: "All order numbers are already present",
      });
    }

    // Call the API with the missing orders
    return callApiWithMissingOrders(missingOrders, platformName, res);

  } catch (err) {
    console.error("Error while fetching order details", JSON.stringify(err), err);
    return res.status(400).json({
      statusCode: 400,
      status: false,
      message: "Error while fetching order details",
    });
  }
};

// // Helper function to call the API for missing orders
// const callApiWithMissingOrders = async (missingOrders, platformName, res) => {
//   try {
//     let allOrderDetails = [];

//     if (platformName === 'woocommerce') {
//       // Using async/await in the loop for WooCommerce
//       for (const order of missingOrders) {
//         try {
//           const response = await axios.post(
//             'https://artsafenet.com/wp-json/finerworks-media/v1/get-order-by-id',
//             { orderid: order }  // Pass the orderid with 'WC_' prefix
//           );
//           allOrderDetails.push(response.data);
//         } catch (error) {
//           allOrderDetails.push({ order, error: error.message });  // Handle errors for each failed order
//         }
//       }

//       return res.status(200).json({
//         statusCode: 200,
//         status: true,
//         message: "Fetched missing order details from WooCommerce",
//         orderDetails: allOrderDetails,  // Return the order details for missing orders
//       });
//     } else if (platformName === 'PlatformB') {
//       // Using async/await in the loop for PlatformB
//       for (const order of missingOrders) {
//         try {
//           const response = await axios.post(
//             'https://platformb.com/api/get-order-by-id',
//             { orderid: order }  // Assuming PlatformB uses order without the 'WC_' prefix
//           );
//           allOrderDetails.push(response.data);
//         } catch (error) {
//           allOrderDetails.push({ order, error: error.message });  // Handle errors for each failed order
//         }
//       }

//       return res.status(200).json({
//         statusCode: 200,
//         status: true,
//         message: `Fetched order details from ${platformName}`,
//         orderDetails: allOrderDetails,  // Return the order details for missing orders
//       });
//     } else {
//       return res.status(400).json({
//         statusCode: 400,
//         status: false,
//         message: "Platform not supported",
//       });
//     }
//   } catch (error) {
//     return res.status(500).json({
//       statusCode: 500,
//       status: false,
//       message: `Error fetching order details from ${platformName}`,
//     });
//   }
// };

const callApiWithMissingOrders = async (missingOrders, platformName, res) => {
  try {
    let allOrderDetails = [];

    if (platformName === 'woocommerce') {
      const wooCommerceUrl = process.env.FINERWORKS_WOOCOMMERCE_URL;
      if (!wooCommerceUrl) {
        return res.status(500).json({
          statusCode: 500,
          status: false,
          message: "WooCommerce URL is not configured in environment variables",
        });
      }

      for (const order of missingOrders) {
        try {
          const response = await axios.post(
            wooCommerceUrl + '/get-order-by-id',
            { orderid: order } // assuming order id includes 'WC_' prefix if required
          );
          allOrderDetails.push(response.data);
        } catch (error) {
          allOrderDetails.push({ order, error: error.message });
        }
      }

      return res.status(200).json({
        statusCode: 200,
        status: true,
        message: "Fetched missing order details from WooCommerce",
        orderDetails: allOrderDetails,
      });
    } else if (platformName === 'PlatformB') {
      for (const order of missingOrders) {
        try {
          const response = await axios.post(
            'https://platformb.com/api/get-order-by-id',
            { orderid: order }
          );
          allOrderDetails.push(response.data);
        } catch (error) {
          allOrderDetails.push({ order, error: error.message });
        }
      }

      return res.status(200).json({
        statusCode: 200,
        status: true,
        message: `Fetched order details from ${platformName}`,
        orderDetails: allOrderDetails,
      });
    } else {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Platform not supported",
      });
    }
  } catch (error) {
    return res.status(500).json({
      statusCode: 500,
      status: false,
      message: `Error fetching order details from ${platformName}`,
      error: error.message,
    });
  }
};




exports.softDeleteOrders = async (req, res) => {
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
    // console.log("selectData",selectData);
    // Extract FulfillmentID into a linear array


    if (!selectData || !selectData.data || !Array.isArray(selectData.data)) {
      log("No orders found for account ID:", accountId);
      return res.status(404).json({
        statusCode: 404,
        status: false,
        message: "No orders found for the provided account ID.",
      });
    }
    const fulfillmentIds = selectData.data.map((order) => order.FulfillmentID);

    console.log("Fulfillment IDs:", fulfillmentIds);
    // Process orders
    // Create an array of promises for updating the records
    const updatePromises = fulfillmentIds.map((fulfillmentId) => {
      const updatePayload = {
        tablename: process.env.FINER_fwAPI_FULFILLMENTS_TABLE,
        fieldupdates: `FulfillmentDeleted=1`,
        where: `FulfillmentID=${fulfillmentId}`,
      };

      return finerworksService.UPDATE_QUERY_FINERWORKS(updatePayload);
    });

    // Wait for all update operations to complete
    await Promise.all(updatePromises);

    res.status(200).json({
      statusCode: 200,
      status: true,
      message: "Orders deleted successfully.",
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



exports.disconnectAndProcess = async (req, res) => {
  try {
    const { client_id, platformName } = req.body;

    // Validate client_id
    if (!client_id) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "client_id is missing or invalid.",
      });
    }

    console.log("Received client_id:", client_id);

    let internalApiResponse;

    if (platformName === 'woocommerce') {
      const apiEndpoint = `${process.env.FINERWORKS_WOOCOMMERCE_URL}deauthorize`;
      console.log("apiEndpoint=============+>>>>>>",apiEndpoint);
      if (!apiEndpoint) {
        return res.status(500).json({
          statusCode: 500,
          status: false,
          message: "Deauthorize API endpoint is not configured in environment variables.",
        });
      }

      internalApiResponse = await axios.post(apiEndpoint, { client_id });

      const getInformation = await finerworksService.GET_INFO({ account_key: client_id });
      console.log("getInformation==============>>>>>>>>>>", getInformation);

      // Defensive check if connections exist
      const connections = getInformation?.user_account?.connections || [];

      // Filter out objects with name === "WooCommerce"
      const filteredConnections = connections.filter(conn => conn.name !== "WooCommerce");

      console.log("Filtered connections:", filteredConnections);
      const payloadForCompanyInformation = {
        account_key: client_id,
        connections: filteredConnections,
      };

      console.log("payloadForCompanyInformation=========", payloadForCompanyInformation);
      await finerworksService.UPDATE_INFO(payloadForCompanyInformation);

    } else {
      // Handle other platformNames or return error if unsupported
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: `Unsupported platformName: ${platformName}`,
      });
    }

    if (internalApiResponse.status !== 200) {
      return res.status(500).json({
        statusCode: 500,
        status: false,
        message: "Failed to deauthorize client_id with internal API.",
      });
    }

    // Success
    return res.status(200).json({
      statusCode: 200,
      status: true,
      message: "Client successfully deauthorized.",
      data: internalApiResponse.data,
    });

  } catch (err) {
    console.error("Error while processing client_id:", err);

    return res.status(500).json({
      statusCode: 500,
      status: false,
      message: err?.response?.data?.message || "Internal server error. Please try again later.",
      error: err?.message || "Unknown error",
    });
  }
};

exports.disconnectProductsFromInventory = async (req, res) => {
  try {
    const { platform, account_key } = req.body;

    // Validate input
    if (!platform || typeof platform !== 'string') {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Platform is missing or invalid.",
      });
    }

    if (!account_key || typeof account_key !== 'string') {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Account key is missing or invalid.",
      });
    }

    console.log(`[Disconnect] Platform: ${platform}, Account Key: ${account_key}`);

    switch (platform.toLowerCase()) {
      case "woocommerce":
        console.log(`[Disconnect] Processing WooCommerce products for account: ${account_key}`);

        // Pass both platform and account_key to the disconnect API
        await finerworksService.DISCONNECT_VIRTUAL_INVENTORY({ 
          platform, 
          account_key 
        });
        return res.status(200).json({
          statusCode: 200,
          status: true,
          message: "WooCommerce products disconnected from inventory successfully.",
        });

      case "shopify":
        console.log(`[Disconnect] Processing Shopify products for account: ${account_key}`);

        // Pass both platform and account_key here too if applicable
        await finerworksService.DISCONNECT_VIRTUAL_INVENTORY({ 
          platform, 
          account_key 
        });

        return res.status(200).json({
          statusCode: 200,
          status: true,
          message: "Shopify products disconnected from inventory successfully.",
        });

      default:
        return res.status(400).json({
          statusCode: 400,
          status: false,
          message: `Unsupported platform: ${platform}`,
        });
    }
  } catch (err) {
    console.error("[Disconnect] Error while disconnecting products:", err);

    return res.status(500).json({
      statusCode: 500,
      status: false,
      message: err?.response?.data?.message || "Internal server error. Please try again later.",
      error: err?.message || "Unknown error",
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
