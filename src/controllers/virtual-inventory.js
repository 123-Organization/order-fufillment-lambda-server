const debug = require('debug');
const Joi = require('joi');
const log = debug('app:virtualInventory');
const finerworksService = require('../helpers/finerworks-service');
log('get virtual inventory api');
// # region Get Virtual Inventory
// Define the validation schema
const listVirtualInventorySchema = Joi.object({
    search_filter: Joi.string().allow(''),
    sku_filter: Joi.array().items(Joi.string()).allow(null),
    product_code_filter: Joi.array().items(Joi.string()).allow(null),
    guid_filter: Joi.array().items(Joi.string()).allow(null),
    page_number: Joi.number().integer().min(1).default(1),
    per_page: Joi.number().integer().min(1).default(10),
    sort_field: Joi.string().valid('id', 'name', 'created_at').default('id'),
    sort_direction: Joi.string().valid('ASC', 'DESC').default('DESC'),
    created_date_from: Joi.date().allow(null),
    created_date_to: Joi.date().allow(null),
    account_key: Joi.string().allow('').allow(null)
});
// Middleware for validation
exports.validateListVirtualInventory = async (req, res, next) => {
    const { error, value } = listVirtualInventorySchema.validate(req.body);
    if (error) {
        return res.status(400).json({
            statusCode: 400,
            status: false,
            message: error.details[0].message
        });
    }
    req.body = value;
    next();
};

/**
 * Retrieves detail of the product sku
 *
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @returns {Promise<void>} - A promise that resolves with the response.
 */
exports.getProductBySku = async (req, res) => {
    try {
        console.log('req.param.sku', req.params);
        const sku = [req.params.sku];
        const reqBody = {
            "sku_filter": sku
        }
        const getInformation = await finerworksService.LIST_VIRTUAL_INVENTORY(reqBody);
        if (getInformation && getInformation.status && getInformation.status.success) {
            res.status(200).json({
                statusCode: 200,
                status: true,
                data: getInformation?.products
            });
        } else {
            res.status(400).json({
                statusCode: 400,
                status: false,
                message: "Something went wrong"
            });
        }
    } catch (error) {
        log('Error while fetching list of virtual inventory : ', error);
        res.status(400).json({
            statusCode: 400,
            status: false,
            message: JSON.stringify(error),
        });
    }
};
// # endregion

/**
 * Retrieves a list of virtual inventory based on the provided filters.
 *
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @returns {Promise<void>} - A promise that resolves with the response.
 */
exports.listVirtualInventory = async (req, res) => {
    try {
        const reqBody = JSON.parse(JSON.stringify(req.body));
        const getInformation = await finerworksService.LIST_VIRTUAL_INVENTORY(reqBody);
        if (getInformation && getInformation.status && getInformation.status.success) {
            res.status(200).json({
                statusCode: 200,
                status: true,
                data: getInformation?.products,
                page_number: getInformation?.page_number,
                per_page: getInformation?.per_page,
                count: getInformation?.count
            });
        } else {
            res.status(400).json({
                statusCode: 400,
                status: false,
                message: "Something went wrong"
            });
        }
    } catch (error) {
        log('Error while fetching list of virtual inventory : ', error);
        res.status(400).json({
            statusCode: 400,
            status: false,
            message: JSON.stringify(error),
        });
    }
};


exports.listVirtualInventoryV2 = async (req, res) => {
    try {
        const reqBody = JSON.parse(JSON.stringify(req.body));
        const getInformation = await finerworksService.LIST_VIRTUAL_INVENTORY(reqBody);
        if (getInformation && getInformation.status && getInformation.status.success) {
            // res.status(200).json({
            //     statusCode: 200,
            //     status: true,
            //     data: getInformation,
            //     page_number: getInformation?.page_number,
            //     per_page: getInformation?.per_page,
            //     count: getInformation?.count
            // });
            res.status(200).json(getInformation);


        } else {
            res.status(400).json({
                statusCode: 400,
                status: false,
                message: "Something went wrong"
            });
        }
    } catch (error) {
        log('Error while fetching list of virtual inventory : ', error);
        res.status(400).json({
            statusCode: 400,
            status: false,
            message: JSON.stringify(error),
        });
    }
};
// # endregion


