const axios = require('axios');
const crypto = require('crypto');
const finerworksService = require("../helpers/finerworks-service");

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

        return res.status(200).json({
            success: true,
            message: 'Authorization successful'
        });

    } catch (error) {
        console.error('Shopify auth error:', error);
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
        const filteredConnections = connections.filter(conn => conn.name === 'Shopify');
        console.log("filteredConnections=======", filteredConnections);
        if (filteredConnections.length > 0) {
            const shopifyIndex = connections.findIndex(conn => conn.name === 'Shopify');
            if (shopifyIndex !== -1) {
                const removedConnection = connections.splice(shopifyIndex, 1);
                console.log("Removed Shopify connection:", connections);
                await finerworksService.UPDATE_INFO({ account_key: account_key, connections: connections });
                // const payloadForCompanyInformation = {

                //     name: 'Shopify',
                //     id: queryParams.access_token,
                //     data: JSON.stringify(queryParams)

                // };
                // connections.push(payloadForCompanyInformation);

                // const payloadForCompanyInformationv2 = {
                //     account_key: account_key,
                //     connections: connections
                // };
                // console.log("payloadForCompanyInformation=======>>>>", payloadForCompanyInformationv2);
                // await finerworksService.UPDATE_INFO(payloadForCompanyInformationv2);


            }
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
        return res.redirect(authUrl);

    } catch (error) {
        console.error('Shopify install error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to initiate Shopify installation',
            error: error.message
        });
    }
};

module.exports = {
    handleShopifyAuth,
    handleShopifyCallback,
    handleShopifyInstall
};