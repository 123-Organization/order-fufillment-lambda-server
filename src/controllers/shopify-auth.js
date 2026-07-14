const axios = require('axios');
const crypto = require('crypto');
const finerworksService = require("../helpers/finerworks-service");
const debug = require('debug');
const log = debug('app:shopifyAuth');
const { sendApiError } = require('../helpers/api-error');

require('dotenv').config();

const validateHmac = (query) => {
    // Remove the HMAC from the query parameters
    const { hmac, ...restParams } = query;
    if (!hmac) return false;

    // Sort and combine the remaining parameters
    const sortedParams = Object.keys(restParams)
        .sort()
        .map(key => `${key}=${restParams[key]}`)
        .join('&');

    // Calculate HMAC using the app's secret key
    const calculatedHmac = crypto
        .createHmac('sha256', process.env.SHOPIFY_CLIENT_SECRET)
        .update(sortedParams)
        .digest('hex');

    // Compare the calculated HMAC with the one from the query
    return crypto.timingSafeEqual(
        Buffer.from(hmac),
        Buffer.from(calculatedHmac)
    );
};

const handleShopifyAuth = async (req, res) => {
    try {
        const { code, shop, hmac } = req.query;

        if (!code || !shop || !hmac) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameters'
            });
        }

        // Validate the HMAC
        if (!validateHmac(req.query)) {
            return res.status(401).json({
                success: false,
                message: 'Invalid HMAC. Request could not be verified'
            });
        }

        // Validate the shop domain
        if (!shop.match(/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid shop domain'
            });
        }

        const response = await axios.post(`https://${shop}/admin/oauth/access_token`, {
            client_id: process.env.SHOPIFY_CLIENT_ID,
            client_secret: process.env.SHOPIFY_CLIENT_SECRET,
            code: code
        });

        console.log('Shopify Access Token:', response.data.access_token);
        const successLog = JSON.stringify({
            level: 'INFO',
            platform: 'shopify',
            method: req.method,
            api: req.originalUrl || req.url,
            function: 'handleShopifyAuth',
            operation: 'Shopify OAuth token exchange completed successfully',
            shop: shop || 'unknown',
            result: { authorized: true },
            timestamp: new Date().toISOString()
        });
        console.log(successLog);
        log('Success in handleShopifyAuth: %s', successLog);
        return res.status(200).json({
            success: true,
            message: 'Authorization successful'
        });

    } catch (error) {
        console.error('Shopify auth error:', error);
        const errorJson = JSON.stringify({
            level: 'ERROR',
            platform: 'shopify',
            source: 'shopify_api',
            function: 'handleShopifyAuth',
            shop: req.query?.shop || 'unknown',
            httpStatus: error?.response?.status || null,
            message: `Shopify OAuth token exchange failed: ${error?.message || 'Unknown error'}`,
            detail: error?.response?.data?.error_description || error?.response?.data?.error || null,
            timestamp: new Date().toISOString()
        });
        console.error(errorJson);
        log('Formatted error in handleShopifyAuth: %s', errorJson);
        return res.status(500).json({
            success: false,
            message: 'Failed to authorize with Shopify'
        });
    }
};

