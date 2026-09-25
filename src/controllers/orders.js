
const finerworksService = require("../helpers/finerworks-service");
const debug = require("debug");
const log = debug("app:uploadOrders");
const { validateOrderPayload } = require("./validate-order");
const { randomUUID: uuidv4 } = require('crypto'); // Use Node's built-in crypto.randomUUID for UUID generation
const { logIncomingRequest, redactAndTruncate } = require("../helpers/request-log");
const { updateOrder: updateOrderFullReplace } = require("./upload-orders");

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

//     const { accountId, page, limit } = req.body;

//     if (!accountId) {
//       return res.status(400).json({
//         statusCode: 400,
//         status: false,
//         message: "Account ID is missing or invalid.",
//       });
//     }

//     // Convert page and limit to numbers and ensure positive integers
//     const pageNum = parseInt(page, 10) > 0 ? parseInt(page, 10) : 1;
//     const limitNum = parseInt(limit, 10) > 0 ? parseInt(limit, 10) : 10;

//     log("Request to get order details for", JSON.stringify(req.body));

//     const selectPayload = {
//       query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE FulfillmentAccountID=${accountId} AND FulfillmentDeleted=0 AND FulfillmentSubmitted=0 ORDER BY FulfillmentID DESC`,
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

//     // Process orders
//     const allOrders = selectData.data.map((order) => {
//       const orderData = urlDecodeJSON(order.FulfillmentData);
//       orderData.orderFullFillmentId = order.FulfillmentID;
//       return orderData;
//     });
//     allOrders.sort((a, b) => {
//       const numA = parseInt(a.order_po.replace(/\D/g, ""), 10);
//       const numB = parseInt(b.order_po.replace(/\D/g, ""), 10);
//       return numA - numB;
//     });


//     if (allOrders.length === 0) {
//       log("No orders found after processing for account ID:", accountId);
//       return res.status(200).json({
//         statusCode: 200,
//         status: false,
//         message: "No orders available for this account.",
//         data: [],
//       });
//     }

//     // Pagination calculations
//     const totalOrders = allOrders.length;
//     const totalPages = Math.ceil(totalOrders / limitNum);
//     const startIndex = (pageNum - 1) * limitNum;
//     const endIndex = startIndex + limitNum;

//     // Slice orders for current page
//     const paginatedOrders = allOrders.slice(startIndex, endIndex);

//     const successLog = JSON.stringify({
//       level: 'INFO',
//       platform: 'finerworks',
//       method: req.method,
//       api: req.originalUrl || req.url,
//       function: 'viewAllOrders',
//       operation: 'Orders fetched successfully',
//       account_key: req.body?.account_key || req.query?.account_key || 'unknown',
//       result: { totalOrders, currentPage: pageNum, pageSize: limitNum },
//       timestamp: new Date().toISOString()
//     });
//     console.log(successLog);
//     log('Success in viewAllOrders: %s', successLog);
//     res.status(200).json({
//       statusCode: 200,
//       status: true,
//       message: "Orders found successfully.",
//       data: paginatedOrders,
//       pagination: {
//         totalOrders,
//         totalPages,
//         currentPage: pageNum,
//         pageSize: limitNum,
//       },
//     });

