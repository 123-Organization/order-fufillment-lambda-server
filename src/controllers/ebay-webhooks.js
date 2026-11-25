const finerworksService = require('../helpers/finerworks-service');
const { sendApiError } = require('../helpers/api-error');
const {
  computeChallengeResponse,
  getEbayNotificationEndpointUrl,
  getVerificationToken,
  getOrderTopicId,
  verifyEbayNotificationSignature,
  parseEbayNotification,
} = require('../helpers/ebay-notifications');
const {
  findAccountKeysByEbayUser,
  scanAllEbayAccounts,
  deleteEbayAccountsByAccountKey,
} = require('../helpers/ebay-accounts-dynamo');
const { resolveEbayAuth, getEbayConnection, EBAY_CONNECTION_NAME } = require('./ebay-auth');
const { fetchEbayOrder } = require('./ebay-orders');
const { submitEbayOrderToFinerWorks } = require('../helpers/ebay-order-webhook');
const debug = require('debug');
const log = debug('app:ebayWebhooks');

/**
 * One public endpoint receives every eBay notification:
 *   GET  /api/webhooks/ebay/notification?challenge_code=...  -> endpoint ownership challenge
 *   POST /api/webhooks/ebay/notification                      -> signed notification
 *
 * Configure this same URL (EBAY_NOTIFICATION_ENDPOINT_URL) in the eBay developer portal for
 * "Marketplace account deletion" (mandatory for every eBay app) — order notification
 * subscriptions are delivered to it too.
 */

