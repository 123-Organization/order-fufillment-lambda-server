const axios = require('axios');
const finerworksService = require('../helpers/finerworks-service');
const { validateAccountKey } = require('../validators/accountKey.validator');
const {
  connectionNameFromPlatform,
  normalizePlatform,
  parseConnectionData,
  cloneConnections,
  findConnectionIndex
} = require('../helpers/platform-connections');
const {
  listSquarespaceWebhookSubscriptions,
  createSquarespaceWebhookSubscription,
  deleteSquarespaceWebhookSubscription,
  findOrderCreateSubscription
} = require('../helpers/squarespace-webhook-api');

const SUPPORTED_PLATFORMS = ['squarespace', 'wix'];

function parseOrderSyncFlag(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return null;
}

function buildSquarespaceOrderWebhookUrl(account_key) {
  const configured = process.env.SQUARESPACE_ORDER_CREATE_WEBHOOK_URL;
  if (configured && String(configured).trim()) {
    const base = String(configured).trim().replace(/\/$/, '');
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}account_key=${encodeURIComponent(account_key)}`;
  }

  const apiBase = String(process.env.OFA_PUBLIC_API_BASE_URL || '').trim().replace(/\/$/, '');
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
      refresh_token: String(refresh_token).trim()
    },
    {
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/json',
        'User-Agent': process.env.SQUARESPACE_USER_AGENT || 'ofa-node'
      },
      timeout: 20000
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
    refresh_token: tokenData.refresh_token || refresh_token
  };

  connections[idx] = {
    ...connections[idx],
    name: 'Squarespace',
    id: tokenData.access_token,
    data: JSON.stringify(merged)
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
        topics: ['order.create']
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
  }

  const { order_sync: _removed, ...connWithoutRootFlag } = conn;
  return {
    ...connWithoutRootFlag,
    name: conn.name,
    id: conn.id,
    data: JSON.stringify(nextData)
  };
}

/**
 * Toggle automatic order push for a connected store.
 *
 * Body:
 * - account_key (required, uuid)
 * - platform (required): squarespace | wix
 * - order_sync (required boolean): true to enable, false to disable
 *
 * Squarespace: registers/deletes order.create webhook subscription and persists order_sync inside connection.data (JSON).
 * Wix: updates order_sync inside connection.data only (no webhook registration).
 */
exports.setPlatformOrderSync = async (req, res) => {
  try {
    const account_key =
      req.body?.account_key || req.body?.accountKey || req.query?.account_key || req.query?.accountKey;
    const platform = req.body?.platform || req.query?.platform;
    const order_sync = parseOrderSyncFlag(
      req.body?.order_sync ?? req.body?.orderSync ?? req.query?.order_sync ?? req.query?.orderSync
    );

    const { valid, error } = validateAccountKey(account_key);
    if (!valid) {
      return res.status(400).json({ success: false, message: error.message });
    }

    const trimmedKey = String(account_key).trim();
    const platformNorm = normalizePlatform(platform);
    const connectionName = connectionNameFromPlatform(platform);
    if (!connectionName || !SUPPORTED_PLATFORMS.includes(platformNorm)) {
      return res.status(400).json({
        success: false,
        message: `Invalid platform. Expected one of: ${SUPPORTED_PLATFORMS.join(', ')}`
      });
    }

    if (order_sync === null) {
      return res.status(400).json({
        success: false,
        message: 'Missing or invalid order_sync. Expected boolean true/false.'
      });
    }

    const getInformation = await finerworksService.GET_INFO({ account_key: trimmedKey });
    const connections = cloneConnections(getInformation?.user_account?.connections);
    const idx = findConnectionIndex(connections, connectionName);

    if (idx === -1) {
      return res.status(400).json({
        success: false,
        message: `${connectionName} connection not found for this account`
      });
    }

    const existingConn = connections[idx];
    const existingData = parseConnectionData(existingConn);
    let webhookSubscription = null;

    if (connectionName === 'Squarespace') {
      if (order_sync) {
        const result = await enableSquarespaceOrderSync(trimmedKey);
        webhookSubscription = result.webhookSubscription;
        connections[idx] = applyOrderSyncToConnection(existingConn, true, {
          webhook_subscription_id: webhookSubscription?.id || existingData.webhook_subscription_id || null,
          webhook_subscription_secret:
            webhookSubscription?.secret || existingData.webhook_subscription_secret || null,
          order_create_webhook_url: result.endpointUrl
        });
      } else {
        const subscriptionId = existingData.webhook_subscription_id || null;
        await disableSquarespaceOrderSync(trimmedKey, subscriptionId);
        connections[idx] = applyOrderSyncToConnection(existingConn, false);
      }
    } else {
      connections[idx] = applyOrderSyncToConnection(existingConn, order_sync);
    }

    await finerworksService.UPDATE_INFO({
      account_key: trimmedKey,
      connections
    });

    return res.status(200).json({
      success: true,
      platform: platformNorm,
      order_sync,
      connection: connections[idx],
      ...(webhookSubscription ? { webhookSubscription } : {})
    });
  } catch (err) {
    const status = err?.status || err?.response?.status || 500;
    const data = err?.response?.data;
    return res.status(status).json({
      success: false,
      message: 'Failed to update platform order sync',
      error:
        (typeof data?.message === 'string' && data.message) ||
        (typeof data?.error === 'string' && data.error) ||
        err?.message ||
        'Unknown error',
      ...(data && typeof data === 'object' ? { details: data } : {})
    });
  }
};

/**
 * Squarespace order.create webhook receiver (registered when order_sync is enabled).
 * Query: account_key
 */
exports.squarespaceOrderCreateWebhook = async (req, res) => {
  try {
    const account_key = req.query?.account_key || req.query?.accountKey;
    const { valid, error } = validateAccountKey(account_key);
    if (!valid) {
      return res.status(400).json({ success: false, message: error.message });
    }

    const trimmedKey = String(account_key).trim();
    const getInformation = await finerworksService.GET_INFO({ account_key: trimmedKey });
    const connections = getInformation?.user_account?.connections || [];
    const conn = Array.isArray(connections)
      ? connections.find((c) => c && c.name === 'Squarespace')
      : null;

    const connData = parseConnectionData(conn);
    const orderSyncEnabled =
      connData.order_sync === true || (conn?.order_sync === true && connData.order_sync === undefined);

    if (!conn || !orderSyncEnabled) {
      return res.status(200).json({
        success: true,
        ignored: true,
        message: 'Order sync is disabled for this Squarespace connection'
      });
    }

    return res.status(200).json({
      success: true,
      received: true,
      topic: req.body?.topic || 'order.create',
      orderId: req.body?.data?.orderId || req.body?.orderId || null
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Squarespace webhook handler failed',
      error: err?.message || 'Unknown error'
    });
  }
};