//   } catch (err) {
//     log("Error while fetching orders:", err?.message || JSON.stringify(err));
//     const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
//     const errorJson = JSON.stringify({
//       level: 'ERROR',
//       platform: 'finerworks',
//       source: isFinerworksError ? 'finerworks_api' : 'lambda',
//       function: 'viewAllOrders',
//       account_key: req.body?.account_key || req.query?.account_key || 'unknown',
//       httpStatus: err?.response?.status || null,
//       message: `Failed to fetch orders: ${err?.message || 'Unknown error'}`,
//       detail: err?.response?.data?.message || err?.response?.data?.error || null,
//       timestamp: new Date().toISOString()
//     });
//     console.error(errorJson);
//     log('Formatted error in viewAllOrders: %s', errorJson);
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
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'viewAllOrders',
      accountKey: req.body?.account_key || req.query?.account_key,
      body: req.body,
      query: req.query,
    });
    // Validate request body format
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Invalid request format. Expected a JSON object.",
      });
    }

    const { account_key, page, limit } = req.body;

    if (!account_key) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Account key is missing or invalid.",
      });
    }

    // Convert page and limit to numbers and ensure positive integers
    const pageNum = parseInt(page, 10) > 0 ? parseInt(page, 10) : 1;
    const limitNum = parseInt(limit, 10) > 0 ? parseInt(limit, 10) : 10;

    log("Request to get order details for", JSON.stringify(req.body));

    const pendingOrdersData = await finerworksService.LIST_PENDING_ORDERS({ account_key });
    console.log("pendingOrdersData=========>>>", pendingOrdersData.orders.length);

    if (!pendingOrdersData?.status?.success || !Array.isArray(pendingOrdersData.orders)) {
      log("No orders found for account key:", account_key);
      return res.status(200).json({
        statusCode: 200,
        status: false,
        message: pendingOrdersData?.status?.message || "No orders found for the provided account key.",
        data: [],
      });
    }

    // Process orders
    // LIST_PENDING_ORDERS returns each order's staging id as `fulfillment_id`; rename it to
    // `orderFullFillmentId` to match the field name used elsewhere in the API responses.
    const allOrders = pendingOrdersData.orders.map((order) => {
      const { fulfillment_id, ...rest } = order;
      return { ...rest, orderFullFillmentId: fulfillment_id };
    });
    allOrders.sort((a, b) => {
      const numA = parseInt(a.order_po.replace(/\D/g, ""), 10);
      const numB = parseInt(b.order_po.replace(/\D/g, ""), 10);
      return numA - numB;
    });


    if (allOrders.length === 0) {
      log("No orders found after processing for account key:", account_key);
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

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'finerworks',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'viewAllOrders',
      operation: 'Orders fetched successfully',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      result: { totalOrders, currentPage: pageNum, pageSize: limitNum },
      timestamp: new Date().toISOString()
    });
    console.log(successLog);
    log('Success in viewAllOrders: %s', successLog);
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
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'finerworks',
      source: isFinerworksError ? 'finerworks_api' : 'lambda',
      function: 'viewAllOrders',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to fetch orders: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.error || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in viewAllOrders: %s', errorJson);
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
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'viewOrderDetails',
      accountKey: req.body?.account_key || req.query?.account_key,
      body: req.body,
      query: req.query,
    });
    const reqBody = JSON.parse(JSON.stringify(req.body));

    if (!reqBody || !reqBody.accountId || !reqBody.orderFullFillmentId) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Bad Request",
      });
    } else if (!reqBody.account_key && !req.query?.account_key) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Account key is missing or invalid.",
      });
    } else {
      log("Request comes to get order details for", JSON.stringify(reqBody));
      // No local lookup at all now — list_pending_orders returns FinerWorks' own staging id as
      // `fulfillment_id` on each order, so the requested orderFullFillmentId is matched directly
      // against that instead of first resolving it via a local SELECT.
      const accountKeyForLookup = reqBody.account_key || req.query?.account_key;
      const listPendingData = await finerworksService.LIST_PENDING_ORDERS({
        account_key: accountKeyForLookup,
      });
      const pendingOrders = Array.isArray(listPendingData?.orders) ? listPendingData.orders : [];
      const liveOrder = pendingOrders.find(
        (o) => String(o.fulfillment_id) === String(reqBody.orderFullFillmentId)
      );

      const allOrders = liveOrder
        ? [(() => {
          const { fulfillment_id, ...rest } = liveOrder;
          return { ...rest, orderFullFillmentId: fulfillment_id };
        })()]
        : [{
          orderFullFillmentId: reqBody.orderFullFillmentId,
          error: "Order not found among FinerWorks pending orders.",
        }];

      const successLog = JSON.stringify({
        level: 'INFO',
        platform: 'finerworks',
        method: req.method,
        api: req.originalUrl || req.url,
        function: 'viewOrderDetails',
        operation: 'Order details fetched successfully',
        account_key: req.body?.account_key || req.query?.account_key || 'unknown',
        result: { count: allOrders.length, orderFullFillmentId: reqBody.orderFullFillmentId },
        timestamp: new Date().toISOString()
      });
      console.log(successLog);
      log('Success in viewOrderDetails: %s', successLog);
      res.status(200).json({
        statusCode: 200,
        status: true,
        message: "Orders Found",
        data: allOrders,
      });
    }
  } catch (err) {
    log("Error while fetching order details:", err?.message || JSON.stringify(err));
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const rawDetail = err?.response?.data;
    const detail = rawDetail && typeof rawDetail === 'object'
      ? (rawDetail.message || rawDetail.error || JSON.stringify(rawDetail).slice(0, 1000))
      : (typeof rawDetail === 'string' && rawDetail.trim() ? rawDetail.slice(0, 1000) : null);
    const httpStatus = err?.response?.status || null;
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'finerworks',
      source: isFinerworksError ? 'finerworks_api' : 'lambda',
      function: 'viewOrderDetails',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus,
      message: `Failed to fetch order details: ${err?.message || 'Unknown error'}`,
      detail,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in viewOrderDetails: %s', errorJson);
    if (!res.headersSent) {
      res.status(502).json({
        statusCode: 502,
        status: false,
        message: "Failed to fetch order details from FinerWorks",
        detail,
      });
    }
  }
};
exports.updateOrderByProductSkuCode = async (req, res) => {
  try {
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'updateOrderByProductSkuCode',
      accountKey: req.body?.account_key || req.query?.account_key,
      body: req.body,
      query: req.query,
    });
    const reqBody = JSON.parse(JSON.stringify(req.body));
    let getProductDetails

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
    if (!reqBody.account_key) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Account key is missing or invalid.",
      });
    }

    // Fetch first if order is exist
    log(
      "Request comes to get order details to update product details",
      JSON.stringify(reqBody)
    );
    // Live FinerWorks pending order instead of the local raw-SQL row — list_pending_orders
    // returns the order already decoded, so no FulfillmentData/urlDecodeJSON step is needed.
    const listPendingData = await finerworksService.LIST_PENDING_ORDERS({
      account_key: reqBody.account_key,
    });
    const pendingOrders = Array.isArray(listPendingData?.orders) ? listPendingData.orders : [];
    const orderDetails = pendingOrders.find(
      (o) => String(o.fulfillment_id) === String(reqBody.orderFullFillmentId)
    );
    log("Order Data", JSON.stringify(orderDetails));
    if (!orderDetails) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Invalid order. Please try with valid order.",
      });
    }
    // If order exist then find the product details
    const { skuCode, productCode, fromTheInventory, account_key, product_guid } = reqBody;
    const searchListVirtualInventoryParams = {};
    if (skuCode) {
      searchListVirtualInventoryParams.sku_filter = [skuCode];
    }
    if (productCode) {
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
      const orderFound = orderDetails.order_items.filter((item) => {
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
      console.log("searchListVirtualInventoryParams=====", searchListVirtualInventoryParams);
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
        const product = getProductDetails.products;
        console.log("product====", product)
        const previousOrder = JSON.parse(JSON.stringify(orderDetails));
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
        previousOrder.fulfillment_id = reqBody.orderFullFillmentId;
        const savePayload = {
          orders: [previousOrder],
          source: previousOrder.source || "web",
          account_key: reqBody.account_key ?? null,
        };
        log("save_pending_orders payload", JSON.stringify(savePayload));
        const saveData = await finerworksService.SAVE_PENDING_ORDERS(savePayload);
        log("save_pending_orders response", JSON.stringify(saveData));
        if (saveData?.status?.success) {
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
      console.log("payload=====", payload);
      getProductDetails = await finerworksService.GET_PRODUCTS_DETAILS(payload);
      log("Get product details", JSON.stringify(getProductDetails));
      console.log("getProductDetails", getProductDetails);
      if (getProductDetails?.status?.success) {
        const products = skuCode
          ? getProductDetails.products
          : getProductDetails.product_list;
        const previousOrder = JSON.parse(JSON.stringify(orderDetails));
        const orderData = reqBody.product_url_file.map((url, index) =>
          buildUpdatedOrderItem({
            products,
            url,
            thumbnailUrl: reqBody.product_url_thumbnail[index],
            reqBody,
            product_guid: product_guid ? product_guid : generateGUID(),
          })
        );

        if (previousOrder?.order_items) {
          orderData.forEach((item) => {
            previousOrder.order_items.push(item);
          })
        }
        log("Previous order is", JSON.stringify(previousOrder));
        // save order back to FinerWorks
        previousOrder.fulfillment_id = reqBody.orderFullFillmentId;
        const savePayload = {
          orders: [previousOrder],
          source: previousOrder.source || "web",
          account_key: reqBody.account_key ?? null,
        };
        console.log("savePayload=====", savePayload);
        const saveData = await finerworksService.SAVE_PENDING_ORDERS(savePayload);
        if (saveData?.status?.success) {
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
    const errorMessage = err.response?.data || err.message || "Unknown error";
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: errorMessage,
    });
  }
};


exports.updateOrderByValidProductSkuCode = async (req, res) => {
  try {
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'updateOrderByValidProductSkuCode',
      accountKey: req.body?.account_key || req.query?.account_key,
      body: req.body,
      query: req.query,
    });
    const reqBody = JSON.parse(JSON.stringify(req.body));
    let getProductDetails

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
    if (!reqBody.account_key) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Account key is missing or invalid.",
      });
    }

    // Fetch first if order is exist
    log(
      "Request comes to get order details to update product details",
      JSON.stringify(reqBody)
    );
    // Live FinerWorks pending order instead of the local raw-SQL row — list_pending_orders
    // returns the order already decoded, so no FulfillmentData/urlDecodeJSON step is needed.
    const listPendingData = await finerworksService.LIST_PENDING_ORDERS({
      account_key: reqBody.account_key,
    });
    const pendingOrders = Array.isArray(listPendingData?.orders) ? listPendingData.orders : [];
    const orderDetails = pendingOrders.find(
      (o) => String(o.fulfillment_id) === String(reqBody.orderFullFillmentId)
    );
    log("Order Data", JSON.stringify(orderDetails));
    if (!orderDetails) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Invalid order. Please try with valid order.",
      });
    }
    // If order exist then find the product details
    const { skuCode, productCode, fromTheInventory, account_key, toReplace } = reqBody;
    const searchListVirtualInventoryParams = {};
    if (skuCode) {
      searchListVirtualInventoryParams.sku_filter = [skuCode];
    }
    if (productCode) {
      searchListVirtualInventoryParams.product_code_filter = [productCode];
    }
    if (account_key) {
      searchListVirtualInventoryParams.account_key = account_key;
    }
    log(
      "Request come to search product from virtual inventory for the payload",
      JSON.stringify(searchListVirtualInventoryParams)
    );

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
        const product = getProductDetails.products;
        console.log("product====", product)
        const previousOrder = JSON.parse(JSON.stringify(orderDetails));
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
        updatedOrder.fulfillment_id = reqBody.orderFullFillmentId;
        const savePayload = {
          orders: [updatedOrder],
          source: updatedOrder.source || "web",
          account_key: reqBody.account_key ?? null,
        };
        log("save_pending_orders payload", JSON.stringify(savePayload));
        const saveData = await finerworksService.SAVE_PENDING_ORDERS(savePayload);
        log("save_pending_orders response", JSON.stringify(saveData));
        if (saveData?.status?.success) {
          res.status(200).json({
            statusCode: 200,
            status: true,
            message: "Orders have been successfully updated",
            data: updatedOrder,
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
      console.log("enter hererererere")
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
      console.log("payload===>>>", payload);

      log("Product details from API", JSON.stringify(getProductDetails));
      getProductDetails = await finerworksService.GET_PRODUCTS_DETAILS(payload);
      log("Get product details", JSON.stringify(getProductDetails));
      console.log("getProductDetails", getProductDetails);

      if (getProductDetails?.status?.success) {
        const products = skuCode
          ? getProductDetails.products
          : getProductDetails.product_list;
        const previousOrder = JSON.parse(JSON.stringify(orderDetails));
        const orderData = reqBody.product_url_file.map((url, index) =>
          buildUpdatedOrderItem({
            products,
            url,
            thumbnailUrl: reqBody.product_url_thumbnail[index],
            reqBody,
            product_guid: generateGUID(),
          })
        );

        console.log("orderData====>>>>", orderData);
        console.log(previousOrder, "previousOrder");
        const updatedOrder = updateOrderItemsV2(previousOrder, orderData, toReplace);
        console.log("updatedOrder======>>>>>>", updatedOrder);
        updatedOrder.fulfillment_id = reqBody.orderFullFillmentId;
        const savePayload = {
          orders: [updatedOrder],
          source: updatedOrder.source || "web",
          account_key: reqBody.account_key ?? null,
        };
        log("save_pending_orders payload", JSON.stringify(savePayload));
        const saveData = await finerworksService.SAVE_PENDING_ORDERS(savePayload);
        log("save_pending_orders response", JSON.stringify(saveData));
        if (saveData?.status?.success) {
          res.status(200).json({
            statusCode: 200,
            status: true,
            message: "Orders have been successfully updated",
            data: updatedOrder,
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
    const errorMessage = err.response?.data || err.message || "Unknown error";
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: errorMessage,
    });
  }
};

/**
 * Combines /update-order-by-valid-product-sku (add/replace a single order item by SKU or
 * product code) and /update-orders (replace a whole order's data) behind one endpoint. Each
 * payload keeps its own original shape — nothing is merged — since toReplace only ever appears
 * in the single-item payload, its presence is what picks which of the two original handlers runs.
 */
exports.updateOrderMerged = async (req, res) => {
  const body = req.body || {};
  if (Object.prototype.hasOwnProperty.call(body, 'toReplace')) {
    return exports.updateOrderByValidProductSkuCode(req, res);
  }
  return updateOrderFullReplace(req, res);
};

function generateGUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
exports.createNewOrder = async (req, res) => {
  try {
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'createNewOrder',
      accountKey: req.body?.account_key || req.query?.account_key,
      body: req.body,
      query: req.query,
    });
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
    if (product_code !== "") {
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
        const savePayload = {
          orders: [order],
          source: 'web',
          account_key: reqBody.account_key ?? null,
        };
        log("save_pending_orders payload", JSON.stringify(savePayload));
        const saveData = await finerworksService.SAVE_PENDING_ORDERS(savePayload);
        log("save_pending_orders response", JSON.stringify(saveData));
        order.orderFullFillmentId = extractSavedPendingOrderId(saveData);
      }
      const successLog = JSON.stringify({
        level: 'INFO',
        platform: 'finerworks',
        method: req.method,
        api: req.originalUrl || req.url,
        function: 'createNewOrder',
        operation: 'New order created successfully',
        account_key: req.body?.account_key || req.query?.account_key || 'unknown',
        result: { count: ordersToBeSubmitted.length, orderPo: orderPoNumber },
        timestamp: new Date().toISOString()
      });
      console.log(successLog);
      log('Success in createNewOrder: %s', successLog);
      res.status(200).json({
        statusCode: 200,
        status: true,
        message: "Orders have been created successfully",
        data: ordersToBeSubmitted,
      });
    }
  } catch (err) {
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'finerworks',
      source: isFinerworksError ? 'finerworks_api' : 'lambda',
      function: 'createNewOrder',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to create new order: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.error || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in createNewOrder: %s', errorJson);
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
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'deleteOrder',
      accountKey: req.body?.account_key || req.query?.account_key,
      body: req.body,
      query: req.query,
    });
    const reqBody = JSON.parse(JSON.stringify(req.body));
    const { accountId, orderFullFillmentId } = reqBody;
    const account_key = reqBody.account_key || req.query?.account_key || req.validatedAccountKey;

    // Check if accountId and orderFullFillmentIds are provided
    if (!accountId || !Array.isArray(orderFullFillmentId) || orderFullFillmentId.length === 0) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Account Id and order fullfillment IDs are required, and IDs must be an array.",
      });
    }
    if (!account_key) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Account key is missing or invalid.",
      });
    }

    // Log the request body
    log("Request comes to delete orders for", JSON.stringify(reqBody));

    const pendingOrderIds = orderFullFillmentId
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id));
    if (pendingOrderIds.length === 0) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Account Id and order fullfillment IDs are required, and IDs must be an array.",
      });
    }
    const orderFullFillmentIdsStr = pendingOrderIds.join(",");

    // orderFullFillmentId values are FinerWorks pending-order ids — pass them straight to
    // POST /v3/delete_pending_orders ({ ids, account_key }).
    const deleteData = await finerworksService.DELETE_PENDING_ORDER({
      ids: pendingOrderIds,
      account_key,
    });

    if (!deleteData?.status?.success) {
      throw new Error(deleteData?.status?.message || "Something went wrong while deleting the orders.");
    }

    // Success response after deleting all valid orders
    log("Orders have been successfully deleted for", JSON.stringify(reqBody));
    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'finerworks',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'deleteOrder',
      operation: 'Orders deleted successfully',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      result: { deletedIds: orderFullFillmentIdsStr },
      timestamp: new Date().toISOString()
    });
    console.log(successLog);
    log('Success in deleteOrder: %s', successLog);
    res.status(200).json({
      statusCode: 200,
      status: true,
      message: `Orders with Fulfillment IDs [${orderFullFillmentIdsStr}] have been successfully deleted.`,
    });

  } catch (err) {
    log("Error occurred while deleting orders", JSON.stringify(err), err);
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'finerworks',
      source: isFinerworksError ? 'finerworks_api' : 'lambda',
      function: 'deleteOrder',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to delete orders: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.error || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in deleteOrder: %s', errorJson);
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: err.message || "Unknown error",
    });
  }
};

