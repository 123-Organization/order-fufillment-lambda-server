const axios = require('axios');
const finerworksService = require('../helpers/finerworks-service');
const { validateAccountKey } = require('../validators/accountKey.validator');
const {
  connectionNameFromPlatform,
  normalizePlatform,
  parseConnectionData,
  cloneConnections,
  findConnectionIndex,
  isOrderSyncEnabled,
} = require('../helpers/platform-connections');
const {
  listSquarespaceWebhookSubscriptions,
  createSquarespaceWebhookSubscription,
  deleteSquarespaceWebhookSubscription,
  findOrderCreateSubscription,
} = require('../helpers/squarespace-webhook-api');
const {
  listShopifyWebhooks,
  createShopifyWebhookSubscription,
  deleteShopifyWebhook,
  findOrdersCreateWebhook,
  resolveShopifyCredentials,
  normalizeShopDomain,
} = require('../helpers/shopify-webhook-api');
const {
  fetchSquarespaceOrderById,
  transformSquarespaceOrderToFinerWorksPayload,
  enrichOrderItemsWithProductGuids,
  buildSquarespaceFulfillmentWebhookUrl,
} = require('../helpers/squarespace-order-webhook');
const debug = require('debug');
const { sendApiError } = require('../helpers/api-error');
const log = debug('app:platformOrderSync');

const SUPPORTED_PLATFORMS = ['squarespace', 'wix', 'shopify'];

const SHOPIFY_ORDER_CREATE_WEBHOOK = {
  topic: 'order/create',
  address:
    'https://d7z22w3j4h.execute-api.us-east-1.amazonaws.com/Prod/api/webhooks/webhooks/orders-create',
  format: 'json',
};

function parseOrderSyncFlag(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return null;
}

function buildSquarespaceOrderWebhookUrl(account_key) {
  const apiBase = String(process.env.SQUARESPACE_ORDER_CREATE_WEBHOOK_URL || '')
    .trim()
    .replace(/\/$/, '');
  if (!apiBase) {
    return null;
  }
  return `${apiBase}/api/webhooks/squarespace/order-create?account_key=${encodeURIComponent(account_key)}`;
}

async function refreshSquarespaceAccessToken(account_key, squarespaceData) {
  const refresh_token = squarespaceData?.refresh_token;
  if (!refresh_token) {
    const err = new Error('Squarespace refresh_token missing; reconnect the store');
    err.status = 400;
    throw err;
  }

  const clientId = process.env.SQUARESPACE_CLIENT_ID;
  const clientSecret = process.env.SQUARESPACE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const err = new Error('Squarespace OAuth credentials not configured');
    err.status = 500;
    throw err;
  }

  const tokenUrl = 'https://login.squarespace.com/api/1/login/oauth/provider/tokens';
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tokenResp = await axios.post(
    tokenUrl,
    {
      grant_type: 'refresh_token',
      refresh_token: String(refresh_token).trim(),
    },
    {
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/json',
        'User-Agent': process.env.SQUARESPACE_USER_AGENT || 'ofa-node',
      },
      timeout: 20000,
    }
  );

  const tokenData = tokenResp?.data || {};
  if (!tokenData?.access_token) {
    const err = new Error('Token refresh succeeded but access_token missing');
    err.status = 400;
    throw err;
  }

  const getInformation = await finerworksService.GET_INFO({ account_key });
  const connections = cloneConnections(getInformation?.user_account?.connections);
  const idx = findConnectionIndex(connections, 'Squarespace');
  if (idx === -1) {
    const err = new Error('Squarespace connection not found');
    err.status = 400;
    throw err;
  }

  const merged = {
    ...squarespaceData,
    ...tokenData,
    refresh_token: tokenData.refresh_token || refresh_token,
  };

  connections[idx] = {
    ...connections[idx],
    name: 'Squarespace',
    id: tokenData.access_token,
    data: JSON.stringify(merged),
  };

  await finerworksService.UPDATE_INFO({ account_key, connections });
  return { accessToken: tokenData.access_token, connections, connectionIndex: idx, data: merged };
}

async function getSquarespaceAccessToken(account_key) {
  const getInformation = await finerworksService.GET_INFO({ account_key });
  const connections = getInformation?.user_account?.connections || [];
  const idx = findConnectionIndex(connections, 'Squarespace');
  if (idx === -1) {
    const err = new Error('Squarespace connection not found');
    err.status = 400;
    throw err;
  }

  const conn = connections[idx];
  const data = parseConnectionData(conn);
  const accessToken =
    data.access_token != null
      ? String(data.access_token).trim()
      : conn.id != null
        ? String(conn.id).trim()
        : '';

  if (!accessToken) {
    const err = new Error('Squarespace access token missing');
    err.status = 400;
    throw err;
  }

  return { accessToken, data, connection: conn };
}

