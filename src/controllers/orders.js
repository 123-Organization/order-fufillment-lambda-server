const createEvent = require("../helpers/create-event");
const finerworksService = require("../helpers/finerworks-service");
const debug = require("debug");
const log = debug("app:uploadOrders");
const Joi = require("joi");
const { validateOrderPayload } = require("./validate-order");
const { v4: uuidv4 } = require('uuid'); // Import uuid library for UUID generation

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

    const { accountId, page, limit } = req.body;

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
      query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE FulfillmentAccountID=${accountId} AND FulfillmentDeleted=0 AND FulfillmentSubmitted=0 ORDER BY FulfillmentID DESC`,
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
    allOrders.sort((a, b) => {
      const numA = parseInt(a.order_po.replace(/\D/g, ""), 10);
      const numB = parseInt(b.order_po.replace(/\D/g, ""), 10);
      return numA - numB;
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
    // console.log("selectData=====>>>>>", selectData);

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
    const { skuCode, productCode, fromTheInventory, account_key, product_guid } = reqBody;
    const searchListVirtualInventoryParams = {};
    if (skuCode != "") {
      searchListVirtualInventoryParams.sku_filter = [skuCode];
    }
    if (productCode != "") {
      searchListVirtualInventoryParams.product_code_filter = [productCode];
    }
    if (account_key) {
      searchListVirtualInventoryParams.account_key = account_key;
    }
    log(
      "Request come to search product from virtual inventory for the payload",
      JSON.stringify(searchListVirtualInventoryParams)
    );
    console.log("okkkkkkkkkkkkkkkkkkkkkkkkkk")
    if (skuCode || fromTheInventory) {
      console.log("selectData============", selectData);
      const orderDetail = urlDecodeJSON(selectData.data[0].FulfillmentData);
      console.log("orderDetail", orderDetail);
      const orderFound = orderDetail.order_items.filter((item) => {
        return item.product_sku === skuCode
      })
      console.log("orderFound======>>>>", orderFound);
      if (orderFound.length > 0) {
        return res.status(200).json({
          statusCode: 200,
          status: true,
          message: "SKU Code is already there",
        });
      }
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
      console.log("getProductDetails", getProductDetails);
      if (getProductDetails?.status?.success) {
        let products = skuCode
          ? getProductDetails.products
          : getProductDetails.product_list;
        const previousOrder = urlDecodeJSON(orderDetails.FulfillmentData);
        const orderData = reqBody.product_url_file.map((url, index) => ({
          product_qty: products?.[0]?.quantity ?? null,
          product_sku: products?.[0]?.sku ? products?.[0]?.sku : products?.[0]?.product_code,
          product_title: products?.[0]?.name ?? null,
          product_guid: product_guid?product_guid:generateGUID(),
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


exports.updateOrderByValidProductSkuCode = async (req, res) => {
  try {
    const reqBody = JSON.parse(JSON.stringify(req.body));
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
      query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE  FulfillmentID=${reqBody.orderFullFillmentId} AND FulfillmentAccountID=${reqBody.accountId}`,
    };
    console.log("selectPayload=====>>>>>", selectPayload);
    log("Select query to fetch the orders", JSON.stringify(selectPayload));
    const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(
      selectPayload
    );

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
    const { skuCode, productCode, fromTheInventory, account_key, toReplace } = reqBody;
    const searchListVirtualInventoryParams = {};
    if (skuCode != "") {
      searchListVirtualInventoryParams.sku_filter = [skuCode];
    }
    if (productCode != "") {
      searchListVirtualInventoryParams.product_code_filter = [productCode];
    }
    if (account_key) {
      searchListVirtualInventoryParams.account_key = account_key;
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
        console.log(previousOrder, "previousOrder")
        const updatedOrder = updateOrderItems(previousOrder, orderData, toReplace);

        console.log("updatedOrder", updatedOrder);
        // previousOrder.order_items.push(orderData);
        const urlEncodedData = urlEncodeJSON(updatedOrder);
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
      console.log("getProductDetails", getProductDetails);
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

        // if (previousOrder?.order_items) {
        //   orderData.forEach((item, index) => {
        //     previousOrder.order_items.push(item);
        //   })
        // }
        // log("Previous order is", JSON.stringify(previousOrder));
        // update order

        console.log("orderData====>>>>", orderData);
        console.log(previousOrder, "previousOrder");
        const updatedOrder = updateOrderItemsV2(previousOrder, orderData, toReplace);
        console.log("updatedOrder======>>>>>>", updatedOrder);
        const urlEncodedData = urlEncodeJSON(updatedOrder);
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
// exports.deleteOrder = async (req, res) => {
//   try {
//     const reqBody = JSON.parse(JSON.stringify(req.body));
//     if (!reqBody.accountId || !reqBody.orderFullFillmentId) {
//       res.status(400).json({
//         statusCode: 400,
//         status: false,
//         message: "Account Id and order fullfillment Id are required.",
//       });
//     } else {
//       const { orderFullFillmentId, accountId } = reqBody;
//       log("Request comes to delete order for", JSON.stringify(reqBody));
//       const selectPayload = {
//         query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE FulfillmentID=${orderFullFillmentId} AND FulfillmentAccountID = ${accountId}`,
//       };
//       const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(
//         selectPayload
//       );
//       if (selectData?.data.length) {
//         const orderDetails = selectData?.data[0];
//         if (orderDetails.FulfillmentDeleted) {
//           res.status(400).json({
//             statusCode: 400,
//             status: false,
//             message: "This order has already deleted.",
//           });
//         } else {
//           const updatePayload = {
//             tablename: process.env.FINER_fwAPI_FULFILLMENTS_TABLE,
//             fieldupdates: `FulfillmentDeleted=1`,
//             where: `FulfillmentID=${orderFullFillmentId}`,
//           };
//           const updateQueryExecute =
//             await finerworksService.UPDATE_QUERY_FINERWORKS(updatePayload);
//           if (updateQueryExecute) {
//             log(
//               "Order has been successfully deleted for",
//               JSON.stringify(reqBody)
//             );
//             res.status(200).json({
//               statusCode: 200,
//               status: true,
//               message: `Order with fulfillment ID ${orderFullFillmentId} has been successfully deleted.`,
//             });
//           } else {
//             res.status(400).json({
//               statusCode: 400,
//               status: true,
//               message: `Something went wrong while deleting the order of fulfillment ID ${orderFullFillmentId}`,
//             });
//           }
//         }
//       }
//     }
//   } catch (err) {
//     log("Error comes while creating a new order", JSON.stringify(err), err);
//     const errorMessage = err.response.data;
//     res.status(400).json({
//       statusCode: 400,
//       status: false,
//       message: errorMessage,
//     });
//   }
// };


exports.deleteOrder = async (req, res) => {
  try {
    const reqBody = JSON.parse(JSON.stringify(req.body));
    const { accountId, orderFullFillmentId } = reqBody;

    // Check if accountId and orderFullFillmentIds are provided
    if (!accountId || !Array.isArray(orderFullFillmentId) || orderFullFillmentId.length === 0) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Account Id and order fullfillment IDs are required, and IDs must be an array.",
      });
    }

    // Log the request body
    log("Request comes to delete orders for", JSON.stringify(reqBody));

    // Build the query with multiple IDs
    const orderFullFillmentIdsStr = orderFullFillmentId.join(",");  // Convert array to a comma-separated string
    const selectPayload = {
      query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE FulfillmentID IN (${orderFullFillmentIdsStr}) AND FulfillmentAccountID = ${accountId} AND FulfillmentDeleted=0`,
    };

    // Fetch orders
    const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(selectPayload);

    if (selectData?.data.length === 0) {
      return res.status(404).json({
        statusCode: 404,
        status: false,
        message: "No orders found with the provided IDs.",
      });
    }
    console.log("selectData===", selectData);


    // Collect promises for deletion
    const deletionPromises = selectData.data.map(async (orderDetails) => {
      if (orderDetails.FulfillmentDeleted) {
        throw new Error(`Order with Fulfillment ID ${orderDetails.FulfillmentID} has already been deleted.`);
      } else {
        const updatePayload = {
          tablename: process.env.FINER_fwAPI_FULFILLMENTS_TABLE,
          fieldupdates: `FulfillmentDeleted=1`,
          where: `FulfillmentID=${orderDetails.FulfillmentID}`,
        };

        const updateQueryExecute = await finerworksService.UPDATE_QUERY_FINERWORKS(updatePayload);

        if (!updateQueryExecute) {
          throw new Error(`Something went wrong while deleting the order with Fulfillment ID ${orderDetails.FulfillmentID}`);
        }
      }
    });

    // Execute all deletion promises concurrently
    await Promise.all(deletionPromises);

    // Success response after deleting all valid orders
    log("Orders have been successfully deleted for", JSON.stringify(reqBody));
    res.status(200).json({
      statusCode: 200,
      status: true,
      message: `Orders with Fulfillment IDs [${orderFullFillmentIdsStr}] have been successfully deleted.`,
    });

  } catch (err) {
    log("Error occurred while deleting orders", JSON.stringify(err), err);
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: err.message || "Unknown error",
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
    const { accountId, payment_token, account_key } = reqBody;
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
        account_key: account_key
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


exports.submitOrdersV2 = async (req, res) => {
  try {
    const reqBody = JSON.parse(JSON.stringify(req.body));
    if (!reqBody?.orders || !reqBody?.payment_token || !reqBody?.accountId || !reqBody?.account_key) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Bad Request.",
      });
    }
    const { accountId, payment_token, account_key } = reqBody;
    const ordersToBeSubmitted = reqBody.orders;
    const ordersToBeSubmittedv2 = JSON.parse(JSON.stringify(reqBody.orders));
    console.log("ordersToBeSubmitted=========>>>>", ordersToBeSubmitted);
    if (ordersToBeSubmitted.length > 0) {
      console.log("got theentryyyyyyyyyyyyyyy")
      let orderFulfillmentIds = [];
      let finalResults = [];
      const finalOrders = ordersToBeSubmitted.map((order) => {
        console.log("order==========", order);
        if (!order.orderFullFillmentId) {
          throw new Error("Bad request: Missing orderFullFillmentId");
        }
        orderFulfillmentIds.push(order.orderFullFillmentId);
        console.log("orderFulfillmentIds=========>>>>>", orderFulfillmentIds);
        console.log("herererererererererererererererere");
        // const orderData = urlDecodeJSON(order);
        // console.log("orderData=============>>>>>>>>>>>>>",orderData);
        delete order.orderFullFillmentId;
        delete order.createdAt;
        delete order.submittedAt;

        return order;
      });
      // Create a final payload to submit the order in finerworks
      const finalPayload = {
        orders: finalOrders,
        validate_only: false,
        payment_token,
        account_key: account_key,
        accountId: accountId
      };
      console.log("finalPayload========><.>>>>><><><><>", finalPayload);
      // return  res.status(200).json({
      //   statusCode: 200,
      //   status: true,
      //   data:finalPayload
      //   // message: errorMessage,
      // });
      log("Submit order in finerwork database", JSON.stringify(finalPayload));
      const submitData = await finerworksService.SUBMIT_ORDERS(finalPayload);
      console.log("submitData==============>>>>>>>>>", submitData);
      console.log("orderFulfillmentIds==============>>>>>>>>>", orderFulfillmentIds);


      log(
        "Response after submitted to the final database",
        JSON.stringify(submitData)
      );
      // once it gets submitted Now update each order fulfillment Id with submitted status & submitted at time
      if (orderFulfillmentIds.length > 0) {
        console.log(" enter the iffffffff")
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
            console.log("updatePayload================", updatePayload);

            const finalResultv2 = await finerworksService.UPDATE_QUERY_FINERWORKS(updatePayload);
            finalResults.push(finalResultv2);
          })
        );
        // Find the order based on order_po in ordersToBeSubmitted
        const updatedOrders = submitData.orders.map(order => {
          // Find all matching orders in ordersToBeSubmitted using filter
          const orderDetailsArray = ordersToBeSubmittedv2.filter(o => o.order_po === order.order_po);

          if (orderDetailsArray.length > 0) {
            // Assuming you want to use the first match
            const orderDetails = orderDetailsArray[0];

            console.log('Found order details:', orderDetails); // Log the found order to check if it's matching
            console.log('orderFullFillmentId:', orderDetails.orderFullFillmentId); // Check if orderFullFillmentId exists

            // Create the new payload
            return {
              order_po: order.order_po,
              order_id: order.order_id,
              order_confirmation_id: order.order_confirmation_id,
              orderFullFillmentId: orderDetails.orderFullFillmentId,
              datetime: order.order_confirmation_datetime
            };
          } else {
            console.log('Order not found for order_po:', order.order_po); // Log if order_po is not found
          }

          return null;
        }).filter(Boolean); // Remove null entries (if any)

        return res.status(200).json({
          statusCode: 200,
          status: true,
          data: updatedOrders,
          message: "orders placed properly",
        });
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
// exports.orderSubmitStatus = async (req, res) => {
//   try {
//     const reqBody = JSON.parse(JSON.stringify(req.body));
//     if (!reqBody.accountId || !reqBody.orderFullFillmentId) {
//       res.status(400).json({
//         statusCode: 400,
//         status: false,
//         message: "Account Id and order fullfillment Id are required.",
//       });
//     } else {
//       const { orderFullFillmentId, accountId, account_key, orderId } = reqBody;
//       log("Request comes to delete order for", JSON.stringify(reqBody));

//       const selectPayload = {
//         query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE FulfillmentID=${orderFullFillmentId} AND FulfillmentAccountID = ${accountId}`,
//       };
//       const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(
//         selectPayload
//       );
//       const selectOrderId = {
//         "order_ids": [
//           orderId
//         ],
//         "account_key": account_key
//       }
//       console.log("selectOrderId=================>>>>>>>>>>>", selectOrderId);
//       const orderStatusData = await finerworksService.GET_ORDER_STATUS(
//         selectOrderId
//       );
//       console.log("orderStatusData===============", orderStatusData);
//       if (selectData?.data.length) {
//         const orderDetails = selectData?.data[0];
//         const orderDetail = urlDecodeJSON(orderDetails.FulfillmentData);
//         if (orderDetails.FulfillmentDeleted) {
//           res.status(400).json({
//             statusCode: 400,
//             status: false,
//             message: "This is a deleted order.",
//           });
//         } else if (orderDetails.FulfillmentSubmitted) {
//           log(
//             "Order has been successfully deleted for",
//             JSON.stringify(reqBody)
//           );
//           res.status(200).json({
//             statusCode: 200,
//             status: true,
//             createdAt: orderDetail?.createdAt ?? "N/A",
//             submittedAt: orderDetail?.submittedAt ?? "N/A",
//             orderStatus: true,
//           });
//         } else {
//           res.status(200).json({
//             statusCode: 200,
//             status: true,
//             createdAt: orderDetail?.createdAt,
//             submittedAt: orderDetail?.submittedAt ?? "N/A",
//             orderStatus: false,
//           });
//         }
//       }
//     }
//   } catch (err) {
//     log("Error comes while creating a new order", JSON.stringify(err), err);
//     const errorMessage = err;
//     res.status(400).json({
//       statusCode: 400,
//       status: false,
//       message: errorMessage,
//     });
//   }
// };

exports.orderSubmitStatus = async (req, res) => {
  try {
    const reqBody = JSON.parse(JSON.stringify(req.body));
    if (!reqBody.accountId || !reqBody.account_key || !reqBody.orderId) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Account Id and order fullfillment Id are required.",
      });
    } else {
      const { orderFullFillmentId, accountId, account_key, orderId } = reqBody;
      log("Request comes to delete order for", JSON.stringify(reqBody));

      // const selectPayload = {
      //   query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE FulfillmentID=${orderFullFillmentId} AND FulfillmentAccountID = ${accountId}`,
      // };
      // const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(
      //   selectPayload
      // );
      const selectOrderId = {
        "order_ids": [
          orderId
        ],
        "account_key": account_key
      }
      console.log("selectOrderId=================>>>>>>>>>>>", selectOrderId);
      const orderStatusData = await finerworksService.GET_ORDER_STATUS(
        selectOrderId
      );
      console.log("orderStatusData===============", orderStatusData);
      if (orderStatusData) {
        res.status(200).json({
          statusCode: 200,
          status: true,
          data: orderStatusData
        });
      }
    }
  } catch (err) {
    log("Error comes while creating a new order", JSON.stringify(err), err);
    const errorMessage = err;
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
    const { orderIds, accountId, domainName } = reqBody;

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
      console.log("orderPo", orderPo)

      const orderPoNumber = typeof orderPo === 'string' && orderPo.startsWith('WC_')
        ? orderPo.slice(3)  // Removes 'WC_' (3 characters)
        : orderPo;

      return orderPoNumber; // Return the processed order_po/ Return only the number part of order_po
    });

    console.log("Extracted order_po values:", orderPos);

    // Compare the orderIds with the orderPos array to find missing order numbers
    const missingOrders = orderIds.filter(orderId => !orderPos.includes(orderId.replace('WC_', '')));

    console.log("Missing order numbers:", missingOrders);
    // return

    // If no missing orders, return a message saying they are already present
    if (missingOrders.length === 0) {
      return res.status(200).json({
        statusCode: 200,
        status: true,
        message: "All order numbers are already present",
      });
    }

    // Call the API with the missing orders
    return callApiWithMissingOrders(missingOrders, platformName, res, domainName);

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