exports.submitOrders = async (req, res) => {
  try {
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'submitOrders',
      accountKey: req.body?.account_key || req.query?.account_key,
      body: req.body,
      query: req.query,
    });
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
      const orderFulfillmentIds = [];
      const finalOrders = ordersToBeSubmitted.map((order) => {
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
      const successLog = JSON.stringify({
        level: 'INFO',
        platform: 'finerworks',
        method: req.method,
        api: req.originalUrl || req.url,
        function: 'submitOrders',
        operation: 'Orders submitted to FinerWorks successfully',
        account_key: account_key || 'unknown',
        result: { count: ordersToBeSubmitted?.length || 0 },
        timestamp: new Date().toISOString()
      });
      console.log(successLog);
      log('Success in submitOrders: %s', successLog);
    }
  } catch (err) {
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'finerworks',
      source: isFinerworksError ? 'finerworks_api' : 'lambda',
      function: 'submitOrders',
      account_key: req.body?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to submit orders: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.error || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in submitOrders: %s', errorJson);
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
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'submitOrdersV2',
      accountKey: req.body?.account_key || req.query?.account_key,
      body: req.body,
      query: req.query,
    });
    const reqBody = JSON.parse(JSON.stringify(req.body));
    if (!reqBody?.orders || !reqBody?.accountId || !reqBody?.account_key) {
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
      const orderFulfillmentIds = [];
      const finalResults = [];
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
        payment_token: payment_token ? payment_token : '',
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
        const successLog = JSON.stringify({
          level: 'INFO',
          platform: 'finerworks',
          method: req.method,
          api: req.originalUrl || req.url,
          function: 'submitOrdersV2',
          operation: 'Orders V2 submitted to FinerWorks successfully',
          account_key: account_key || 'unknown',
          result: { count: updatedOrders?.length || 0 },
          timestamp: new Date().toISOString()
        });
        console.log(successLog);
        log('Success in submitOrdersV2: %s', successLog);
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
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'finerworks',
      source: isFinerworksError ? 'finerworks_api' : 'lambda',
      function: 'submitOrdersV2',
      account_key: req.body?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to submit orders V2: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.error || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in submitOrdersV2: %s', errorJson);
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
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'orderSubmitStatus',
      accountKey: req.body?.account_key || req.query?.account_key,
      body: req.body,
      query: req.query,
    });
    const reqBody = JSON.parse(JSON.stringify(req.body));
    if (!reqBody.accountId || !reqBody.account_key || !reqBody.orderId) {
      res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Account Id and order fullfillment Id are required.",
      });
    } else {
      const { account_key, orderId } = reqBody;
      log("Request comes to delete order for", JSON.stringify(reqBody));

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
        const successLog = JSON.stringify({
          level: 'INFO',
          platform: 'finerworks',
          method: req.method,
          api: req.originalUrl || req.url,
          function: 'orderSubmitStatus',
          operation: 'Order submit status fetched successfully',
          account_key: req.body?.account_key || 'unknown',
          result: { orderId: reqBody.orderId },
          timestamp: new Date().toISOString()
        });
        console.log(successLog);
        log('Success in orderSubmitStatus: %s', successLog);
        res.status(200).json({
          statusCode: 200,
          status: true,
          data: orderStatusData
        });
      }
    }
  } catch (err) {
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'finerworks',
      source: isFinerworksError ? 'finerworks_api' : 'lambda',
      function: 'orderSubmitStatus',
      account_key: req.body?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to fetch order submit status: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.error || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in orderSubmitStatus: %s', errorJson);
    const errorMessage = err;
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: errorMessage,
    });
  }
};

