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
    account_key:Joi.string().allow('').allow(null)
});
// Middleware for validation
exports.validateListVirtualInventory = async(req, res, next) => {
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
    ).required()
});
// Middleware for validation
exports.validateUpdateVirtualInventory = async(req, res, next) => {
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
    skus: Joi.array().items(Joi.string().required()).required()
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
        const getInformation = await finerworksService.DELETE_VIRTUAL_INVENTORY(reqBody);
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