async function withSquarespaceAccessToken(account_key, fn) {
  let { accessToken, data } = await getSquarespaceAccessToken(account_key);
  try {
    return await fn(accessToken, data);
  } catch (err) {
    const status = err?.response?.status;
    if (status !== 401 && status !== 403) throw err;
    const refreshed = await refreshSquarespaceAccessToken(account_key, data);
    accessToken = refreshed.accessToken;
    data = refreshed.data;
    return fn(accessToken, data);
  }
}

async function enableSquarespaceOrderSync(account_key) {
  const endpointUrl = buildSquarespaceOrderWebhookUrl(account_key);
  if (!endpointUrl || !endpointUrl.toLowerCase().startsWith('https://')) {
    const err = new Error(
      'Squarespace order webhook URL is not configured. Set SQUARESPACE_ORDER_CREATE_WEBHOOK_URL or OFA_PUBLIC_API_BASE_URL (https).'
    );
    err.status = 500;
    throw err;
  }

  let webhookSubscription = null;

  await withSquarespaceAccessToken(account_key, async (accessToken) => {
    const existing = await listSquarespaceWebhookSubscriptions(accessToken);
    webhookSubscription = findOrderCreateSubscription(existing, endpointUrl);

    if (!webhookSubscription) {
      webhookSubscription = await createSquarespaceWebhookSubscription(accessToken, {
        endpointUrl,
        topics: ['order.create'],
      });
    }
  });

  return { endpointUrl, webhookSubscription };
}

async function disableSquarespaceOrderSync(account_key, subscriptionId) {
  if (!subscriptionId) return;

  await withSquarespaceAccessToken(account_key, async (accessToken) => {
    await deleteSquarespaceWebhookSubscription(accessToken, subscriptionId);
  });
}

function validateShopifyShopDomain(storeName) {
  const shopDomain = normalizeShopDomain(storeName);
  if (!shopDomain || !shopDomain.match(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/)) {
    const err = new Error('Invalid storeName. Expected shopname or shopname.myshopify.com');
    err.status = 400;
    throw err;
  }
  return shopDomain;
}

async function enableShopifyOrderSync(req, existingData) {
  const { storeName, access_token } = resolveShopifyCredentials(req.body, null, existingData);
  const { topic, address, format } = SHOPIFY_ORDER_CREATE_WEBHOOK;

  if (!storeName || !access_token) {
    const err = new Error(
      'Missing required parameters for Shopify order sync: storeName and access_token'
    );
    err.status = 400;
    throw err;
  }

  const shopDomain = validateShopifyShopDomain(storeName);
  const listed = await listShopifyWebhooks(access_token, shopDomain);
  let matched = findOrdersCreateWebhook(listed.webhooks, address);
  let createdSubscription = null;

  if (!matched) {
    createdSubscription = await createShopifyWebhookSubscription(access_token, shopDomain, {
      topic,
      address,
      format,
    });
    const relisted = await listShopifyWebhooks(access_token, shopDomain);
    matched = findOrdersCreateWebhook(relisted.webhooks, address);
  }

  if (!matched?.id) {
    const err = new Error(
      'Shopify order create webhook was registered but could not be found in webhook list'
    );
    err.status = 502;
    throw err;
  }

  return {
    shopDomain,
    endpointUrl: address,
    webhook: matched,
    webhookSubscription: createdSubscription?.webhookSubscription || null,
    message: createdSubscription
      ? 'Shopify orders/create webhook registered successfully'
      : 'Shopify orders/create webhook already registered',
  };
}

async function disableShopifyOrderSync(req, existingConn, existingData) {
  const { storeName, access_token } = resolveShopifyCredentials(
    req.body,
    existingConn,
    existingData
  );

  if (!storeName || !access_token) {
    const err = new Error(
      'Missing Shopify credentials. Provide storeName and access_token, or ensure they are stored on the Shopify connection.'
    );
    err.status = 400;
    throw err;
  }

  const shopDomain = validateShopifyShopDomain(storeName);
  const endpointUrl = SHOPIFY_ORDER_CREATE_WEBHOOK.address;

  const listed = await listShopifyWebhooks(access_token, shopDomain);
  const matched =
    findOrdersCreateWebhook(listed.webhooks, endpointUrl) ||
    findOrdersCreateWebhook(listed.webhooks, null);

  if (!matched?.id) {
    const err = new Error('No Shopify orders/create webhook found to delete');
    err.status = 404;
    throw err;
  }

  await deleteShopifyWebhook(access_token, shopDomain, matched.id);

  return {
    shopDomain,
    deletedWebhookId: String(matched.id),
    topic: matched.topic,
    address: matched.address,
    message: 'Shopify orders/create webhook deleted successfully',
  };
}