exports.orderSubmitStatusBulk = async (req, res) => {
  try {
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'orderSubmitStatusBulk',
      accountKey: req.body?.account_key || req.query?.account_key,
      body: req.body,
      query: req.query,
    });
    const reqBody = JSON.parse(JSON.stringify(req.body));
    const { account_key, orderIds } = reqBody;

    if (!account_key || !Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Account key and order IDs are required, and order IDs must be a non-empty array.",
      });
    }

    log("Request comes to get bulk order submit status for", JSON.stringify(reqBody));

    const selectOrderIds = {
      "ids": orderIds,
      "account_key": account_key
    };
    console.log("selectOrderIds=================>>>>>>>>>>>", selectOrderIds);
    const orderStatusData = await finerworksService.LIST_PENDING_ORDERS(
      selectOrderIds
    );
    console.log("orderStatusData===============", orderStatusData);

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'finerworks',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'orderSubmitStatusBulk',
      operation: 'Order submit status fetched successfully',
      account_key: req.body?.account_key || 'unknown',
      result: { orderIds },
      timestamp: new Date().toISOString()
    });
    console.log(successLog);
    log('Success in orderSubmitStatusBulk: %s', successLog);
    res.status(200).json({
      statusCode: 200,
      status: true,
      data: orderStatusData
    });
  } catch (err) {
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'finerworks',
      source: isFinerworksError ? 'finerworks_api' : 'lambda',
      function: 'orderSubmitStatusBulk',
      account_key: req.body?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to fetch bulk order submit status: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.error || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in orderSubmitStatusBulk: %s', errorJson);
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: err?.message || "Unknown error",
    });
  }
};