// # region Update Virtual Inventory
// Define the validation schema
const UpdateVirtualInventorySchema = Joi.object({
    virtual_inventory: Joi.array().items(
        Joi.object({
            sku: Joi.string().required(),
            asking_price: Joi.number().precision(2).optional(),
            name: Joi.string().required(),
            description: Joi.string().allow("").optional(),
            quantity_in_stock: Joi.number().integer().min(0).required(),
            track_inventory: Joi.boolean().required(),
            updated: Joi.string().optional(),
            third_party_integrations: Joi.object({
                etsy_product_id: Joi.any().allow(null).optional(),
                shopify_product_id: Joi.any().allow(null).optional(),
                shopify_variant_id: Joi.any().allow(null).optional(),
                squarespace_product_id: Joi.any().allow(null).optional(),
                squarespace_variant_id: Joi.any().allow(null).optional(),
                wix_inventory_id: Joi.any().allow(null).optional(),
                wix_product_id: Joi.any().allow(null).optional(),
                wix_variant_id: Joi.any().allow(null).optional(),
                woocommerce_product_id: Joi.any().allow(null).optional(),
                woocommerce_variant_id: Joi.any().allow(null).optional()
            }).required()
        })
    ).required(),
    account_key: Joi.string().optional()
});
// Middleware for validation
exports.validateUpdateVirtualInventory = async (req, res, next) => {
    const { error, value } = UpdateVirtualInventorySchema.validate(req.body);
    if (error) {
        return res.status(400).json({
            statusCode: 400,
            status: false,
            message: error.details[0].message
        });
    }
    req.body = value;
    next();
};
/**
 * Update list of virtual inventory.
 *
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @returns {Promise<void>} - A promise that resolves with the response.
 */
exports.updateVirtualInventory = async (req, res) => {
    try {
        const reqBody = JSON.parse(JSON.stringify(req.body));
        const getInformation = await finerworksService.UPDATE_VIRTUAL_INVENTORY(reqBody);
        if (getInformation && getInformation.status && getInformation.status.success) {
            res.status(200).json({
                statusCode: 200,
                status: true,
                data: getInformation?.skus_updated
            });
        } else {
            res.status(400).json({
                statusCode: 400,
                status: false,
                message: "Something went wrong"
            });
        }
    } catch (error) {
        res.status(400).json({
            statusCode: 400,
            status: false,
            message: JSON.stringify(error),
        });
    }
};
// # endregion

// # region Delete Virtual Inventory
const skusSchema = Joi.object({
    skus: Joi.array().items(Joi.string().required()).required(),
    account_key: Joi.string().required()
});
// Middleware for validation
exports.validateSkus = (req, res, next) => {
    const { error, value } = skusSchema.validate(req.body);
    if (error) {
        return res.status(400).json({
            statusCode: 400,
            status: false,
            message: error.details[0].message
        });
    }
    req.body = value;
    next();
};
/**
 * Delete list of virtual inventory.
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @returns {Promise<void>} - A promise that resolves with the response.
 */
exports.deleteVirtualInventory = async (req, res) => {
    try {
        const reqBody = JSON.parse(JSON.stringify(req.body));
        
        // First, check if there are any pending orders for these SKUs
        const pendingOrdersPayload = {
            skus: reqBody.skus,
            account_key: reqBody.account_key
        };
        
        let pendingOrdersResponse;
        let hasPendingOrders = false;
        
        try {
            pendingOrdersResponse = await finerworksService.LIST_PENDING_ORDERS(pendingOrdersPayload);
            console.log("pendingOrdersResponse=====", pendingOrdersResponse);
            
            // Check if there are any pending orders in the response
            if (pendingOrdersResponse && 
                ((pendingOrdersResponse.orders && Array.isArray(pendingOrdersResponse.orders) && pendingOrdersResponse.orders.length > 0) ||
                 (pendingOrdersResponse.data && Array.isArray(pendingOrdersResponse.data) && pendingOrdersResponse.data.length > 0) ||
                 (pendingOrdersResponse.status && pendingOrdersResponse.status.success && pendingOrdersResponse.orders && pendingOrdersResponse.orders.length > 0))) {
                hasPendingOrders = true;
            }
        } catch (error) {
            // If 404 error, it means no pending orders exist - treat as success and allow deletion
            if (error.response && error.response.status === 404) {
                console.log("404 received - no pending orders found, proceeding with deletion");
                hasPendingOrders = false;
            } else {
                // For other errors, rethrow to be handled by outer catch
                throw error;
            }
        }
        
        // If pending orders exist, block deletion
        if (hasPendingOrders) {
            return res.status(400).json({
                statusCode: 400,
                status: false,
                message: "SKUs cannot be deleted because they have pending orders"
            });
        }
        
        // If no pending orders (including 404 case), proceed with deletion
        const getInformation = await finerworksService.DELETE_VIRTUAL_INVENTORY(reqBody);
        console.log("getInformation====",getInformation);
        if (getInformation && getInformation.status && getInformation.status.success) {
            res.status(200).json({
                statusCode: 200,
                status: true,
                message: "Virtual inventory got deleted successfully"
            });
        } else {
            res.status(400).json({
                statusCode: 400,
                status: false,
                message: "Something went wrong"
            });
        }
    } catch (error) {
        res.status(400).json({
            statusCode: 400,
            status: false,
            message: JSON.stringify(error),
        });
    }
};
// # endregion