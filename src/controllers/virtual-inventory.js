const debug = require('debug');
const axios = require('axios');
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
                shopify_graphql_product_id: Joi.any().allow(null).optional(),
                shopify_graphql_variant_id: Joi.any().allow(null).optional(),
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

const normalizeShopDomain = (shop) => {
    const raw = shop != null ? String(shop).trim() : '';
    if (!raw) return '';
    if (raw.includes('.')) return raw;
    return `${raw}.myshopify.com`;
};

const resolveShopifyAuthByAccountKey = async (accountKey) => {
    const accountInfo = await finerworksService.GET_INFO({ account_key: accountKey });
    const connections = accountInfo?.user_account?.connections;
    const shopifyConn =
        Array.isArray(connections) && connections.find((c) => c?.name === 'Shopify');

    if (!shopifyConn) return null;

    const data =
        typeof shopifyConn.data === 'string'
            ? (() => {
                try {
                    return JSON.parse(shopifyConn.data);
                } catch (e) {
                    return null;
                }
            })()
            : shopifyConn.data;

    const shop = data?.shop || data?.shop_domain || data?.myshopify_domain || null;
    const shopDomain = normalizeShopDomain(shop);

    const accessToken =
        data?.access_token ||
        data?.accessToken ||
        shopifyConn?.id ||
        null;

    return shopDomain && accessToken ? { shopDomain, accessToken } : null;
};

const skuExistsInShopifyOrders = async ({ shopDomain, accessToken, apiVersion, sku }) => {
    const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
    const headers = {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json'
    };

    // Shopify order search supports `sku:` query for line item SKUs in many configurations.
    const query = `
      query {
        orders(first: 1, query: "sku:${String(sku).replace(/"/g, '')}") {
          edges {
            node { id }
          }
        }
      }
    `;

    const resp = await axios.post(endpoint, { query, variables: {} }, { headers });

    if (resp.data?.errors) {
        const msg = Array.isArray(resp.data.errors)
            ? resp.data.errors.map((e) => e.message).join('; ')
            : 'Unknown GraphQL error';
        throw new Error(msg);
    }

    const edges = resp.data?.data?.orders?.edges;
    return Array.isArray(edges) && edges.length > 0;
};

const normalizeShopifyProductGid = (productId) => {
    if (!productId) return null;
    const raw = String(productId).trim();
    if (!raw) return null;
    if (raw.startsWith('gid://shopify/Product/')) return raw;
    if (/^\d+$/.test(raw)) return `gid://shopify/Product/${raw}`;
    return null;
};

const escapeGraphqlString = (str) =>
    String(str)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');