exports.getOrderPrice = async (req, res) => {
  try {
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'getOrderPrice',
      accountKey: req.body?.account_key || req.query?.account_key,
      body: req.body,
      query: req.query,
    });
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
      const successLog = JSON.stringify({
        level: 'INFO',
        platform: 'finerworks',
        method: req.method,
        api: req.originalUrl || req.url,
        function: 'getOrderPrice',
        operation: 'Order price fetched successfully',
        account_key: req.body?.account_key || req.query?.account_key || 'unknown',
        result: { orderId: reqBody?.orderId },
        timestamp: new Date().toISOString()
      });
      console.log(successLog);
      log('Success in getOrderPrice: %s', successLog);
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
    log("Error comes while fetching order price", JSON.stringify(err), err);
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'finerworks',
      source: isFinerworksError ? 'finerworks_api' : 'lambda',
      function: 'getOrderPrice',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to fetch order price: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.error || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in getOrderPrice: %s', errorJson);
    const errorMessage = err.response.data;
    res.status(400).json({
      statusCode: 400,
      status: false,
      message: errorMessage,
    });
  }
};

exports.getOrderDetailsById = async (req, res) => {
  try {
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'getOrderDetailsById',
      accountKey: req.body?.account_key || req.query?.account_key,
      body: req.body,
      query: req.query,
    });
    console.log("hererererere");
    const reqBody = JSON.parse(JSON.stringify(req.body));

    // Check if orderIds are provided in the request body
    if (!reqBody || !reqBody.orderIds || !Array.isArray(reqBody.orderIds) || !reqBody.orderIds.length) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Bad Request, missing orderIds",
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

    const accountKeyForLookup = reqBody.account_key || req.query?.account_key;
    if (!accountKeyForLookup) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "Account key is missing or invalid.",
      });
    }

    console.log("orderIds===========>>>>", orderIds);
    console.log("platformName===========>>>>", platformName);
    console.log("accountId===========>>>>", accountId);

    // list_pending_orders only filters by `ids` (FinerWorks' own numeric pending-order id) or
    // `skus` — it has no order_po/order_number filter (see FinerWorks API docs), and we don't have
    // FinerWorks' internal ids up front, only the platform's order numbers. So this fetches every
    // pending order for the account and matches order_po client-side, same as the old local SELECT
    // did — only the data source changed.
    const listPendingData = await finerworksService.LIST_PENDING_ORDERS({
      account_key: accountKeyForLookup,
    });
    const pendingOrders = Array.isArray(listPendingData?.orders) ? listPendingData.orders : [];
    console.log("pendingOrders===>", pendingOrders.length);

    // Collect order_po values from the live pending orders
    const orderPos = pendingOrders.map((row) => {
      const orderPo = row.order_po;
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

const callApiWithMissingOrders = async (missingOrders, platformName, res, domainName) => {
  try {
    const allOrderDetails = [];

    if (platformName === 'woocommerce') {
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
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'softDeleteOrders',
      accountKey: req.body?.account_key || req.query?.account_key,
      body: req.body,
      query: req.query,
    });
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

exports.disconnectAndProcess = async (req, res) => {
  try {
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'disconnectAndProcess',
      accountKey: req.body?.account_key || req.query?.account_key,
      body: req.body,
      query: req.query,
    });
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
      try {
        internalApiResponse = await axios.post(apiEndpoint);
        console.log("internalApiResponse=========>>>>>>", internalApiResponse);
      } catch (error) {
        console.log("error=========>>>>>>", error);
      }

      const getInformation = await finerworksService.GET_INFO({ account_key: client_id });
      console.log("getInformation==============>>>>>>>>>>", getInformation);

      // Defensive check if connections exist
      const connections = getInformation?.user_account?.connections || [];

      // Filter out objects with name === "WooCommerce"
      const filteredConnections = connections.filter(conn => conn.name !== "WooCommerce");
      console.log("filteredConnections====>>>>", filteredConnections);

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

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'woocommerce',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'disconnectAndProcess',
      operation: 'Client deauthorized successfully',
      account_key: req.body?.client_id || 'unknown',
      result: { deauthorized: true },
      timestamp: new Date().toISOString()
    });
    console.log(successLog);
    log('Success in disconnectAndProcess: %s', successLog);
    return res.status(200).json({
      statusCode: 200,
      status: true,
      message: "Client successfully deauthorized.",
      data: internalApiResponse.data,
    });

  } catch (err) {
    console.error("Error while processing client_id:", err);
    const isWoocommerceError = err?.response?.config?.url?.includes(req.body?.domainName) || err?.config?.url?.includes(req.body?.domainName);
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'woocommerce',
      source: isWoocommerceError ? 'woocommerce_api' : (isFinerworksError ? 'finerworks_api' : 'lambda'),
      function: 'disconnectAndProcess',
      account_key: req.body?.client_id || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to disconnect and process: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.error || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in disconnectAndProcess: %s', errorJson);
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
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'connectAndProcess',
      accountKey: req.body?.account_key || req.query?.account_key,
      body: req.body,
      query: req.query,
    });
    const { clientId, account_key } = req.body;

    // Validate client_id
    if (!clientId) {
      return res.status(400).json({
        statusCode: 400,
        status: false,
        message: "client_id is missing or invalid.",
      });
    }

    console.log("Received client_id:", clientId);

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
        const successLog = JSON.stringify({
          level: 'INFO',
          platform: 'woocommerce',
          method: req.method,
          api: req.originalUrl || req.url,
          function: 'connectAndProcess',
          operation: 'Connection established (updated existing)',
          account_key: account_key || 'unknown',
          result: { connected: true },
          timestamp: new Date().toISOString()
        });
        console.log(successLog);
        log('Success in connectAndProcess: %s', successLog);
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
    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'woocommerce',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'connectAndProcess',
      operation: 'Connection added successfully',
      account_key: account_key || 'unknown',
      result: { connected: true },
      timestamp: new Date().toISOString()
    });
    console.log(successLog);
    log('Success in connectAndProcess: %s', successLog);
    return res.status(200).json({
      statusCode: 200,
      status: true,
      message: "Connection added successfully",
    });

  } catch (err) {
    console.error("Error while processing client_id:", err);
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'woocommerce',
      source: isFinerworksError ? 'finerworks_api' : 'lambda',
      function: 'connectAndProcess',
      account_key: req.body?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to connect and process: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.error || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in connectAndProcess: %s', errorJson);
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
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'connectAndProcessOfa',
      accountKey: req.body?.account_key || req.query?.account_key,
      body: req.body,
      query: req.query,
    });
    const { domainName, account_key } = req.body;

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
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'checkDomain',
      accountKey: req.body?.account_key || req.query?.account_key,
      body: req.body,
      query: req.query,
    });
    const { domainName } = req.body;

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
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'sendOrderDetails',
      accountKey: req.body?.account_key || req.query?.account_key,
      body: req.body,
      query: req.query,
    });
    const { account_key, orders, domainName } = req.body;

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
    if (updateOrdersResponse.data.success === true) {
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
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'updateOrderItemImage',
      accountKey: req.body?.account_key || req.query?.account_key,
      body: req.body,
      query: req.query,
    });
    const reqBody = JSON.parse(JSON.stringify(req.body));

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
    console.log("previousOrder===============", previousOrder);

    const urlEncodedData = urlEncodeJSON(previousOrder);
    const updatePayload = {
      tablename: process.env.FINER_fwAPI_FULFILLMENTS_TABLE,
      fieldupdates: `FulfillmentData='${urlEncodedData}'`,
      where: `FulfillmentID=${reqBody.orderFullFillmentId}`,
    };

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
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'testAccountKey',
      accountKey: req.body?.account_key || req.query?.account_key,
      body: req.body,
      query: req.query,
    });
    const { account_key, domainName } = req.body;

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

    const connections = JSON.parse(JSON.stringify(getInformationv2?.user_account?.connections)) || [];

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
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'disconnectProductsFromInventory',
      accountKey: req.body?.account_key || req.query?.account_key,
      body: req.body,
      query: req.query,
    });
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
/**
 * Pulls the saved pending order id out of a save_pending_orders response. The response shape is not
 * yet locked down, so we look through the likely field names and fall back to null (downstream code
 * uses this as `orderFullFillmentId`).
 */
