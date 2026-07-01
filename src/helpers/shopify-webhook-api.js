const axios = require('axios');

const WEBHOOK_SUBSCRIPTION_CREATE_MUTATION = `
  mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription {
        id
        topic
        format
        uri
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function normalizeShopDomain(shopInput) {
    if (!shopInput) return null;
    let shopDomain = String(shopInput).trim().toLowerCase();
    if (!shopDomain.includes('.')) {
        shopDomain = `${shopDomain}.myshopify.com`;
    }
    return shopDomain;
}

function mapWebhookTopicToGraphql(topic) {
    const t = String(topic || '').trim();
    if (!t) return null;

    const lower = t.toLowerCase();
    if (lower === 'orders/create' || lower === 'orders_create' || lower === 'order/create') {
        return 'ORDERS_CREATE';
    }

    if (/^[A-Z0-9_]+$/.test(t)) return t;
    return null;
}

function isOrdersCreateTopic(topic) {
    const normalized = String(topic || '')
        .trim()
        .toLowerCase()
        .replace(/_/g, '/');
    return normalized === 'orders/create' || normalized === 'order/create';
}

function shopifyApiVersion() {
    return process.env.SHOPIFY_API_VERSION || '2025-10';
}

function shopifyHeaders(accessToken) {
    return {
        'X-Shopify-Access-Token': accessToken,
        Accept: 'application/json',
    };
}

async function listShopifyWebhooks(accessToken, storeName) {
    const shopDomain = normalizeShopDomain(storeName);
    const endpoint = `https://${shopDomain}/admin/api/${shopifyApiVersion()}/webhooks.json`;
    const resp = await axios.get(endpoint, {
        headers: shopifyHeaders(accessToken),
        timeout: 60000,
    });
    return {
        shopDomain,
        webhooks: Array.isArray(resp?.data?.webhooks) ? resp.data.webhooks : [],
    };
}

async function createShopifyWebhookSubscription(
    accessToken,
    storeName,
    { topic, address, format = 'json' }
) {
    const shopDomain = normalizeShopDomain(storeName);
    const gqlTopic = mapWebhookTopicToGraphql(topic);
    if (!gqlTopic) {
        const err = new Error(`Unsupported webhook topic: ${topic}`);
        err.status = 400;
        throw err;
    }

    const endpoint = `https://${shopDomain}/admin/api/${shopifyApiVersion()}/graphql.json`;
    const resp = await axios.post(
        endpoint,
        {
            query: WEBHOOK_SUBSCRIPTION_CREATE_MUTATION,
            variables: {
                topic: gqlTopic,
                webhookSubscription: {
                    uri: String(address).trim(),
                },
            },
        },
        {
            headers: {
                ...shopifyHeaders(accessToken),
                'Content-Type': 'application/json',
            },
            timeout: 60000,
        }
    );

    if (resp.data?.errors) {
        const message = Array.isArray(resp.data.errors)
            ? resp.data.errors.map((e) => e.message).join('; ')
            : 'Unknown GraphQL error';
        const err = new Error(message);
        err.status = 502;
        throw err;
    }

    const payload = resp.data?.data?.webhookSubscriptionCreate;
    if (!payload) {
        const err = new Error('Invalid Shopify response for webhookSubscriptionCreate');
        err.status = 502;
        throw err;
    }

    if (Array.isArray(payload.userErrors) && payload.userErrors.length > 0) {
        const message = payload.userErrors
            .map((e) => `${e.field ? e.field.join('.') : 'error'}: ${e.message}`)
            .join('; ');
        const err = new Error(message);
        err.status = 400;
        throw err;
    }

    return {
        shopDomain,
        webhookSubscription: payload.webhookSubscription || null,
        format: String(format || 'json').toLowerCase(),
    };
}

async function deleteShopifyWebhook(accessToken, storeName, webhookId) {
    const shopDomain = normalizeShopDomain(storeName);
    const id = String(webhookId || '').trim();
    const endpoint = `https://${shopDomain}/admin/api/${shopifyApiVersion()}/webhooks/${encodeURIComponent(id)}.json`;
    await axios.delete(endpoint, {
        headers: shopifyHeaders(accessToken),
        timeout: 60000,
        validateStatus: (status) => status === 200 || status === 204 || status === 404,
    });
    return { shopDomain, deletedWebhookId: id };
}

function findOrdersCreateWebhook(webhooks, endpointUrl = null) {
    const target = endpointUrl != null ? String(endpointUrl).trim() : '';
    const list = Array.isArray(webhooks) ? webhooks : [];

    return (
        list.find((hook) => {
            if (!isOrdersCreateTopic(hook?.topic)) return false;
            if (!target) return true;
            const address = String(hook?.address || '').trim();
            return address === target;
        }) || null
    );
}

function resolveShopifyCredentials(body, connection, existingData) {
    const data = existingData || {};
    const storeName =
        body?.storeName ||
        body?.shop ||
        body?.store ||
        data.shop ||
        data.storeName ||
        data.store ||
        null;

    const access_token =
        body?.access_token ||
        body?.accessToken ||
        data.access_token ||
        (connection?.id != null ? String(connection.id).trim() : null) ||
        null;

    return {
        storeName: storeName ? String(storeName).trim() : null,
        access_token: access_token ? String(access_token).trim() : null,
    };
}

module.exports = {
    normalizeShopDomain,
    mapWebhookTopicToGraphql,
    isOrdersCreateTopic,
    listShopifyWebhooks,
    createShopifyWebhookSubscription,
    deleteShopifyWebhook,
    findOrdersCreateWebhook,
    resolveShopifyCredentials,
};