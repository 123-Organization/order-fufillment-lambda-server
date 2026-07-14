const axios = require('axios');

const ACCOUNT_INFO_URL =
    process.env.WIX_ACCOUNT_INFO_URL ||
    process.env.SHOPIFY_ACCOUNT_INFO_URL ||
    'https://shopify.finerworks.com/api/account-info';

const ACCOUNT_INFO_SECRET =
    process.env.WIX_ACCOUNT_INFO_SECRET || process.env.SHOPIFY_ACCOUNT_INFO_SECRET || null;

/**
 * Resolve FinerWorks account_key for a Wix app instance id (when configured on account-info service).
 */
async function fetchAccountKeyByWixInstanceId(instanceId) {
    const id = String(instanceId || '').trim();
    if (!id) return null;

    const body = {
        instance_id: id,
        wix_instance_id: id,
        instanceId: id,
    };
    if (ACCOUNT_INFO_SECRET) body.secret = ACCOUNT_INFO_SECRET;

    try {
        const resp = await axios.post(ACCOUNT_INFO_URL, body, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
            validateStatus: () => true,
        });
        if (resp.status < 200 || resp.status >= 300) return null;
        const key = resp?.data?.account_key || resp?.data?.accountKey || null;
        return key ? String(key).trim() : null;
    } catch (_) {
        return null;
    }
}

module.exports = {
    fetchAccountKeyByWixInstanceId,
};