function extractSavedPendingOrderId(saveData) {
  if (!saveData || typeof saveData !== "object") return null;
  // save_pending_orders returns { imports: [{ id, order_po }], status: {...} }.
  const firstImport = Array.isArray(saveData.imports) ? saveData.imports[0] : null;
  const firstOrder = Array.isArray(saveData.orders) ? saveData.orders[0] : null;
  return (
    firstImport?.id ??
    firstImport?.record_id ??
    firstOrder?.id ??
    firstOrder?.order_id ??
    firstOrder?.FulfillmentID ??
    firstOrder?.record_id ??
    (Array.isArray(saveData.ids) ? saveData.ids[0] : null) ??
    saveData.record_id ??
    saveData.id ??
    null
  );
}

function urlEncodeJSON(data) {
  const jsonString = JSON.stringify(data);
  // encodeURIComponent intentionally does NOT encode: ! ' ( ) *
  // We must encode these too (especially `'`), because the result is embedded
  // into SQL strings like FulfillmentData='...'
  const encodedString = encodeURIComponent(jsonString).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return encodedString;
}

function buildOrderItemProductImage({
  pixel_width,
  pixel_height,
  product_url_file,
  product_url_thumbnail,
  library_file = null,
}) {
  return {
    pixel_width: pixel_width ?? 600,
    pixel_height: pixel_height ?? 600,
    product_url_file:
      product_url_file ?? "https://via.placeholder.com/600",
    product_url_thumbnail:
      product_url_thumbnail ?? "https://via.placeholder.com/150",
    library_file,
  };
}