const callApiWithMissingOrders = async (missingOrders, platformName, res, domainName) => {
  try {
    let allOrderDetails = [];

    if (platformName === 'woocommerce') {
      // const wooCommerceUrl = process.env.FINERWORKS_WOOCOMMERCE_URL;
      // const apiEndpoint = `https://${domainName}/wp-json/finerworks-media/v1/deauthorize`;
      // console.log("wooCommerceUrl===========", wooCommerceUrl);
      // if (!wooCommerceUrl) {
      //   return res.status(500).json({
      //     statusCode: 500,
      //     status: false,
      //     message: "WooCommerce URL is not configured in environment variables",
      //   });
      // }
      console.log("hererererererererererrrrrrrrrrrrrrrrrr", domainName);
      for (const order of missingOrders) {
        console.log("order======", order);
        try {
          const response = await axios.post(
            `https://${domainName}/wp-json/finerworks-media/v1/get-order-by-id?orderid=${order}`
          );

          console.log("response=======>>>>>", response);
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
        fieldupdates: `FulfillmentDeleted=0`,
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



// exports.disconnectAndProcess = async (req, res) => {
//   try {
//     const { client_id, platformName } = req.body;

//     // Validate client_id
//     if (!client_id) {
//       return res.status(400).json({
//         statusCode: 400,
//         status: false,
//         message: "client_id is missing or invalid.",
//       });
//     }

//     console.log("Received client_id:", client_id);

//     let internalApiResponse;

//     if (platformName === 'woocommerce') {
//       const apiEndpoint = `${process.env.FINERWORKS_WOOCOMMERCE_URL}deauthorize`;
//       console.log("apiEndpoint=============+>>>>>>", apiEndpoint);
//       if (!apiEndpoint) {
//         return res.status(500).json({
//           statusCode: 500,
//           status: false,
//           message: "Deauthorize API endpoint is not configured in environment variables.",
//         });
//       }

//       internalApiResponse = await axios.post(apiEndpoint, { client_id });

//       const getInformation = await finerworksService.GET_INFO({ account_key: client_id });
//       console.log("getInformation==============>>>>>>>>>>", getInformation);

//       // Defensive check if connections exist
//       const connections = getInformation?.user_account?.connections || [];

//       // Filter out objects with name === "WooCommerce"
//       const filteredConnections = connections.filter(conn => conn.name !== "WooCommerce");

//       console.log("Filtered connections:", filteredConnections);
//       const payloadForCompanyInformation = {
//         account_key: client_id,
//         connections: filteredConnections,
//       };

//       console.log("payloadForCompanyInformation=========", payloadForCompanyInformation);
//       await finerworksService.UPDATE_INFO(payloadForCompanyInformation);

//     } else {
//       // Handle other platformNames or return error if unsupported
//       return res.status(400).json({
//         statusCode: 400,
//         status: false,
//         message: `Unsupported platformName: ${platformName}`,
//       });
//     }

//     if (internalApiResponse.status !== 200) {
//       return res.status(500).json({
//         statusCode: 500,
//         status: false,
//         message: "Failed to deauthorize client_id with internal API.",
//       });
//     }

//     // Success
//     return res.status(200).json({
//       statusCode: 200,
//       status: true,
//       message: "Client successfully deauthorized.",
//       data: internalApiResponse.data,
//     });

//   } catch (err) {
//     console.error("Error while processing client_id:", err);

//     return res.status(500).json({
//       statusCode: 500,
//       status: false,
//       message: err?.response?.data?.message || "Internal server error. Please try again later.",
//       error: err?.message || "Unknown error",
//     });
//   }
// };



exports.disconnectAndProcess = async (req, res) => {
  try {
    const { client_id, platformName, domainName } = req.body;

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
      const apiEndpoint = `https://${domainName}/wp-json/finerworks-media/v1/deauthorize?client_id=${client_id}`;
      console.log("apiEndpoint=============+>>>>>>", apiEndpoint);

      if (!apiEndpoint) {
        return res.status(500).json({
          statusCode: 500,
          status: false,
          message: "Deauthorize API endpoint is not configured in environment variables.",
        });
      }

      internalApiResponse = await axios.post(apiEndpoint);
      console.log("internalApiResponse=========>>>>>>", internalApiResponse);

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

exports.connectAndProcess = async (req, res) => {
  try {
    const { clientId, platformName, account_key } = req.body;
    console.log("Received body:", req.body, clientId);

    // Validate client_id
    if (!clientId) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "client_id is missing or invalid.",
      });
    }

    console.log("Received client_id:", clientId);

    let internalApiResponse;

    // Get information from the finerworks service
    const getInformation = await finerworksService.GET_INFO({ account_key: account_key });
    console.log("Fetched Information from Finerworks:", getInformation);

    // Defensive check if connections exist
    let connections = JSON.parse(JSON.stringify(getInformation?.user_account?.connections)) || [];
    // console.log("Connections Array:", connections);
    // const dataTemp=JSON.parse(JSON.stringify(connections.data));
    // console.log("dataTemp:", dataTemp);


    // Creating the payload object to be added to connections
    const payload = {
      name: req.body.name,
      id: req.body.id,
      data: JSON.stringify({
        clientId: req.body.clientId,
        account_key: req.body.account_key,
        isConnected: req.body.isConnected,
      }), // Data as stringified JSON
    };

    // If the connections array is empty, directly add the payload
    if (connections.length === 0) {
      connections = [payload]; // Assign the payload to the connections array
      console.log("Connections array is empty. Added payload:", connections);
    } else {
      // If the connection exists, update the array
      const filteredConnections = connections.filter(conn => conn.name === req.body.name);
      console.log("Filtered Connections:", filteredConnections);

      if (filteredConnections.length > 0) {
        // Update the existing connection by merging with the payload
        const payloadForCompanyInformation = {
          account_key: account_key,
          // connections:[]
          connections: connections.map(conn => {
            if (conn.name === req.body.name) {
              return { ...conn, ...payload }; // Merge the existing connection with the new payload
            }
            return conn;
          }),
        };
        console.log("Updated payloadForCompanyInformation (Connection Exists):", payloadForCompanyInformation);
        await finerworksService.UPDATE_INFO(payloadForCompanyInformation);

        return res.status(200).json({
          statusCode: 200,
          status: true,
          message: `Connection established`,
        });
      } else {
        // If no connection exists, just add the payload
        connections.push(payload);
        console.log("Added new connection:", connections);
      }
    }

    // Final payload to update the connections
    const payloadForCompanyInformation = {
      account_key: account_key,
      connections: connections,
    };

    console.log("payloadForCompanyInformation=============>>>>>>>>>>>", payloadForCompanyInformation);

    // Update the connections with the payload
    await finerworksService.UPDATE_INFO(payloadForCompanyInformation);

    return res.status(200).json({
      statusCode: 200,
      status: true,
      message: "Connection added successfully",
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


exports.connectAndProcessOfa = async (req, res) => {
  try {
    const { domainName, account_key } = req.body;
    console.log("Received body:", req.body);

    // Validate domainName and account_key
    if (!domainName || !account_key) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "domainName or account_key is missing or invalid.",
      });
    }

    console.log("Received account_key:", account_key);

    const auth_code = uuidv4(); // Generates a UUID (v4) like 42dd816a-8107-4742-8c1b-a46067fc30c8

    // Concatenate domainName and auth_code to form the ID
    const id = `${domainName}?${auth_code}`;

    // Final payload to update the connections
    const payloadForCompanyInformation = {
      account_key: account_key,
      connections: [{
        data: "",
        name: "WooCommerce",
        id: id
      }],
    };
    console.log("payloadForCompanyInformation==========>>>>>>>>>>>", payloadForCompanyInformation);
    await finerworksService.UPDATE_INFO(payloadForCompanyInformation);

    const getInformation = await finerworksService.GET_INFO({ account_key: account_key });
    console.log("Fetched Information from Finerworks:", getInformation);
    // return res.status(200).json({
    //   statusCode: 200,
    //   status: false,
    //   message: "Authentication failed with the external service.",
    //   data:getInformation
    // });

    // Use getInformation.user_account for internal API payload
    const internalApiPayload = {
      user_account: getInformation.user_account // Pass user_account from the fetched information
    };

    // Make the API request to the external API using account_key
    const externalApiUrl = `https://${domainName}/wp-json/finerworks-media/v1/authenticate-test`;
    console.log("externalApiUrl========>>>>", externalApiUrl);

    const externalApiResponse = await axios.post(externalApiUrl, internalApiPayload); // Pass internalApiPayload here
    console.log("externalApiResponse========>>>>", externalApiResponse);




    if (externalApiResponse.data.status !== 'success') {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Authentication failed with the external service.",
      });
    }
    let connections = JSON.parse(JSON.stringify(getInformation?.user_account?.connections)) || [];

    const payload = {
      name: 'WooCommerce',
      id: id,
      data: JSON.stringify({
        clientId: getInformation?.user_account?.account_id,
        account_key: account_key,
        isConnected: true,
      }), // Data as stringified JSON
    };

    // If the connections array is empty, directly add the payload
    if (connections.length === 0) {
      connections = [payload]; // Assign the payload to the connections array
      console.log("Connections array is empty. Added payload:", connections);
    } else {
      // If the connection exists, update the array
      const filteredConnections = connections.filter(conn => conn.name === 'WooCommerce');
      console.log("Filtered Connections:", filteredConnections);

      if (filteredConnections.length > 0) {
        // Update the existing connection by merging with the payload
        const payloadForCompanyInformation = {
          account_key: account_key,
          // connections:[]
          connections: connections.map(conn => {
            if (conn.name === 'WooCommerce') {
              return { ...conn, ...payload }; // Merge the existing connection with the new payload
            }
            return conn;
          }),
        };
        console.log("Updated payloadForCompanyInformation (Connection Exists):", payloadForCompanyInformation);
        await finerworksService.UPDATE_INFO(payloadForCompanyInformation);

        return res.status(200).json({
          statusCode: 200,
          status: true,
          message: `Connection established`,
        });
      } else {
        // If no connection exists, just add the payload
        connections.push(payload);
        console.log("Added new connection:", connections);
      }
    }

  } catch (err) {
    console.error("Error while processing request:", err);

    return res.status(500).json({
      statusCode: 500,
      status: false,
      message: err?.response?.data?.message || "Internal server error. Please try again later.",
      error: err?.message || "Unknown error",
    });
  }
};


exports.checkDomain = async (req, res) => {
  try {
    const { domainName } = req.body;
    console.log("Received body:", req.body);

    // Validate domainName and account_key
    if (!domainName) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "domainName  is missing or invalid.",
      });
    }



    // Make the API request to the external API using account_key
    const externalApiUrl = `https://${domainName}/wp-json/finerworks-media/v1/check-domain?domain=${domainName}`;
    console.log("externalApiUrl========>>>>", externalApiUrl);

    const externalApiResponse = await axios.post(externalApiUrl);
    console.log("externalApiResponse========>>>>", externalApiResponse.data);



    if (externalApiResponse.data.status !== 'success') {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Authentication failed with the external service.",
      });
    }

    // Proceed with your processing here after successful authentication
    // For example, you can process domainName and account_key further

    return res.status(200).json({
      statusCode: 200,
      status: true,
      message: "Success, processed request and authenticated successfully.",
      data: externalApiResponse.data, // You can return the response from the external API if needed
    });

  } catch (err) {
    console.error("Error while processing request:", err);

    return res.status(500).json({
      statusCode: 500,
      status: false,
      message: err?.response?.data?.message || "Internal server error. Please try again later.",
      error: err?.message || "Unknown error",
    });
  }
};


