const createEvent = require("../helpers/create-event");
const finerworksService = require("../helpers/finerworks-service");
const debug = require("debug");
const log = debug("app:uploadOrders");
const Joi = require("joi");
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
        log('Request comes to get order details for', JSON.stringify(reqBody))
        const selectPayload = {
          query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE FulfillmentAccountID=${reqBody.accountId}ORDER BY FulfillmentID DESC`,
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
        log('Request comes to get order details for', JSON.stringify(reqBody))
        const selectPayload = {
          query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE  FulfillmentID=${reqBody.orderFullFillmentId}`,
         
        };
        log('select payload is', JSON.stringify(selectPayload));
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
      if(!reqBody.orderFullFillmentId){
        res.status(400).json({
          statusCode: 400,
          status: false,
          message: "Orderfullfillment Id is required.",
        });
      }
      if(!reqBody.skuCode && !reqBody.productCode){
        res.status(400).json({
          statusCode: 400,
          status: false,
          message: "Sku code or Product Guid is required",
        });
      }
      
      // Fetch first if order is exist
      log('Request comes to get order details to update product details', JSON.stringify(reqBody))
      const selectPayload = {
        query: `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE  FulfillmentID=${reqBody.orderFullFillmentId}`,
      };
      log('Select query to fetch the orders', JSON.stringify(selectPayload))
      const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(
        selectPayload
      );
      log('Order Data', JSON.stringify(selectData));
      if(!selectData?.data.length){
        res.status(400).json({
          statusCode: 400,
          status: false,
          message: "Invalid order. Please try with valid order.",
        });
      }
      const orderDetails = selectData.data[0];
      // If order exist then find the product details
      const {skuCode, productCode} = reqBody;
      const searchListVirtualInventoryParams = {};
      if(skuCode!=""){
        searchListVirtualInventoryParams.sku_filter = [skuCode];
      }
      if(productCode!=""){
        searchListVirtualInventoryParams.product_code_filter = [productCode];
      }
      log('Request come to search product from virtual inventory for the payload', JSON.stringify(searchListVirtualInventoryParams));
      const getProductDetails = await finerworksService.LIST_VIRTUAL_INVENTORY(searchListVirtualInventoryParams);
      log('Get product details', JSON.stringify(getProductDetails));
      if(getProductDetails?.status?.success){
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
          custom_data_3: null
        }
        if(previousOrder?.order_items){
          previousOrder.order_items.push(orderData);
        }
        log('Previous order is', JSON.stringify(previousOrder));
        // update order 
        const urlEncodedData = urlEncodeJSON(previousOrder);
        const updatePayload = {
          tablename: process.env.FINER_fwAPI_FULFILLMENTS_TABLE,
          fieldupdates: `FulfillmentData='${urlEncodedData}'`,
          where: `FulfillmentID=${reqBody.orderFullFillmentId}`,
        };
        const updateQueryExecute = await finerworksService.UPDATE_QUERY_FINERWORKS(
          updatePayload
        );
        if(updateQueryExecute){
          res.status(200).json({
            statusCode: 200,
            status: true,
            message: "Orders have been successfully updated",
            data: previousOrder,
          });
        }else{
          res.status(400).json({
            statusCode: 400,
            status: true,
            message: "Something went wrong!"
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