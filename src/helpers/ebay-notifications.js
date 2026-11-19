const crypto = require('crypto');
const debug = require('debug');
const { getEbayAppToken, ebayApiCall, isOk, ebayError, summarizeEbayHttpError } = require('./ebay-api');
const log = debug('app:ebayNotifications');

/**
 * eBay Notification API helpers (one app-level HTTPS endpoint receives every topic):
 *  - endpoint challenge  : eBay GETs the endpoint with ?challenge_code=... when it is saved
 *                          (developer portal for account deletion, or a Notification API
 *                          destination); we answer SHA-256(challengeCode + verificationToken + endpoint).
 *  - message signature   : every POST carries X-EBAY-SIGNATURE (base64 JSON {alg, kid, signature,
 *                          digest}); verified with eBay's public key for `kid` (ECDSA / SHA1).
 *  - order subscription  : per seller (user token) subscription to EBAY_ORDER_NOTIFICATION_TOPIC
 *                          delivered to our destination.
 */

const NOTIFICATION_BASE = '/commerce/notification/v1';

function getVerificationToken() {
  return String(process.env.EBAY_VERIFICATION_TOKEN || '').trim();
}

/**
 * The exact public URL eBay calls. The challenge hash includes it, so it must match the URL
 * saved in the developer portal / destination byte-for-byte (scheme, host, path, no trailing slash).
 */
function getEbayNotificationEndpointUrl() {
  const explicit = String(process.env.EBAY_NOTIFICATION_ENDPOINT_URL || '').trim();
  if (explicit) return explicit;
  const base = String(process.env.OFA_PUBLIC_API_BASE_URL || '').trim().replace(/\/$/, '');
  return base ? `${base}/api/webhooks/ebay/notification` : '';
}

function getOrderTopicId() {
  return String(process.env.EBAY_ORDER_NOTIFICATION_TOPIC || 'ORDER_CONFIRMATION').trim();
}

/** hex(SHA-256(challengeCode + verificationToken + endpoint)) — order matters. */
function computeChallengeResponse(challengeCode, endpointUrl = getEbayNotificationEndpointUrl()) {
  return crypto
    .createHash('sha256')
    .update(String(challengeCode))
    .update(getVerificationToken())
    .update(endpointUrl)
    .digest('hex');
}

