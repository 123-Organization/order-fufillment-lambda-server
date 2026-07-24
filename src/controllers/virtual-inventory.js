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
            const successLog = JSON.stringify({
                level: 'INFO',
                platform: 'finerworks',
                method: req.method,
                api: req.originalUrl || req.url,
                function: 'getProductBySku',
                operation: 'Product fetched by SKU successfully',
                account_key: req.body?.account_key || req.query?.account_key || 'unknown',
                result: { count: getInformation?.products?.length || 0 },
                timestamp: new Date().toISOString()
            });
            console.log(successLog);
            log('Success in getProductBySku: %s', successLog);
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
        const isFinerworksError = error?.response?.config?.url?.includes('finerworks.com') || error?.config?.url?.includes('finerworks.com');
        const errorJson = JSON.stringify({
            level: 'ERROR',
            platform: 'finerworks',
            source: isFinerworksError ? 'finerworks_api' : 'lambda',
            function: 'getProductBySku',
            account_key: req.body?.account_key || req.query?.account_key || 'unknown',
            httpStatus: error?.response?.status || null,
            message: `Failed to fetch product by SKU: ${error?.message || 'Unknown error'}`,
            detail: error?.response?.data?.message || error?.response?.data?.error || null,
            timestamp: new Date().toISOString()
        });
        console.error(errorJson);
        log('Formatted error in getProductBySku: %s', errorJson);
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
            const successLog = JSON.stringify({
                level: 'INFO',
                platform: 'finerworks',
                method: req.method,
                api: req.originalUrl || req.url,
                function: 'listVirtualInventory',
                operation: 'Virtual inventory list fetched successfully',
                account_key: req.body?.account_key || req.query?.account_key || 'unknown',
                result: { count: getInformation?.count, page_number: getInformation?.page_number, per_page: getInformation?.per_page },
                timestamp: new Date().toISOString()
            });
            console.log(successLog);
            log('Success in listVirtualInventory: %s', successLog);
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
        const isFinerworksError = error?.response?.config?.url?.includes('finerworks.com') || error?.config?.url?.includes('finerworks.com');
        const errorJson = JSON.stringify({
            level: 'ERROR',
            platform: 'finerworks',
            source: isFinerworksError ? 'finerworks_api' : 'lambda',
            function: 'listVirtualInventory',
            account_key: req.body?.account_key || req.query?.account_key || 'unknown',
            httpStatus: error?.response?.status || null,
            message: `Failed to fetch virtual inventory list: ${error?.message || 'Unknown error'}`,
            detail: error?.response?.data?.message || error?.response?.data?.error || null,
            timestamp: new Date().toISOString()
        });
        console.error(errorJson);
        log('Formatted error in listVirtualInventory: %s', errorJson);
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
            const successLog = JSON.stringify({
                level: 'INFO',
                platform: 'finerworks',
                method: req.method,
                api: req.originalUrl || req.url,
                function: 'listVirtualInventoryV2',
                operation: 'Virtual inventory V2 list fetched successfully',
                account_key: req.body?.account_key || req.query?.account_key || 'unknown',
                result: { count: getInformation?.count, page_number: getInformation?.page_number, per_page: getInformation?.per_page },
                timestamp: new Date().toISOString()
            });
            console.log(successLog);
            log('Success in listVirtualInventoryV2: %s', successLog);
            res.status(200).json({
                statusCode: 200,
                status: true,
                data: getInformation,
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
        const isFinerworksError = error?.response?.config?.url?.includes('finerworks.com') || error?.config?.url?.includes('finerworks.com');
        const errorJson = JSON.stringify({
            level: 'ERROR',
            platform: 'finerworks',
            source: isFinerworksError ? 'finerworks_api' : 'lambda',
            function: 'listVirtualInventoryV2',
            account_key: req.body?.account_key || req.query?.account_key || 'unknown',
            httpStatus: error?.response?.status || null,
            message: `Failed to fetch virtual inventory V2 list: ${error?.message || 'Unknown error'}`,
            detail: error?.response?.data?.message || error?.response?.data?.error || null,
            timestamp: new Date().toISOString()
        });
        console.error(errorJson);
        log('Formatted error in listVirtualInventoryV2: %s', errorJson);
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
                shopify_graphql_product_id: Joi.any().allow(null).optional(),
                shopify_graphql_variant_id: Joi.any().allow(null).optional(),
                shopify_product_id: Joi.any().allow(null).optional(),
                shopify_variant_id: Joi.any().allow(null).optional(),
                square_product_id: Joi.any().allow(null).optional(),
                square_variant_id: Joi.any().allow(null).optional(),
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
            const successLog = JSON.stringify({
                level: 'INFO',
                platform: 'finerworks',
                method: req.method,
                api: req.originalUrl || req.url,
                function: 'updateVirtualInventory',
                operation: 'Virtual inventory updated successfully',
                account_key: req.body?.account_key || req.query?.account_key || 'unknown',
                result: { skus_updated: getInformation?.skus_updated?.length || 0 },
                timestamp: new Date().toISOString()
            });
            console.log(successLog);
            log('Success in updateVirtualInventory: %s', successLog);
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
        const isFinerworksError = error?.response?.config?.url?.includes('finerworks.com') || error?.config?.url?.includes('finerworks.com');
        const errorJson = JSON.stringify({
            level: 'ERROR',
            platform: 'finerworks',
            source: isFinerworksError ? 'finerworks_api' : 'lambda',
            function: 'updateVirtualInventory',
            account_key: req.body?.account_key || req.query?.account_key || 'unknown',
            httpStatus: error?.response?.status || null,
            message: `Failed to update virtual inventory: ${error?.message || 'Unknown error'}`,
            detail: error?.response?.data?.message || error?.response?.data?.error || null,
            timestamp: new Date().toISOString()
        });
        console.error(errorJson);
        log('Formatted error in updateVirtualInventory: %s', errorJson);
        res.status(400).json({
            statusCode: 400,
            status: false,
            message: JSON.stringify(error),
        });
    }
};
// # endregion