exports.sendOrderDetails = async (req, res) => {
  try {
    const { account_key, orders, domainName } = req.body;
    console.log("Received body:", req.body);

    // Validate domainName and account_key
    if (!account_key) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "account_key  is missing or invalid.",
      });
    }



    // Prepare the data for the internal API call
    const updateOrdersApiUrl = `https://${domainName}/wp-json/finerworks-media/v1/update-orders-meta`;
    console.log("updateOrdersApiUrl====>>>", updateOrdersApiUrl);
    const dataToSend = {
      client_id: account_key,  // Use the account_key as the client_id
      orders: orders,  // Use the orders from the request body
    };

    console.log("Sending orders to internal API:", dataToSend);

    // Make the internal API call to update orders
    const updateOrdersResponse = await axios.post(updateOrdersApiUrl, dataToSend);
    console.log("updateOrdersResponse========>>>>", updateOrdersResponse.data);

    // If the API response is successful, send the response back to the client
    console.log("sdfgfdsdfgfd", updateOrdersResponse.success)
    if (updateOrdersResponse.data.success == true) {
      return res.status(200).json({
        statusCode: 200,
        status: true,
        message: "Orders processed and updated successfully.",
        data: updateOrdersResponse.data, // Return the response from the internal API
      });
    } else {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Failed to update orders with the external service.",
      });
    }

  } catch (err) {
    console.error("Error while processing request:", err);

    return res.status(500).json({
      statusCode: 500,
      status: false,
      message: err?.response?.data?.message || "Internal server error. Please try again later.",
      error: err?.message || "Unknown error",
    });
  }
};