const handleShopifyCallback = async (req, res) => {
    try {
        // Get all query parameters
        const queryParams = req.body;
        const account_key = queryParams.account_key;
        delete queryParams.scope;
        delete queryParams.account_key;
        delete queryParams.timestamp;
        // delete queryParams.shop_info;
        console.log("queryParams=======", queryParams);

        const getInformation = await finerworksService.GET_INFO({ account_key: account_key });
        console.log("getInformation=======", getInformation.user_account.connections);
        const connections = getInformation.user_account.connections;
        if (connections === null) {
            const payloadForCompanyInformation = {

                name: 'Shopify',
                id: queryParams.access_token,
                data: JSON.stringify(queryParams)

            };
            const connections2 = []
            connections2.push(payloadForCompanyInformation);
            const payloadForCompanyInformationv2 = {
                account_key: account_key,
                connections: connections2
            };
            console.log("payloadForCompanyInformation=======>>>>", payloadForCompanyInformationv2);
            await finerworksService.UPDATE_INFO(payloadForCompanyInformationv2);
            const newConnSuccessLog = JSON.stringify({
                level: 'INFO',
                platform: 'shopify',
                method: req.method,
                api: req.originalUrl || req.url,
                function: 'handleShopifyCallback',
                operation: 'Shopify connection added successfully (new connections list)',
                account_key: account_key || 'unknown',
                result: { shop: queryParams.shop || 'unknown', added: true },
                timestamp: new Date().toISOString()
            });
            console.log(newConnSuccessLog);
            log('Success in handleShopifyCallback: %s', newConnSuccessLog);
            return res.status(200).json({
                success: true,
                message: 'Shopify connection added successfully'
            });
        }
        const filteredConnections = connections.filter(conn => conn.name === 'Shopify');
        console.log("filteredConnections=======", filteredConnections);
        if (filteredConnections.length > 0) {
            const shopifyIndex = connections.findIndex(conn => conn.name === 'Shopify');
            if (shopifyIndex !== -1) {
                connections.splice(shopifyIndex, 1);
                console.log("Removed Shopify connection:", connections);
                await finerworksService.UPDATE_INFO({ account_key: account_key, connections: connections });
                const payloadForCompanyInformation = {

                    name: 'Shopify',
                    id: queryParams.access_token,
                    data: JSON.stringify(queryParams)

                };
                connections.push(payloadForCompanyInformation);

                const payloadForCompanyInformationv2 = {
                    account_key: account_key,
                    connections: connections
                };
                console.log("payloadForCompanyInformation=======>>>>", payloadForCompanyInformationv2);
                await finerworksService.UPDATE_INFO(payloadForCompanyInformationv2);


            }
            const existingConnSuccessLog = JSON.stringify({
                level: 'INFO',
                platform: 'shopify',
                method: req.method,
                api: req.originalUrl || req.url,
                function: 'handleShopifyCallback',
                operation: 'Shopify connection updated (existing connection replaced)',
                account_key: account_key || 'unknown',
                result: { shop: queryParams.shop || 'unknown', updated: true },
                timestamp: new Date().toISOString()
            });
            console.log(existingConnSuccessLog);
            log('Success in handleShopifyCallback: %s', existingConnSuccessLog);
            return res.status(200).json({
                success: true,
                message: 'Shopify connection already exists'
            });

        } else {
            const payloadForCompanyInformation = {

                name: 'Shopify',
                id: queryParams.access_token,
                data: JSON.stringify(queryParams)

            };
            connections.push(payloadForCompanyInformation);

            const payloadForCompanyInformationv2 = {
                account_key: account_key,
                connections: connections
            };
            console.log("payloadForCompanyInformation=======>>>>", payloadForCompanyInformationv2);
            await finerworksService.UPDATE_INFO(payloadForCompanyInformationv2);
            const addedConnSuccessLog = JSON.stringify({
                level: 'INFO',
                platform: 'shopify',
                method: req.method,
                api: req.originalUrl || req.url,
                function: 'handleShopifyCallback',
                operation: 'Shopify connection added successfully',
                account_key: account_key || 'unknown',
                result: { shop: queryParams.shop || 'unknown', added: true },
                timestamp: new Date().toISOString()
            });
            console.log(addedConnSuccessLog);
            log('Success in handleShopifyCallback: %s', addedConnSuccessLog);
            return res.status(200).json({
                success: true,
                message: 'Shopify connection added successfully'
            });
        }


        // Return all query parameters in the response
        // return res.status(200).json({
        //     success: true,
        //     message: 'Shopify callback received',
        //     queryParameters: queryParams,
        //     rawQuery: req.url.split('?')[1] || ''
        // });

    } catch (error) {
        console.error('Shopify callback error:', error);
        const errorJson = JSON.stringify({
            level: 'ERROR',
            platform: 'shopify',
            source: 'finerworks_api',
            function: 'handleShopifyCallback',
            account_key: req.body?.account_key || 'unknown',
            httpStatus: error?.response?.status || null,
            message: `Failed to save Shopify connection to FinerWorks: ${error?.message || 'Unknown error'}`,
            detail: error?.response?.data?.message || null,
            timestamp: new Date().toISOString()
        });
        console.error(errorJson);
        log('Formatted error in handleShopifyCallback: %s', errorJson);
        return res.status(500).json({
            success: false,
            message: 'Failed to process Shopify callback',
            error: error.message
        });
    }
};