const markShopifyProductAsDeletedFromFinerworks = async ({
    shopDomain,
    accessToken,
    apiVersion,
    shopifyProductId
}) => {
    const productGid = normalizeShopifyProductGid(shopifyProductId);
    if (!productGid) return { updated: false, reason: 'missing_product_id' };

    const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
    const headers = {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json'
    };

    const productQuery = `
      query {
        product(id: "${escapeGraphqlString(productGid)}") {
          id
          tags
        }
      }
    `;
    const productResp = await axios.post(endpoint, { query: productQuery, variables: {} }, { headers });
    if (productResp.data?.errors) {
        const msg = Array.isArray(productResp.data.errors)
            ? productResp.data.errors.map((e) => e.message).join('; ')
            : 'Unknown GraphQL error';
        throw new Error(msg);
    }

    const product = productResp.data?.data?.product;
    if (!product?.id) return { updated: false, reason: 'product_not_found' };

    const existingTags = Array.isArray(product.tags) ? product.tags : [];
    const deleteTag = 'deleted from Finer wokrs';
    const mergedTags = Array.from(new Set([...existingTags, deleteTag]));
    const tagsLiteral = mergedTags.map((t) => `"${escapeGraphqlString(t)}"`).join(', ');

    // Keep this focused on tagging (admin visibility isn't the real storefront control).
    const mutation = `
      mutation {
        productUpdate(input: {
          id: "${escapeGraphqlString(product.id)}",
          status: DRAFT,
          tags: [${tagsLiteral}]
        }) {
          product {
            id
            tags
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const resp = await axios.post(endpoint, { query: mutation, variables: {} }, { headers });
    if (resp.data?.errors) {
        const msg = Array.isArray(resp.data.errors)
            ? resp.data.errors.map((e) => e.message).join('; ')
            : 'Unknown GraphQL error';
        throw new Error(msg);
    }

    const updateData = resp.data?.data?.productUpdate;
    if (Array.isArray(updateData?.userErrors) && updateData.userErrors.length > 0) {
        const errMsg = updateData.userErrors.map((e) => `${e.field}: ${e.message}`).join('; ');
        throw new Error(errMsg);
    }

    // Best-effort: unpublish from "Online Store" so customers cannot add to cart.
    // Even if product status still looks "active" in dashboard, unpublishing removes it from storefront.
    try {
        const publicationsQuery = `
          query {
            publications(first: 20) {
              edges {
                node {
                  id
                  name
                }
              }
            }
          }
        `;

        const pubsResp = await axios.post(
            endpoint,
            { query: publicationsQuery, variables: {} },
            { headers }
        );

        const pubsErrors = pubsResp.data?.errors;
        if (!pubsErrors) {
            const edges = pubsResp.data?.data?.publications?.edges || [];
            const onlineStorePub = edges
                .map((e) => e?.node)
                .find((n) => n?.name && String(n.name).toLowerCase() === 'online store') ||
                edges
                    .map((e) => e?.node)
                    .find((n) => n?.name && String(n.name).toLowerCase().includes('online store'));

            if (onlineStorePub?.id) {
                const unpublishMutation = `
                  mutation {
                    publishableUnpublish(
                      id: "${escapeGraphqlString(product.id)}",
                      input: [{ publicationId: "${escapeGraphqlString(onlineStorePub.id)}" }]
                    ) {
                      userErrors {
                        field
                        message
                      }
                    }
                  }
                `;

                const unpubResp = await axios.post(
                    endpoint,
                    { query: unpublishMutation, variables: {} },
                    { headers }
                );

                const unpubErrors = unpubResp.data?.errors;
                if (!unpubErrors && Array.isArray(unpubResp.data?.data?.publishableUnpublish?.userErrors)) {
                    const userErrors = unpubResp.data.data.publishableUnpublish.userErrors;
                    if (userErrors.length > 0) {
                        // Don't block deletion if unpublish fails; just surface best-effort logs.
                        console.log('publishableUnpublish userErrors:', userErrors);
                    }
                }
            }
        }
    } catch (unpublishErr) {
        console.log('publishableUnpublish failed (best-effort):', unpublishErr?.message);
    }

    return { updated: true, product: updateData?.product || null };
};

const markSkusAsDeletedFromFinerworks = async ({ accountKey, skus }) => {
    // Mimics the "disconnect" behavior by clearing Shopify GraphQL product id linkage in FinerWorks.
    const apiVersion = process.env.SHOPIFY_API_VERSION || '2025-10';
    const shopifyAuth = await resolveShopifyAuthByAccountKey(accountKey);

    for (const sku of skus) {
        const listResp = await finerworksService.LIST_VIRTUAL_INVENTORY({
            sku_filter: [sku],
            account_key: accountKey
        });

        const current = Array.isArray(listResp?.products) ? listResp.products[0] : null;
        const integrations = current?.third_party_integrations || {};
        const shopifyProductId =
            integrations?.shopify_graphql_product_id ||
            integrations?.shopify_product_id ||
            null;

        if (shopifyAuth && shopifyProductId) {
            await markShopifyProductAsDeletedFromFinerworks({
                shopDomain: shopifyAuth.shopDomain,
                accessToken: shopifyAuth.accessToken,
                apiVersion,
                shopifyProductId
            });
        }

        const item = current
            ? {
                sku: current.sku,
                asking_price: current.asking_price || 0,
                name: current.name || "Untitled",
                description: current.description ?? '',
                quantity_in_stock: current.quantity_in_stock || 0,
                track_inventory: current.track_inventory ?? true,
                third_party_integrations: {
                    ...(current.third_party_integrations || {}),
                    shopify_graphql_product_id: null
                }
            }
            : {
                sku,
                third_party_integrations: {
                    shopify_graphql_product_id: null
                }
            };

        const updatePayload = {
            virtual_inventory: [item],
            account_key: accountKey
        };
        await finerworksService.UPDATE_VIRTUAL_INVENTORY(updatePayload);
    }
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
        console.log("reqBody================",reqBody)
        
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

        // Block deletion if these SKUs already exist in any Shopify order.
        const apiVersion = process.env.SHOPIFY_API_VERSION || '2025-10';
        const shopifyAuth = await resolveShopifyAuthByAccountKey(reqBody.account_key);
        console.log("shopifyAuth====>>>>",shopifyAuth);
        if (!shopifyAuth) {
            return res.status(400).json({
                statusCode: 400,
                status: false,
                message: "Shopify connection not found for this account_key"
            });
        }

        const skusFoundInShopifyOrders = [];
        for (const sku of reqBody.skus) {
            // Ignore empty/invalid SKUs defensively (schema should already validate).
            if (sku == null || String(sku).trim().length === 0) continue;

            const exists = await skuExistsInShopifyOrders({
                shopDomain: shopifyAuth.shopDomain,
                accessToken: shopifyAuth.accessToken,
                apiVersion,
                sku
            });

            if (exists) skusFoundInShopifyOrders.push(sku);
        }
        console.log("skusFoundInShopifyOrders====>>>",skusFoundInShopifyOrders);

        if (skusFoundInShopifyOrders.length > 0) {
            return res.status(400).json({
                statusCode: 400,
                status: false,
                message: "SKUs cannot be deleted because they already exist in Shopify orders",
                skus: skusFoundInShopifyOrders
            });
        }
        // If no pending orders (including 404 case), proceed with deletion
        await markSkusAsDeletedFromFinerworks({ accountKey: reqBody.account_key, skus: reqBody.skus });

        const getInformation = await finerworksService.DELETE_VIRTUAL_INVENTORY(reqBody);
        console.log("getInformation====", getInformation);
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