// # region Update Woocommerce Product Id Mapping
const updateWoocommerceProductIdSchema = Joi.object({
    account_key: Joi.string().required(),
    products: Joi.array().items(
        Joi.object({
            sku: Joi.string().required(),
            woocommerce_product_id: Joi.string().required()
        })
    ).min(1).required()
});
// Middleware for validation
exports.validateUpdateWoocommerceProductId = async (req, res, next) => {
    const { error, value } = updateWoocommerceProductIdSchema.validate(req.body);
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
 * Updates the woocommerce_product_id mapping for a list of SKUs against a FinerWorks account.
 * SKUs that aren't found for the given account_key are not updated and are reported back
 * as unavailable_skus instead.
 *
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @returns {Promise<void>} - A promise that resolves with the response.
 */
exports.updateWoocommerceProductId = async (req, res) => {
    try {
        const { account_key, products } = req.body;
        const skuToWoocommerceId = products.reduce((acc, product) => {
            acc[product.sku] = product.woocommerce_product_id;
            return acc;
        }, {});
        const skuList = Object.keys(skuToWoocommerceId);

        const listInformation = await finerworksService.LIST_VIRTUAL_INVENTORY({ sku_filter: skuList, account_key });
        if (!(listInformation && listInformation.status && listInformation.status.success)) {
            return res.status(400).json({
                statusCode: 400,
                status: false,
                message: "Something went wrong while fetching virtual inventory"
            });
        }

        const foundProducts = listInformation?.products || [];
        const foundSkus = foundProducts.map((product) => product.sku);
        const unavailableSkus = skuList.filter((sku) => !foundSkus.includes(sku));

        if (foundProducts.length === 0) {
            return res.status(200).json({
                statusCode: 200,
                status: true,
                message: "None of the provided SKUs are available for this account",
                updated_skus: [],
                unavailable_skus: unavailableSkus
            });
        }

        const virtualInventoryPayload = foundProducts.map((product) => ({
            sku: product.sku,
            asking_price: product.asking_price ?? 0,
            name: product.name ?? 'Untitled',
            description: product.description ?? '',
            quantity_in_stock: product.quantity_in_stock ?? 0,
            track_inventory: product.track_inventory ?? true,
            third_party_integrations: {
                ...(product.third_party_integrations || {}),
                woocommerce_product_id: skuToWoocommerceId[product.sku]
            }
        }));

        const updateInformation = await finerworksService.UPDATE_VIRTUAL_INVENTORY({ virtual_inventory: virtualInventoryPayload, account_key });
        if (updateInformation && updateInformation.status && updateInformation.status.success) {
            const successLog = JSON.stringify({
                level: 'INFO',
                platform: 'finerworks',
                method: req.method,
                api: req.originalUrl || req.url,
                function: 'updateWoocommerceProductId',
                operation: 'Woocommerce product id mapping updated successfully',
                account_key: account_key || 'unknown',
                result: { updated: foundSkus.length, unavailable: unavailableSkus.length },
                timestamp: new Date().toISOString()
            });
            console.log(successLog);
            log('Success in updateWoocommerceProductId: %s', successLog);
            return res.status(200).json({
                statusCode: 200,
                status: true,
                message: unavailableSkus.length
                    ? "Woocommerce product ids updated for available SKUs; some SKUs are not available for this account"
                    : "Woocommerce product ids updated successfully",
                updated_skus: updateInformation?.skus_updated || foundSkus,
                unavailable_skus: unavailableSkus
            });
        } else {
            return res.status(400).json({
                statusCode: 400,
                status: false,
                message: "Something went wrong while updating virtual inventory"
            });
        }
    } catch (error) {
        log('Error while updating woocommerce product id mapping : ', error);
        const isFinerworksError = error?.response?.config?.url?.includes('finerworks.com') || error?.config?.url?.includes('finerworks.com');
        const errorJson = JSON.stringify({
            level: 'ERROR',
            platform: 'finerworks',
            source: isFinerworksError ? 'finerworks_api' : 'lambda',
            function: 'updateWoocommerceProductId',
            account_key: req.body?.account_key || req.query?.account_key || 'unknown',
            httpStatus: error?.response?.status || null,
            message: `Failed to update woocommerce product id mapping: ${error?.message || 'Unknown error'}`,
            detail: error?.response?.data?.message || error?.response?.data?.error || null,
            timestamp: new Date().toISOString()
        });
        console.error(errorJson);
        log('Formatted error in updateWoocommerceProductId: %s', errorJson);
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
            const successLog = JSON.stringify({
                level: 'INFO',
                platform: 'finerworks',
                method: req.method,
                api: req.originalUrl || req.url,
                function: 'deleteVirtualInventory',
                operation: 'Virtual inventory deleted successfully',
                account_key: req.body?.account_key || req.query?.account_key || 'unknown',
                result: { deleted: true },
                timestamp: new Date().toISOString()
            });
            console.log(successLog);
            log('Success in deleteVirtualInventory: %s', successLog);
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
        const isFinerworksError = error?.response?.config?.url?.includes('finerworks.com') || error?.config?.url?.includes('finerworks.com');
        const errorJson = JSON.stringify({
            level: 'ERROR',
            platform: 'finerworks',
            source: isFinerworksError ? 'finerworks_api' : 'lambda',
            function: 'deleteVirtualInventory',
            account_key: req.body?.account_key || req.query?.account_key || 'unknown',
            httpStatus: error?.response?.status || null,
            message: `Failed to delete virtual inventory: ${error?.message || 'Unknown error'}`,
            detail: error?.response?.data?.message || error?.response?.data?.error || null,
            timestamp: new Date().toISOString()
        });
        console.error(errorJson);
        log('Formatted error in deleteVirtualInventory: %s', errorJson);
        res.status(400).json({
            statusCode: 400,
            status: false,
            message: JSON.stringify(error),
        });
    }
};
// # endregion