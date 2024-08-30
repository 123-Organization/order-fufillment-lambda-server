const createEvent = require('../helpers/create-event');
const finerworksService = require('../helpers/finerworks-service');
const debug = require('debug');
const log = debug('app:uploadOrders');
log('Upload order');

exports.viewAllOrders = async (req, res) => {
    try {
        const reqBody = JSON.parse(JSON.stringify(req.body));
        if (!reqBody || !reqBody.accountId) {
            res.status(400).json({
                statusCode: 400,
                status: false,
                message: "Bad Request"
            });
        } else {
            const getAccountId = reqBody.accountId;
            const selectPayload = {
                "query": `SELECT * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE FulfillmentAccountID=${reqBody.accountId} AND FulfillmentSubmitted=1 ORDER BY FulfillmentID DESC`
            }
            const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(selectPayload);
            log("selectData", JSON.stringify(selectData));
            if (selectData) {
                let allOrders = [];
                selectData.data.forEach((order) => {
                    allOrders.push(urlDecodeJSON(order.FulfillmentData));
                })
                res.status(200).json({
                    statusCode: 200,
                    status: true,
                    message: "Orders Found",
                    data: allOrders
                });
            }
        }

    } catch (err) {

        throw (err);
    }
}
exports.uploadOrdersFromExcel = async (req, res) => {
    try {
        const reqBody = JSON.parse(JSON.stringify(req.body));
        if (!reqBody || !reqBody.orders || !reqBody.payment_token) {
            res.status(400).json({
                statusCode: 400,
                status: false,
                message: "Bad Request. Orders & payment token are required."
            });
        } else {
            const orders = reqBody.orders;
            const consolidatedOrdersData = consolidateOrderItems(orders);
            const payloadToBeSubmitted = {
                "orders": consolidatedOrdersData.orders,
                "validate_only": false,
                "payment_token": reqBody.payment_token

            }
            // insert to fineworks with FulfillmentSubmitted 0 //
            const urlEncodedData = urlEncodeJSON(payloadToBeSubmitted);
            const insertPayload = {
                "tablename": process.env.FINER_fwAPI_FULFILLMENTS_TABLE,
                "fields": "FulfillmentAccountID, FulfillmentData, FulfillmentSubmitted, FulfillmentAppName ",
                "values": `'${reqBody.accountId}', '${urlEncodedData}', 0, 'excel'`
            }
            log("insertPayload", JSON.stringify(insertPayload));
            const insertData = await finerworksService.INSERT_QUERY_FINERWORKS(insertPayload);
            log("insertData", JSON.stringify(insertData));
            if (insertData) {
                const submitOrders = await finerworksService.SUBMIT_ORDERS(payloadToBeSubmitted);
                log("submitOrders", JSON.stringify(submitOrders));
                // find Data 
                const selectPayload = {
                    "query": `SELECT TOP 1 * FROM ${process.env.FINER_fwAPI_FULFILLMENTS_TABLE} WHERE FulfillmentAccountID=${reqBody.accountId} AND FulfillmentAppName = 'excel' AND FulfillmentSubmitted=0 ORDER BY FulfillmentID DESC`
                }
                const selectData = await finerworksService.SELECT_QUERY_FINERWORKS(selectPayload);
                log("selectData", JSON.stringify(selectData));
                if (selectData.data.length) {
                    const getFullFillmentId = selectData?.data[0].FulfillmentID;
                    if (getFullFillmentId) {
                        const updatePayload = {
                            "tablename": process.env.FINER_fwAPI_FULFILLMENTS_TABLE,
                            "fieldupdates": "FulfillmentSubmitted=1",
                            "where": `FulfillmentID=${getFullFillmentId}`
                        }
                        const updateOrders = await finerworksService.UPDATE_QUERY_FINERWORKS(updatePayload);
                        log("updatePayload", JSON.stringify(updatePayload), JSON.stringify(updateOrders));
                    }
                }
                if (submitOrders) {
                    res.status(200).json({
                        statusCode: 200,
                        status: true,
                        message: "Orders have been submitted successfully",
                        data: submitOrders
                    });
                }
            }

        }

    } catch (error) {
        log("error during upload order", JSON.stringify(error));
        res.status(400).json({
            statusCode: 400,
            status: false,
            message: error,
        });
    }
};

function urlEncodeJSON(data) {
    const jsonString = JSON.stringify(data);
    const encodedString = encodeURIComponent(jsonString);
    return encodedString;
}

function urlDecodeJSON(data) {
    const decodedJsonString = decodeURIComponent(data);
    const decodedJsonObject = JSON.parse(decodedJsonString);
    return decodedJsonObject;
}

function consolidateOrderItems(ordersData) {
    const consolidatedOrders = {};

    ordersData.forEach(order => {
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


exports.getOrderPrice = async (req, res) => {
    try {
        const reqBody = JSON.parse(JSON.stringify(req.body));
        if (!reqBody || !reqBody.orderId) {
            res.status(400).json({
                statusCode: 400,
                status: false,
                message: "Bad Request"
            });
        }
        const getPricesData = await finerworksService.GET_ORDERS_PRICE(reqBody);
        if (getPricesData) {
            res.status(200).json({
                statusCode: 200,
                status: true,
                message: "Prices Found",
                data: getPricesData
            });
        } else {
            res.status(404).json({
                statusCode: 404,
                status: false,
                message: "Prices Not Found"
            });
        }
    } catch (err) {
        throw (err);
    }
}

exports.getProductDetails = async (req, res) => {
    try {
        const reqBody = JSON.parse(JSON.stringify(req.body));
        if (!reqBody) {
            res.status(400).json({
                statusCode: 400,
                status: false,
                message: "Bad Request"
            });
        } else {
            const getProductDetails = await finerworksService.GET_PRODUCTS_DETAILS(reqBody);
            if(!getProductDetails?.status){
                res.status(404).json({
                    statusCode: 404,
                    status: false,
                    message: "Product Details Not Found"
                });
            }
            let totalPrice = 0;
            if(getProductDetails){
                if(getProductDetails.product_list){
                    getProductDetails.product_list.forEach(product => {
                        totalPrice += product.total_price;
                    });
                }
            }
            if (getProductDetails) {
                res.status(200).json({
                    statusCode: 200,
                    status: true,
                    message: "Product Details Found",
                    data: getProductDetails,
                    totalPrice
                });
            } else {
                res.status(404).json({
                    statusCode: 404,
                    status: false,
                    message: "Product Details Not Found"
                });
            }
        }
    } catch (err) {
        // console.log('err', JSON.stringify(err));
        res.status(400).json({
            statusCode: 400,
            status: false,
            message: err.response.data,
        });
    }
}

exports.listShippingOptions = async(req,res) =>{
    try{
        const reqBody = JSON.parse(JSON.stringify(req.body));
        if (!reqBody) {
            res.status(400).json({
                statusCode: 400,
                status: false,
                message: "Bad Request"
            });
        } else {
            const getProductDetails = await finerworksService.SHIPPING_OPTIONS_MULTIPLE(reqBody);
            if (getProductDetails) {
                res.status(200).json({
                    statusCode: 200,
                    status: true,
                    data: getProductDetails
                });
            } else {
                res.status(404).json({
                    statusCode: 404,
                    status: false,
                    message: "Product Details Not Found"
                });
            }
        }
    }catch(err){
        res.status(400).json({
            statusCode: 400,
            status: false,
            message: err.response.data,
        });
    }
}