/** eBay returns the PEM on one line; Node needs the header/footer on their own lines. */
function toPem(key) {
  const raw = String(key || '').trim();
  if (!raw) return null;
  if (raw.includes('\n')) return raw;
  const body = raw
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) || [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

const publicKeyCache = new Map(); // kid -> { pem, digest, fetchedAt }
async function getEbayPublicKey(kid) {
  const cached = publicKeyCache.get(kid);
  if (cached && Date.now() - cached.fetchedAt < 60 * 60_000) return cached;
  const appToken = await getEbayAppToken();
  const r = await ebayApiCall({
    method: 'GET',
    path: `${NOTIFICATION_BASE}/public_key/${encodeURIComponent(kid)}`,
    accessToken: appToken,
  });
  if (!isOk(r)) throw ebayError('Could not fetch eBay notification public key', r);
  const entry = { pem: toPem(r.data?.key), digest: String(r.data?.digest || 'SHA1').toUpperCase(), fetchedAt: Date.now() };
  publicKeyCache.set(kid, entry);
  return entry;
}

/**
 * Verifies X-EBAY-SIGNATURE against the raw body (exact signed bytes); also tries the
 * re-serialized JSON, which is what eBay's own SDK verifies against.
 * Returns { valid, reason }.
 */
async function verifyEbayNotificationSignature(rawBody, parsedBody, signatureHeader) {
  if (!signatureHeader) return { valid: false, reason: 'missing X-EBAY-SIGNATURE header' };
  let sig;
  try {
    sig = JSON.parse(Buffer.from(String(signatureHeader), 'base64').toString('utf8'));
  } catch (_e) {
    return { valid: false, reason: 'X-EBAY-SIGNATURE is not base64 JSON' };
  }
  if (!sig?.kid || !sig?.signature) return { valid: false, reason: 'X-EBAY-SIGNATURE missing kid/signature' };

  const { pem, digest } = await getEbayPublicKey(sig.kid);
  if (!pem) return { valid: false, reason: 'eBay returned an empty public key' };
  const algorithm = (sig.digest || digest || 'SHA1').toLowerCase().replace('-', '');
  const candidates = [rawBody, parsedBody != null ? JSON.stringify(parsedBody) : null].filter(Boolean);
  for (const payload of candidates) {
    try {
      const ok = crypto.verify(algorithm, Buffer.from(payload, 'utf8'), pem, Buffer.from(sig.signature, 'base64'));
      if (ok) return { valid: true, reason: null };
    } catch (e) {
      log('signature verify threw: %s', e?.message);
    }
  }
  return { valid: false, reason: 'signature mismatch' };
}

/** Finds (or creates) the Notification API destination for our endpoint. App token. */
async function ensureEbayDestination() {
  const endpoint = getEbayNotificationEndpointUrl();
  if (!endpoint || !endpoint.toLowerCase().startsWith('https://')) {
    const err = new Error('eBay notification endpoint is not configured (set EBAY_NOTIFICATION_ENDPOINT_URL or OFA_PUBLIC_API_BASE_URL, https).');
    err.status = 500;
    throw err;
  }
  if (!getVerificationToken()) {
    const err = new Error('EBAY_VERIFICATION_TOKEN is not configured (32-80 chars: letters, digits, _ or -).');
    err.status = 500;
    throw err;
  }
  const appToken = await getEbayAppToken();
  const list = await ebayApiCall({ method: 'GET', path: `${NOTIFICATION_BASE}/destination`, accessToken: appToken, params: { limit: 100 } });
  if (isOk(list)) {
    const existing = (list.data?.destinations || []).find((d) => d?.deliveryConfig?.endpoint === endpoint);
    if (existing?.destinationId) return existing.destinationId;
  }
  // Creating a destination makes eBay send the challenge GET to our endpoint right away.
  const created = await ebayApiCall({
    method: 'POST',
    path: `${NOTIFICATION_BASE}/destination`,
    accessToken: appToken,
    body: {
      name: String(process.env.EBAY_NOTIFICATION_DESTINATION_NAME || 'FinerWorks OFA').slice(0, 64),
      status: 'ENABLED',
      deliveryConfig: { endpoint, verificationToken: getVerificationToken() },
    },
  });
  if (!isOk(created)) throw ebayError('Failed to create eBay notification destination', created);
  const location = created.headers?.location || '';
  return created.data?.destinationId || location.split('/').pop() || null;
}

/** Topic metadata (scope + supported payload schema version). App token. */
async function getEbayTopic(topicId) {
  const appToken = await getEbayAppToken();
  const r = await ebayApiCall({ method: 'GET', path: `${NOTIFICATION_BASE}/topic/${encodeURIComponent(topicId)}`, accessToken: appToken });
  if (!isOk(r)) throw ebayError(`eBay notification topic ${topicId} is not available for this app`, r);
  return r.data;
}

/**
 * Subscribes a seller (user token) to the order notification topic. Returns the subscription id.
 * Reuses an existing subscription for the same topic + destination.
 */
async function createEbayOrderSubscription(userAccessToken) {
  const topicId = getOrderTopicId();
  const topic = await getEbayTopic(topicId);
  const payloadSpec = (topic?.supportedPayloads || [])[0] || {};
  const destinationId = await ensureEbayDestination();

  const existing = await ebayApiCall({ method: 'GET', path: `${NOTIFICATION_BASE}/subscription`, accessToken: userAccessToken, params: { limit: 100 } });
  if (isOk(existing)) {
    const hit = (existing.data?.subscriptions || []).find((s) => s?.topicId === topicId && s?.destinationId === destinationId);
    if (hit?.subscriptionId) {
      if (hit.status !== 'ENABLED') {
        await ebayApiCall({ method: 'POST', path: `${NOTIFICATION_BASE}/subscription/${hit.subscriptionId}/enable`, accessToken: userAccessToken });
      }
      return { subscriptionId: hit.subscriptionId, destinationId, topicId, reused: true };
    }
  }

  const r = await ebayApiCall({
    method: 'POST',
    path: `${NOTIFICATION_BASE}/subscription`,
    accessToken: userAccessToken,
    body: {
      topicId,
      status: 'ENABLED',
      destinationId,
      payload: {
        format: payloadSpec.format?.[0] || 'JSON',
        schemaVersion: payloadSpec.schemaVersion || '1.0',
        deliveryProtocol: payloadSpec.deliveryProtocol || 'HTTPS',
      },
    },
  });
  if (!isOk(r)) throw ebayError(`Failed to subscribe to eBay topic ${topicId}`, r);
  const location = r.headers?.location || '';
  return { subscriptionId: r.data?.subscriptionId || location.split('/').pop() || null, destinationId, topicId, reused: false };
}

async function deleteEbayOrderSubscription(userAccessToken, subscriptionId) {
  if (!subscriptionId) return;
  const r = await ebayApiCall({ method: 'DELETE', path: `${NOTIFICATION_BASE}/subscription/${encodeURIComponent(subscriptionId)}`, accessToken: userAccessToken });
  if (!isOk(r) && r.status !== 404) {
    log('deleteEbayOrderSubscription failed: %o', summarizeEbayHttpError({ response: r }));
    throw ebayError('Failed to delete eBay notification subscription', r);
  }
}

/** Depth-first search for the first value under any of `keys` in a notification payload. */
function findDeep(obj, keys, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  for (const k of keys) {
    if (obj[k] != null && typeof obj[k] !== 'object' && String(obj[k]).trim()) return String(obj[k]).trim();
  }
  for (const v of Object.values(obj)) {
    const hit = findDeep(v, keys, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Pulls topic + seller + order identifiers out of a notification, whatever the topic's schema. */
function parseEbayNotification(body) {
  const topic = body?.metadata?.topic || body?.topic || null;
  const data = body?.notification?.data || body?.notification || body?.data || {};
  return {
    topic,
    notificationId: body?.notification?.notificationId || null,
    orderId: findDeep(data, ['orderId', 'order_id']),
    userId: findDeep(data, ['userId', 'sellerUserId', 'eiasToken']),
    username: findDeep(data, ['username', 'sellerUsername', 'sellerId', 'seller']),
  };
}

module.exports = {
  getVerificationToken,
  getEbayNotificationEndpointUrl,
  getOrderTopicId,
  computeChallengeResponse,
  verifyEbayNotificationSignature,
  ensureEbayDestination,
  createEbayOrderSubscription,
  deleteEbayOrderSubscription,
  parseEbayNotification,
  toPem,
};
