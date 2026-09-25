const axios = require('axios');
const debug = require('debug');
const { sendApiError } = require('../helpers/api-error');
const { logIncomingRequest } = require('../helpers/request-log');
const {
  getBigcommerceConnection,
  bigcommerceAuthHeaders,
  BIGCOMMERCE_API_BASE,
} = require('./bigcommerce-auth');

const log = debug('app:bigcommerceWebhooks');

const bigcommerceErrorDetail = (err) => {
  const data = err?.response?.data;
  if (!data) return null;
  if (typeof data === 'string') return data.trim().slice(0, 500) || null;
  return data.title || data.message || data.error || null;
};

/**
 * Registers a webhook for a merchant's BigCommerce store. `destination` must be the public,
 * HTTPS webhook receiver URL (BIGCOMMERCE_WEBHOOK_DESTINATION_URL / POST /bigcommerce/webhooks/order-create
 * below) — BigCommerce requires HTTPS on port 443, custom ports aren't supported, and it can
 * take up to a minute for a newly created webhook to start delivering.
 *
 * Expected body: { account_key (required), scope (optional, default "store/order/created") }.
 */
exports.registerBigcommerceOrderCreateWebhook = async (req, res) => {
  try {
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'registerBigcommerceOrderCreateWebhook',
      accountKey: req.body?.account_key,
      body: req.body,
      query: req.query,
    });

    const account_key = req.body?.account_key || req.query?.account_key;
    if (!account_key) {
      return sendApiError(res, 400, 'Missing required parameter: account_key');
    }

    const destination = process.env.BIGCOMMERCE_WEBHOOK_DESTINATION_URL;
    if (!destination) {
      return sendApiError(res, 500, 'BIGCOMMERCE_WEBHOOK_DESTINATION_URL not configured');
    }

    const connection = await getBigcommerceConnection(account_key);
    if (!connection) {
      return sendApiError(res, 400, 'No BigCommerce connection found for this account_key. Connect BigCommerce first.');
    }

    const scope = req.body?.scope || 'store/order/created';

    const resp = await axios.post(
      `${BIGCOMMERCE_API_BASE}/stores/${connection.store_hash}/v3/hooks`,
      {
        scope,
        destination,
        is_active: true,
        headers: {},
      },
      { headers: bigcommerceAuthHeaders(connection), timeout: 20000 }
    );

    const successLog = JSON.stringify({
      level: 'INFO',
      platform: 'bigcommerce',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'registerBigcommerceOrderCreateWebhook',
      operation: 'BigCommerce webhook registered successfully',
      account_key,
      result: { scope, destination, id: resp?.data?.data?.id || null },
      timestamp: new Date().toISOString(),
    });
    console.log(successLog);
    log('Success in registerBigcommerceOrderCreateWebhook: %s', successLog);

    return res.status(200).json({ success: true, webhook: resp?.data?.data || resp?.data });
  } catch (err) {
    const errorJson = JSON.stringify({
      level: 'ERROR',
      platform: 'bigcommerce',
      source: 'bigcommerce_api',
      function: 'registerBigcommerceOrderCreateWebhook',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || null,
      message: `Failed to register BigCommerce webhook: ${err?.message || 'Unknown error'}`,
      detail: bigcommerceErrorDetail(err),
      timestamp: new Date().toISOString(),
    });
    console.error(errorJson);
    log('Formatted error in registerBigcommerceOrderCreateWebhook: %s', errorJson);
    return sendApiError(res, err);
  }
};

/** Lists registered webhooks for a merchant's store. Expected query/body: { account_key }. */
exports.listBigcommerceWebhooks = async (req, res) => {
  try {
    const account_key = req.body?.account_key || req.query?.account_key;
    if (!account_key) {
      return sendApiError(res, 400, 'Missing required parameter: account_key');
    }
    const connection = await getBigcommerceConnection(account_key);
    if (!connection) {
      return sendApiError(res, 400, 'No BigCommerce connection found for this account_key.');
    }

    const resp = await axios.get(`${BIGCOMMERCE_API_BASE}/stores/${connection.store_hash}/v3/hooks`, {
      headers: bigcommerceAuthHeaders(connection),
      timeout: 20000,
    });

    return res.status(200).json({ success: true, webhooks: resp?.data?.data || resp?.data });
  } catch (err) {
    log('listBigcommerceWebhooks failed: %s', err?.message);
    return sendApiError(res, err);
  }
};

/** Deletes a webhook by id. Expected body/query: { account_key, webhook_id }. */
exports.deleteBigcommerceWebhook = async (req, res) => {
  try {
    const account_key = req.body?.account_key || req.query?.account_key;
    const webhook_id = req.body?.webhook_id || req.query?.webhook_id;
    if (!account_key || !webhook_id) {
      return sendApiError(res, 400, 'Missing required parameters: account_key, webhook_id');
    }
    const connection = await getBigcommerceConnection(account_key);
    if (!connection) {
      return sendApiError(res, 400, 'No BigCommerce connection found for this account_key.');
    }

    await axios.delete(`${BIGCOMMERCE_API_BASE}/stores/${connection.store_hash}/v3/hooks/${webhook_id}`, {
      headers: bigcommerceAuthHeaders(connection),
      timeout: 20000,
    });

    return res.status(200).json({ success: true, message: 'BigCommerce webhook deleted successfully' });
  } catch (err) {
    log('deleteBigcommerceWebhook failed: %s', err?.message);
    return sendApiError(res, err);
  }
};

/**
 * The webhook receiver itself — this is the URL you register as `destination` above, and the
 * one that needs to be public HTTPS reachable from BigCommerce. BigCommerce requires an HTTP
 * 200 response to acknowledge receipt (a non-200 or no response means the delivery is treated
 * as failed) — everything here is logging only for now; order-import logic is a separate,
 * later step once this connection is verified working end to end.
 */
exports.bigcommerceOrderCreateWebhook = async (req, res) => {
  try {
    logIncomingRequest(log, {
      method: req.method,
      path: req.originalUrl || req.url,
      functionName: 'bigcommerceOrderCreateWebhook',
      body: req.body,
      query: req.query,
    });

    const payload = req.body;
    console.log(
      JSON.stringify({
        level: 'INFO',
        platform: 'bigcommerce',
        function: 'bigcommerceOrderCreateWebhook',
        operation: 'BigCommerce order-create webhook received',
        result: { scope: payload?.scope, store_hash: payload?.store_id || payload?.producer, data: payload?.data },
        timestamp: new Date().toISOString(),
      })
    );

    return res.status(200).json({ success: true });
  } catch (err) {
    log('bigcommerceOrderCreateWebhook failed: %s', err?.message);
    // Still acknowledge with 200 where possible — BigCommerce retries/flags deliveries that
    // don't get one, and a malformed payload on our side shouldn't cause redelivery storms.
    return res.status(200).json({ success: false });
  }
};