function applyOrderSyncToConnection(conn, order_sync, dataPatch = {}) {
  const existingData = parseConnectionData(conn);
  // Support legacy connections that stored order_sync on the connection root.
  if (conn.order_sync !== undefined && existingData.order_sync === undefined) {
    existingData.order_sync = conn.order_sync;
  }

  const nextData = { ...existingData, ...dataPatch, order_sync };

  if (order_sync === false) {
    delete nextData.webhook_subscription_id;
    delete nextData.webhook_subscription_secret;
    delete nextData.order_create_webhook_url;
    delete nextData.webhook_id;
    delete nextData.shopify_webhook_id;
    delete nextData.shop_domain;
    delete nextData.storeName;
  }

  const { order_sync: _removed, ...connWithoutRootFlag } = conn;
  return {
    ...connWithoutRootFlag,
    name: conn.name,
    id: conn.id,
    data: JSON.stringify(nextData),
  };
}

/**
 * Toggle automatic order push for a connected store.
 *
 * Body:
 * - account_key (required, uuid)
 * - platform (required): squarespace | wix | shopify
 * - order_sync (required boolean): true to enable, false to disable
 *
 * Squarespace: registers/deletes order.create webhook subscription and persists order_sync inside connection.data (JSON).
 * Shopify: registers/deletes orders/create webhook (requires storeName and access_token; webhook URL is fixed).
 * Wix: updates order_sync inside connection.data only (no webhook registration).
 */