function buildUpdatedOrderItem({
  products,
  url,
  thumbnailUrl,
  reqBody,
  product_guid,
}) {
  const product = products?.[0];
  return {
    product_qty: product?.quantity ?? 1,
    product_sku: product?.sku ? product.sku : product?.product_code,
    product_title: product?.name ?? null,
    product_guid,
    template: null,
    custom_data_1: null,
    custom_data_2: null,
    custom_data_3: null,
    coa: null,
    product_image: buildOrderItemProductImage({
      pixel_width: reqBody.pixel_width,
      pixel_height: reqBody.pixel_height,
      product_url_file: url,
      product_url_thumbnail: thumbnailUrl,
    }),
  };
}

function normalizeOrderItemIdentifier(value) {
  if (value == null) return "";
  return String(value).trim().toLowerCase().replace(/-/g, "");
}

function orderItemMatchesReplace(item, toReplace) {
  if (!toReplace || !item) return false;

  const target = normalizeOrderItemIdentifier(toReplace);
  if (!target) return false;

  const identifiers = [
    item.product_sku,
    item.product_guid,
    item.product_order_po,
    item.custom_data_1,
    item.custom_data_2,
    item.custom_data_3,
  ];

  return identifiers.some(
    (identifier) =>
      identifier != null && normalizeOrderItemIdentifier(identifier) === target
  );
}