exports.updateOrderItemImage = async (req, res) => {
  try {
    const reqBody = JSON.parse(JSON.stringify(req.body));
    var getProductDetails

    if (!reqBody.orderFullFillmentId) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Orderfullfillment Id is required.",
      });
    }
    if (!reqBody.product_sku) {
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
      query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE  FulfillmentID=${reqBody.orderFullFillmentId} AND FulfillmentAccountID=${reqBody.accountId}`,
    };
    console.log("selectPayload=====>>>>>", selectPayload);
    log("Select query to fetch the orders", JSON.stringify(selectPayload));
    const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(
      selectPayload
    );
        console.log("selectData========>>>>>>>>", selectData.data[0]);

    const CollectedorderDetails = selectData.data[0];
    const previousOrder = urlDecodeJSON(CollectedorderDetails.FulfillmentData);
    console.log("selectData========>>>>>>>>", previousOrder);
    previousOrder.order_items.forEach(item => {
      if (item.product_sku === reqBody.product_sku) {
        item.product_image = reqBody.product_image;
      }
    });
    console.log("previousOrder===============",previousOrder);

    const urlEncodedData = urlEncodeJSON(previousOrder);
    const updatePayload = {
      tablename: process.env.FINER_fwAPI_FULFILLMENTS_TABLE,
      fieldupdates: `FulfillmentData='${urlEncodedData}'`,
      where: `FulfillmentID=${reqBody.orderFullFillmentId}`,
    };
    const updateQueryExecute =
      await finerworksService.UPDATE_QUERY_FINERWORKS(updatePayload);

    return res.status(200).json({
      statusCode: 200,
      status: true,
      message: "Order item image updated successfully.",
      data: previousOrder
    });
   

  } catch (err) {
    const errorMessage = err.response.data;
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: errorMessage,
    });
  }
};




exports.testAccountKey = async (req, res) => {
  try {
    const { account_key, domainName } = req.body;
    console.log("Received body:", req.body);

    // Validate client_id
    if (!account_key && domainName) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "account_key is missing",
      });
    }
    // Generate a unique auth code (e.g., using crypto)
    const auth_code = uuidv4(); // Generates a UUID (v4) like 42dd816a-8107-4742-8c1b-a46067fc30c8

    // Concatenate domainName and auth_code to form the ID
    const id = `${domainName}?${auth_code}`;

    // Final payload to update the connections
    const payloadForCompanyInformation = {
      account_key: account_key,
      connections: [{
        data: "",
        name: "WooCommerce",
        id: id
      }],
    };

    const getInformationv2 = await finerworksService.GET_INFO({ account_key: account_key });
    console.log("Fetched Information from Finerworks:", getInformationv2);

    let connections = JSON.parse(JSON.stringify(getInformationv2?.user_account?.connections)) || [];

    const filteredConnections = connections.filter(conn => conn.name === 'WooCommerce');
    console.log("Filtered Connections:", filteredConnections);
    if (filteredConnections.length > 0) {

      const connection = filteredConnections[0]; // Assuming only one item in the array
      const domainExist = connection.id.split('?')[0]; // Splitting to get the domain
      const isConnected = JSON.parse(connection.data)?.isConnected ?? false; // Using optional chaining and nullish coalescing to handle missing key

      console.log('Domain:', domainExist); // Output: finerworks1.instawp.site
      console.log('isConnected:', isConnected);
      console.log('connection:', connection); // Output: true
      // Output: true
      if (isConnected && connection) {
        if (domainExist && domainExist !== domainName) {
          return res.status(400).json({
            statusCode: 400,
            status: false,
            message: "Already associated with other domain",
          });
        }
      }
    }

    console.log("payloadForCompanyInformation=============>>>>>>>>>>>", payloadForCompanyInformation);
    // Update the connections with the payload
    await finerworksService.UPDATE_INFO(payloadForCompanyInformation);

    const getInformation = await finerworksService.GET_INFO({ account_key: account_key });
    console.log("Fetched Information from Finerworks:", getInformation);
    return res.status(200).json({
      statusCode: 200,
      status: true,
      message: "User details found",
      data: getInformation

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

function updateOrderItems(previousOrder, orderData, toReplace) {
  // Make a copy of previousOrder to ensure it remains unchanged
  const updatedOrder = JSON.parse(JSON.stringify(previousOrder));

  // Flag to check if a match is found
  let matchFound = false;

  // Loop through the order items to find and replace the matched SKU with toReplace
  updatedOrder.order_items = updatedOrder.order_items.filter(item => {
    if (item.product_sku === toReplace) {
      matchFound = true; // Set flag to true if match is found
      return false; // Remove the matched item from the array
    }
    return true;
  });

  // If a match was found, add the new orderData to the order_items array
  if (matchFound) {
    updatedOrder.order_items.push(orderData);
  }

  return updatedOrder;
}

function updateOrderItemsV2(previousOrder, orderData, toReplace) {
  // Make a copy of previousOrder to ensure it remains unchanged
  const updatedOrder = JSON.parse(JSON.stringify(previousOrder));

  // Flag to check if a match is found
  let matchFound = false;

  // Loop through the order items to find and replace the matched SKU with toReplace
  updatedOrder.order_items = updatedOrder.order_items.filter(item => {
    if (item.product_sku === toReplace) {
      matchFound = true; // Set flag to true if match is found
      return false; // Remove the matched item from the array
    }
    return true;
  });

  // If a match was found, add the new orderData to the order_items array
  if (matchFound) {
    // Check if orderData is an array, and add all its items to order_items
    if (Array.isArray(orderData)) {
      updatedOrder.order_items.push(...orderData);
    } else {
      updatedOrder.order_items.push(orderData);
    }
  }

  return updatedOrder;
}