exports.setPlatformOrderSync = async (req, res) => {
  try {
    const account_key =
      req.body?.account_key ||
      req.body?.accountKey ||
      req.query?.account_key ||
      req.query?.accountKey;
    const platform = req.body?.platform || req.query?.platform;
    const order_sync = parseOrderSyncFlag(
      req.body?.order_sync ?? req.body?.orderSync ?? req.query?.order_sync ?? req.query?.orderSync
    );

    const { valid, error } = validateAccountKey(account_key);
    if (!valid) {
      return sendApiError(res, 400, error.message);
    }

    const trimmedKey = String(account_key).trim();
    const platformNorm = normalizePlatform(platform);
    const connectionName = connectionNameFromPlatform(platform);
    if (!connectionName || !SUPPORTED_PLATFORMS.includes(platformNorm)) {
      return sendApiError(
        res,
        400,
        `Invalid platform. Expected one of: ${SUPPORTED_PLATFORMS.join(', ')}`
      );
    }

    if (order_sync === null) {
      return sendApiError(res, 400, 'Missing or invalid order_sync. Expected boolean true/false.');
    }

    const getInformation = await finerworksService.GET_INFO({ account_key: trimmedKey });
    const connections = cloneConnections(getInformation?.user_account?.connections);
    const idx = findConnectionIndex(connections, connectionName);

    if (idx === -1) {
      return sendApiError(res, 400, `${connectionName} connection not found for this account`);
    }

    const existingConn = connections[idx];
    const existingData = parseConnectionData(existingConn);
    let webhookSubscription = null;
    let shopifyWebhookResult = null;
    let syncMessage = null;

    if (connectionName === 'Squarespace') {
      if (order_sync) {
        const result = await enableSquarespaceOrderSync(trimmedKey);
        webhookSubscription = result.webhookSubscription;
        syncMessage = 'Squarespace order.create webhook registered successfully';
        connections[idx] = applyOrderSyncToConnection(existingConn, true, {
          webhook_subscription_id:
            webhookSubscription?.id || existingData.webhook_subscription_id || null,
          webhook_subscription_secret:
            webhookSubscription?.secret || existingData.webhook_subscription_secret || null,
          order_create_webhook_url: result.endpointUrl,
        });
      } else {
        const subscriptionId = existingData.webhook_subscription_id || null;
        await disableSquarespaceOrderSync(trimmedKey, subscriptionId);
        syncMessage = 'Squarespace order.create webhook removed and order sync disabled';
        connections[idx] = applyOrderSyncToConnection(existingConn, false);
      }
    } else if (connectionName === 'Shopify') {
      if (order_sync) {
        shopifyWebhookResult = await enableShopifyOrderSync(req, existingData);
        syncMessage = shopifyWebhookResult.message;
        const { access_token } = resolveShopifyCredentials(req.body, existingConn, existingData);
        connections[idx] = applyOrderSyncToConnection(existingConn, true, {
          shop_domain: shopifyWebhookResult.shopDomain,
          storeName: shopifyWebhookResult.shopDomain,
          order_create_webhook_url: shopifyWebhookResult.endpointUrl,
          webhook_id: shopifyWebhookResult.webhook?.id || null,
          shopify_webhook_id: shopifyWebhookResult.webhook?.id || null,
          ...(access_token ? { access_token } : {}),
        });
        if (access_token) {
          connections[idx].id = access_token;
        }
        webhookSubscription = shopifyWebhookResult.webhookSubscription;
      } else {
        shopifyWebhookResult = await disableShopifyOrderSync(req, existingConn, existingData);
        syncMessage = shopifyWebhookResult.message;
        connections[idx] = applyOrderSyncToConnection(existingConn, false);
      }
    } else {
      connections[idx] = applyOrderSyncToConnection(existingConn, order_sync);
      syncMessage = order_sync
        ? `${connectionName} order sync enabled`
        : `${connectionName} order sync disabled`;
    }

    await finerworksService.UPDATE_INFO({
      account_key: trimmedKey,
      connections,
    });

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: platformNorm || 'unknown',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'setPlatformOrderSync',
      operation: syncMessage || 'Platform order sync updated',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      result: { order_sync, platform: platformNorm },
      timestamp: new Date().toISOString()
    });
    console.log(successLog);
    log('Success in setPlatformOrderSync: %s', successLog);
    return res.status(200).json({
      success: true,
      message: syncMessage,
      platform: platformNorm,
      order_sync,
      connection: connections[idx],
      ...(webhookSubscription ? { webhookSubscription } : {}),
      ...(shopifyWebhookResult?.webhook ? { shopifyWebhook: shopifyWebhookResult.webhook } : {}),
      ...(shopifyWebhookResult?.deletedWebhookId
        ? { deletedWebhookId: shopifyWebhookResult.deletedWebhookId }
        : {}),
    });
  } catch (err) {
    const isSquarespaceError = err?.response?.config?.url?.includes('squarespace') || err?.config?.url?.includes('squarespace');
    const isShopifyError = err?.response?.config?.url?.includes('myshopify.com') || err?.config?.url?.includes('myshopify.com');
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const isWixError = err?.response?.config?.url?.includes('wixapis.com') || err?.config?.url?.includes('wixapis.com');
    const errorSource = isSquarespaceError ? 'squarespace_api' : (isShopifyError ? 'shopify_api' : (isWixError ? 'wix_api' : (isFinerworksError ? 'finerworks_api' : 'lambda')));
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: req.body?.platform || req.query?.platform || 'unknown',
      source: errorSource,
      function: 'setPlatformOrderSync',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to set platform order sync: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.error || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in setPlatformOrderSync: %s', errorJson);
    return sendApiError(res, err);
  }
};

/**
 * Squarespace order.create webhook receiver (registered when order_sync is enabled).
 * Query: account_key
 *
 * Webhook body only includes orderId — full order is loaded from Squarespace, mapped to FinerWorks,
 * and submitted with test_mode=true, source=squarespace, and fulfillment callback URL attached.
 */