const handleShopifyInstall = async (req, res) => {
    try {
        const { shop } = req.query;

        // Validate shop parameter
        if (!shop) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameter: shop'
            });
        }

        // Normalize shop domain (add .myshopify.com if not present)
        let shopDomain = shop;
        if (!shopDomain.includes('.')) {
            shopDomain = `${shopDomain}.myshopify.com`;
        }

        // Validate the shop domain format
        if (!shopDomain.match(/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid shop domain format. Expected: shopname.myshopify.com'
            });
        }

        // Check for required environment variables
        if (!process.env.SHOPIFY_CLIENT_ID) {
            return res.status(500).json({
                success: false,
                message: 'Shopify Client ID not configured'
            });
        }

        // Generate a random state/nonce for CSRF protection
        const state = crypto.randomBytes(16).toString('hex');

        // Determine redirect URI (use callback endpoint or environment variable)
        const redirectUri = process.env.SHOPIFY_REDIRECT_URI ||
            `${req.protocol}://${req.get('host')}/shopify/callback`;

        // Define required scopes (adjust based on your app's needs)
        const scopes = process.env.SHOPIFY_SCOPES || 'read_products,write_products,read_orders,write_orders';

        // Construct Shopify OAuth authorization URL
        const authUrl = `https://${shopDomain}/admin/oauth/authorize?` +
            `client_id=${process.env.SHOPIFY_CLIENT_ID}&` +
            `scope=${encodeURIComponent(scopes)}&` +
            `redirect_uri=${encodeURIComponent(redirectUri)}&` +
            `state=${state}`;
        console.log("authUrl==========", authUrl);
        console.log(`Redirecting to Shopify OAuth for shop: ${shopDomain}`);

        // Redirect user to Shopify authorization page
        const successLog = JSON.stringify({
            level: 'INFO',
            platform: 'shopify',
            method: req.method,
            api: req.originalUrl || req.url,
            function: 'handleShopifyInstall',
            operation: 'Shopify install OAuth redirect initiated successfully',
            shop: shopDomain,
            result: { scopes, redirectUri },
            timestamp: new Date().toISOString()
        });
        console.log(successLog);
        log('Success in handleShopifyInstall: %s', successLog);
        return res.redirect(authUrl);

    } catch (error) {
        console.error('Shopify install error:', error);
        const errorJson = JSON.stringify({
            level: 'ERROR',
            platform: 'shopify',
            source: 'lambda',
            function: 'handleShopifyInstall',
            shop: req.query?.shop || 'unknown',
            message: `Shopify install redirect failed: ${error?.message || 'Unknown error'}`,
            timestamp: new Date().toISOString()
        });
        console.error(errorJson);
        log('Formatted error in handleShopifyInstall: %s', errorJson);
        return sendApiError(res, error);
    }
};

/**
 * Shopify disconnection: fetches user info, finds Shopify in connections array,
 * replaces that entire connection object with a disconnected placeholder, then calls UPDATE_INFO.
 * Expects body: { account_key: string }
 */
const handleShopifyDisconnect = async (req, res) => {
    try {
        const account_key = req.body?.account_key;
        if (!account_key) {
            return sendApiError(res, 400, 'Missing required parameter: account_key');
        }

        const getInformation = await finerworksService.GET_INFO({ account_key });
        const connections = JSON.parse(JSON.stringify(getInformation?.user_account?.connections || []));

        const shopifyIndex = connections.findIndex((conn) => conn && conn.name === 'Shopify');
        if (shopifyIndex === -1) {
            const notFoundLog = JSON.stringify({
                level: 'INFO',
                platform: 'shopify',
                method: req.method,
                api: req.originalUrl || req.url,
                function: 'handleShopifyDisconnect',
                operation: 'Shopify disconnect — no Shopify connection found, nothing to disconnect',
                account_key: account_key || 'unknown',
                result: { found: false },
                timestamp: new Date().toISOString()
            });
            console.log(notFoundLog);
            log('Success in handleShopifyDisconnect: %s', notFoundLog);
            return res.status(200).json({
                success: true,
                message: 'No Shopify connection found; nothing to disconnect',
                connections,
            });
        }

        // Replace the entire Shopify connection object with a disconnected placeholder
        const disconnectedShopify = {
            name: 'Shopify',
            id: null,
            data: null,
        };

        // const disconnectedShopify = {
        //     name: 'Shopify',
        //     id: "shpua_21b9a9a7ddd62df22cd585137b03d010",
        //     data: "{\"shop\":\"finerworks-dev-3.myshopify.com\",\"access_token\":\"shpua_21b9a9a7ddd62df22cd585137b03d010\"}"
        // };

        connections[shopifyIndex] = disconnectedShopify;

        await finerworksService.UPDATE_INFO({
            account_key,
            connections,
        });

        const successLog = JSON.stringify({
            level: 'INFO',
            platform: 'shopify',
            method: req.method,
            api: req.originalUrl || req.url,
            function: 'handleShopifyDisconnect',
            operation: 'Shopify disconnected successfully',
            account_key: account_key || 'unknown',
            result: { disconnected: true },
            timestamp: new Date().toISOString()
        });
        console.log(successLog);
        log('Success in handleShopifyDisconnect: %s', successLog);
        return res.status(200).json({
            success: true,
            message: 'Shopify disconnected successfully',
            connections,
        });
    } catch (error) {
        const errorJson = JSON.stringify({
            level: 'ERROR',
            platform: 'shopify',
            source: 'finerworks_api',
            function: 'handleShopifyDisconnect',
            account_key: req.body?.account_key || 'unknown',
            httpStatus: error?.response?.status || null,
            message: `Failed to disconnect Shopify — FinerWorks update error: ${error?.message || 'Unknown error'}`,
            detail: error?.response?.data?.message || null,
            timestamp: new Date().toISOString()
        });
        console.error(errorJson);
        log('Formatted error in handleShopifyDisconnect: %s', errorJson);
        return sendApiError(res, error);
    }
};