function replaceMatchedOrderItems(updatedOrder, orderData, toReplace) {
  let matchFound = false;
  let preservedProductOrderPo = null;

  updatedOrder.order_items = updatedOrder.order_items.filter((item) => {
    if (orderItemMatchesReplace(item, toReplace)) {
      matchFound = true;
      if (item.product_order_po != null && preservedProductOrderPo == null) {
        preservedProductOrderPo = item.product_order_po;
      }
      return false;
    }
    return true;
  });

  if (!matchFound && toReplace && updatedOrder.order_items.length === 1) {
    const [onlyItem] = updatedOrder.order_items;
    if (onlyItem?.product_order_po != null) {
      preservedProductOrderPo = onlyItem.product_order_po;
    }
    updatedOrder.order_items = [];
    matchFound = true;
  }

  if (matchFound) {
    const itemsToAdd = Array.isArray(orderData) ? orderData : [orderData];
    const enrichedItems = itemsToAdd.map((item) => ({
      ...item,
      ...(preservedProductOrderPo != null && item.product_order_po == null
        ? { product_order_po: preservedProductOrderPo }
        : {}),
    }));

    updatedOrder.order_items.push(...enrichedItems);
  }

  return updatedOrder;
}

function updateOrderItems(previousOrder, orderData, toReplace) {
  const updatedOrder = JSON.parse(JSON.stringify(previousOrder));
  return replaceMatchedOrderItems(updatedOrder, orderData, toReplace);
}

function updateOrderItemsV2(previousOrder, orderData, toReplace) {
  const updatedOrder = JSON.parse(JSON.stringify(previousOrder));
  return replaceMatchedOrderItems(updatedOrder, orderData, toReplace);
}