exports.squarespaceOrderCreateWebhook = async (req, res) => {
  try {
    log('Squarespace order create webhook received', req.body, req.query);
    const account_key = req.query?.account_key || req.query?.accountKey;
    const { valid, error } = validateAccountKey(account_key);
    if (!valid) {
      return sendApiError(res, 400, error.message);
    }

    const trimmedKey = String(account_key).trim();
    const squarespaceOrderId =
      req.body?.data?.orderId || req.body?.orderId || req.body?.data?.order_id || null;

    if (!squarespaceOrderId || !String(squarespaceOrderId).trim()) {
      return sendApiError(
        res,
        400,
        'Missing Squarespace order id in webhook payload (data.orderId)'
      );
    }

    const getInformation = await finerworksService.GET_INFO({ account_key: trimmedKey });
    const connections = getInformation?.user_account?.connections || [];
    const conn = Array.isArray(connections)
      ? connections.find((c) => c && c.name === 'Squarespace')
      : null;

    if (!conn || !isOrderSyncEnabled(conn, 'Squarespace')) {
      return res.status(200).json({
        success: true,
        ignored: true,
        message: 'Order sync is disabled for this Squarespace connection',
      });
    }

    let squarespaceOrder = null;
    let accessTokenUsed = null;

    try {
      await withSquarespaceAccessToken(trimmedKey, async (accessToken) => {
        accessTokenUsed = accessToken;
        squarespaceOrder = await fetchSquarespaceOrderById(accessToken, squarespaceOrderId);
      });
    } catch (fetchErr) {
      log(
        'Failed to fetch Squarespace order orderId=%s: %s',
        squarespaceOrderId,
        fetchErr?.message
      );
      const status = fetchErr?.status || fetchErr?.response?.status || 502;
      return sendApiError(res, status, 'Failed to fetch Squarespace order details', {
        orderId: String(squarespaceOrderId),
      });
    }

    let shippingOptions = null;
    try {
      shippingOptions = await finerworksService.SHIPPING_OPTIONS_LIST();
    } catch (shipErr) {
      log('SHIPPING_OPTIONS_LIST failed: %s', shipErr?.message);
    }

    console.log('squarespaceOrder==============>>>>>>>', squarespaceOrder);
    const transformedOrder = transformSquarespaceOrderToFinerWorksPayload(squarespaceOrder, {
      shippingOptions: shippingOptions?.shipping_options ?? shippingOptions,
    });

    if (!transformedOrder.order_items?.length) {
      return res.status(200).json({
        success: true,
        ignored: true,
        message: 'No FinerWorks line items (Squarespace SKU must start with AP)',
        orderId: squarespaceOrder.id,
        order_po: transformedOrder.order_po,
      });
    }

    transformedOrder.order_items = await enrichOrderItemsWithProductGuids(
      transformedOrder.order_items,
      trimmedKey
    );

    const fulfillmentUrl = buildSquarespaceFulfillmentWebhookUrl({
      account_key: trimmedKey,
      accessToken: accessTokenUsed,
      orderNumber: transformedOrder.order_po,
      orderId: squarespaceOrder.id,
    });
    if (fulfillmentUrl) {
      transformedOrder.webhook_order_status_url = fulfillmentUrl;
    }

    const finalPayload = {
      orders: [transformedOrder],
      validate_only: false,
      payment_token: process.env.SQUARESPACE_WEBHOOK_PAYMENT_TOKEN || 'xxxx',
      account_key: trimmedKey,
    };

    let submitData = null;
    try {
      log('Submitting Squarespace order to FinerWorks order_po=%s', transformedOrder.order_po);
      console.log('order data', transformedOrder);
      console.log('finalPayload==============>>>>>>>', finalPayload);
      submitData = await finerworksService.SUBMIT_ORDERS(finalPayload);
      console.log('submitData==============>>>>>>>', submitData);
    } catch (submitErr) {
      log('SUBMIT_ORDERS failed: %s', submitErr?.message);
      const status = submitErr?.response?.status === 400 ? 400 : 502;
      return sendApiError(res, status, 'Failed to submit Squarespace order to FinerWorks', {
        orderId: squarespaceOrder.id,
        orderNumber: transformedOrder.order_po,
      });
    }

    log(
      'Squarespace order create webhook processed orderId=%s order_po=%s',
      squarespaceOrder.id,
      transformedOrder.order_po
    );
    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'squarespace',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'squarespaceOrderCreateWebhook',
      operation: 'Squarespace order created and submitted to FinerWorks successfully',
      account_key: trimmedKey,
      result: { orderId: squarespaceOrder.id, order_po: transformedOrder.order_po },
      timestamp: new Date().toISOString()
    });
    console.log(successLog);
    log('Success in squarespaceOrderCreateWebhook: %s', successLog);
    return res.status(200).json({
      success: true,
      submitted: true,
      topic: req.body?.topic || 'order.create',
      orderId: squarespaceOrder.id,
      order_po: transformedOrder.order_po,
      account_key: trimmedKey,
      submitData,
    });
  } catch (err) {
    log('Squarespace order create webhook failed', err);
    const isSquarespaceError = err?.response?.config?.url?.includes('squarespace') || err?.config?.url?.includes('squarespace');
    const isFinerworksError = err?.response?.config?.url?.includes('finerworks.com') || err?.config?.url?.includes('finerworks.com');
    const errorSource = isSquarespaceError ? 'squarespace_api' : (isFinerworksError ? 'finerworks_api' : 'lambda');
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'squarespace',
      source: errorSource,
      function: 'squarespaceOrderCreateWebhook',
      account_key: req.query?.account_key || req.query?.accountKey || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Squarespace order create webhook failed: ${err?.message || 'Unknown error'}`,
      detail: err?.response?.data?.message || err?.response?.data?.error || null,
      timestamp: new Date().toISOString()
    });
    console.error(errorJson);
    log('Formatted error in squarespaceOrderCreateWebhook: %s', errorJson);
    return sendApiError(res, err);
  }
};