/**
 * Disconnect Shopify from OFA: first calls shopify.finerworks.com disconnect API;
 * if it returns success, updates user connections so Shopify has id and data set to null.
 * Expects body: { shop: string, secret: string, account_key: string }
 */
const disconnectShopifyFromOfa = async (req, res) => {
    try {
        const { storeName, account_key } = req.body || {};
        if (!storeName) {
            return sendApiError(res, 400, 'Missing required parameters: shop and secret');
        }
        if (!account_key) {
            return sendApiError(res, 400, 'Missing required parameter: account_key');
        }
        console.log('hello');

        let disconnectResponse;
        try {
            disconnectResponse = await axios.post(
                'https://shopify.finerworks.com/api/disconnect',
                { shop: storeName, secret: process.env.SECRET },
                { headers: { 'Content-Type': 'application/json' } }
            );
        } catch (disconnectErr) {
            const errorJson = JSON.stringify({
                level: 'ERROR',
                platform: 'shopify',
                source: 'shopify_api',
                function: 'disconnectShopifyFromOfa',
                storeName: storeName || 'unknown',
                account_key: account_key || 'unknown',
                httpStatus: disconnectErr?.response?.status || null,
                message: `Shopify disconnect API call to shopify.finerworks.com failed: ${disconnectErr?.message || 'Unknown error'}`,
                detail: disconnectErr?.response?.data?.message || null,
                timestamp: new Date().toISOString()
            });
            console.error(errorJson);
            log('Formatted error in disconnectShopifyFromOfa: %s', errorJson);
            throw disconnectErr;
        }
        console.log('disconnectResponse===', disconnectResponse);
        const success = disconnectResponse?.data?.success === true;
        if (!success) {
            return sendApiError(res, 400, 'Disconnect API did not return success');
        }

        const getInformation = await finerworksService.GET_INFO({ account_key });
        const connections = JSON.parse(JSON.stringify(getInformation?.user_account?.connections || []));

        const shopifyIndex = connections.findIndex((conn) => conn && conn.name === 'Shopify');
        if (shopifyIndex === -1) {
            const noLocalLog = JSON.stringify({
                level: 'INFO',
                platform: 'shopify',
                method: req.method,
                api: req.originalUrl || req.url,
                function: 'disconnectShopifyFromOfa',
                operation: 'Shopify disconnected on remote; no local connection found',
                account_key: account_key || 'unknown',
                result: { storeName, remoteDisconnected: true, localFound: false },
                timestamp: new Date().toISOString()
            });
            console.log(noLocalLog);
            log('Success in disconnectShopifyFromOfa: %s', noLocalLog);
            return res.status(200).json({
                success: true,
                message: 'Shopify disconnected on remote; no Shopify connection found locally',
                connections,
            });
        }

        const disconnectedShopify = {
            name: 'Shopify',
            id: null,
            data: null,
        };
        connections[shopifyIndex] = disconnectedShopify;

        await finerworksService.UPDATE_INFO({
            account_key,
            connections,
        });

        const successLog = JSON.stringify({
            level: 'INFO',
            platform: 'shopify',
            method: req.method,
            api: req.originalUrl || req.url,
            function: 'disconnectShopifyFromOfa',
            operation: 'Shopify disconnected from OFA successfully',
            account_key: account_key || 'unknown',
            result: { storeName, remoteDisconnected: true, localDisconnected: true },
            timestamp: new Date().toISOString()
        });
        console.log(successLog);
        log('Success in disconnectShopifyFromOfa: %s', successLog);
        return res.status(200).json({
            success: true,
            message: 'Shopify disconnected from OFA successfully',
            connections,
        });
    } catch (error) {
        const errorJson = JSON.stringify({
            level: 'ERROR',
            platform: 'shopify',
            source: 'finerworks_api',
            function: 'disconnectShopifyFromOfa',
            account_key: req.body?.account_key || 'unknown',
            storeName: req.body?.storeName || 'unknown',
            httpStatus: error?.response?.status || null,
            message: `Shopify OFA disconnect failed — FinerWorks update error: ${error?.message || 'Unknown error'}`,
            detail: error?.response?.data?.message || null,
            timestamp: new Date().toISOString()
        });
        console.error(errorJson);
        log('Formatted error in disconnectShopifyFromOfa: %s', errorJson);
        return sendApiError(res, error);
    }
};

module.exports = {
    handleShopifyAuth,
    handleShopifyCallback,
    handleShopifyInstall,
    handleShopifyDisconnect,
    disconnectShopifyFromOfa,
};