const elog = (step, message, data) => {
  if (data === undefined) console.log(`[eBay webhook] ${step} ${message}`);
  else console.log(`[eBay webhook] ${step} ${message}`, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
};

/** GET challenge: respond { challengeResponse } with HTTP 200 and JSON content type. */
const ebayNotificationChallenge = async (req, res) => {
  const challengeCode = req.query?.challenge_code;
  if (!challengeCode) return sendApiError(res, 400, 'Missing challenge_code');
  const endpoint = getEbayNotificationEndpointUrl();
  if (!endpoint || !getVerificationToken()) {
    return sendApiError(res, 500, 'EBAY_NOTIFICATION_ENDPOINT_URL (or OFA_PUBLIC_API_BASE_URL) and EBAY_VERIFICATION_TOKEN must be configured');
  }
  elog('challenge', `answering challenge for ${endpoint}`);
  return res.status(200).type('application/json').send(JSON.stringify({ challengeResponse: computeChallengeResponse(challengeCode, endpoint) }));
};

/** Clears the eBay connection on every OFA account linked to a deleted/closed eBay user. */
async function handleAccountDeletion(parsed) {
  const keys = await findAccountKeysByEbayUser({ userId: parsed.userId, username: parsed.username });
  for (const key of keys) {
    try {
      const info = await finerworksService.GET_INFO({ account_key: key });
      const connections = JSON.parse(JSON.stringify(info?.user_account?.connections || []));
      const idx = connections.findIndex((c) => c && c.name === EBAY_CONNECTION_NAME);
      if (idx !== -1) {
        connections[idx] = { name: EBAY_CONNECTION_NAME, id: null, data: null };
        await finerworksService.UPDATE_INFO({ account_key: key, connections });
      }
      await deleteEbayAccountsByAccountKey(key);
    } catch (e) {
      log('account deletion cleanup failed for %s: %s', key, e?.message);
    }
  }
  return keys.length;
}

/**
 * Order notification: find the OFA account(s) for the seller, re-fetch the order from eBay
 * (never trust the payload), and submit it to FinerWorks when it's paid and unshipped.
 * When the payload doesn't identify the seller, every order-sync account is tried; an order
 * id only resolves for the seller who owns it.
 */
async function handleOrderNotification(parsed) {
  if (!parsed.orderId) return { status: 'ignored', reason: 'no orderId in notification' };
  let keys = await findAccountKeysByEbayUser({ userId: parsed.userId, username: parsed.username });
  if (!keys.length) {
    const rows = await scanAllEbayAccounts();
    keys = [...new Set(rows.filter((r) => r?.order_sync === true && r?.account_key).map((r) => String(r.account_key).trim()))];
  }
  elog('order', `order ${parsed.orderId}: candidate accounts ${keys.length}`);
  for (const key of keys) {
    const conn = await getEbayConnection(key);
    if (!conn || conn.order_sync !== true) {
      elog('order', `account ${key}: order sync off -> skip`);
      continue;
    }
    const { accessToken } = await resolveEbayAuth(key);
    const order = await fetchEbayOrder(accessToken, parsed.orderId);
    if (!order) continue;
    const result = await submitEbayOrderToFinerWorks(order, key, { trace: (s, m, d) => elog(s, m, d) });
    return { ...result, account_key: key };
  }
  return { status: 'ignored', reason: 'no connected account with order sync owns this order' };
}

/** POST notification: verify signature, then route by topic. */
const ebayNotificationWebhook = async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
    const { valid, reason } = await verifyEbayNotificationSignature(rawBody, req.body, req.headers?.['x-ebay-signature']);
    if (!valid) {
      elog('1', `signature check FAILED (${reason}) -> 412`);
      // eBay's guidance: reply 412 Precondition Failed when the signature doesn't verify.
      return sendApiError(res, 412, 'Invalid eBay notification signature');
    }
    const parsed = parseEbayNotification(req.body);
    elog('2', 'notification', { topic: parsed.topic, notificationId: parsed.notificationId, orderId: parsed.orderId, user: parsed.userId || parsed.username || null });

    if (parsed.topic === 'MARKETPLACE_ACCOUNT_DELETION') {
      const cleared = await handleAccountDeletion(parsed);
      elog('3', `account deletion handled; accounts cleared: ${cleared}`);
      return res.status(200).json({ success: true, topic: parsed.topic, accountsCleared: cleared });
    }

    const orderTopics = new Set([getOrderTopicId(), 'ORDER_CONFIRMATION', 'ITEM_SOLD', 'FIXED_PRICE_TRANSACTION'].filter(Boolean));
    if (orderTopics.has(parsed.topic) || (parsed.orderId && !parsed.topic)) {
      const result = await handleOrderNotification(parsed);
      elog('3', `order notification result: ${result.status}`, result.reason || undefined);
      console.log(JSON.stringify({
        level: result.status === 'failed' ? 'ERROR' : 'INFO',
        platform: 'ebay',
        function: 'ebayNotificationWebhook',
        operation: `eBay order notification ${result.status}`,
        account_key: result.account_key || 'unknown',
        result: { orderId: parsed.orderId, status: result.status, reason: result.reason || null, order_po: result.order_po || null },
        timestamp: new Date().toISOString(),
      }));
      // 5xx only for "try again later" outcomes so eBay redelivers; business skips are 200.
      if (result.status === 'failed' && /retry/i.test(result.reason || '')) {
        return sendApiError(res, 503, result.reason);
      }
      return res.status(200).json({ success: result.status !== 'failed', ...result, submitData: undefined });
    }

    return res.status(200).json({ success: true, ignored: true, topic: parsed.topic });
  } catch (err) {
    console.error(JSON.stringify({
      level: 'ERROR',
      platform: 'ebay',
      source: err?.response ? 'ebay_api' : 'lambda',
      function: 'ebayNotificationWebhook',
      httpStatus: err?.response?.status || err?.status || null,
      message: `eBay notification handling failed: ${err?.message || 'Unknown error'}`,
      detail: err?.data || null,
      timestamp: new Date().toISOString(),
    }));
    return sendApiError(res, 500, err?.message || 'Unknown error');
  }
};

module.exports = {
  ebayNotificationChallenge,
  ebayNotificationWebhook,
};
