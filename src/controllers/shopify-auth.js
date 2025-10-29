const axios = require('axios');
const crypto = require('crypto');
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

module.exports = {
    handleShopifyAuth
};