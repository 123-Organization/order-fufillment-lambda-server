const axios = require('axios');
const crypto = require('crypto');
const { getSquareBaseUrl, squareApiVersionHeader } = require('../controllers/square-auth');

const MAX_WEBHOOK_SUBSCRIPTION_PAGES = 20;

/**
 * OFA only wants PAID orders. Square fires order.created at creation time (possibly unpaid),
 * and a shipping order's state stays OPEN until fulfillment, so payment events are the
 * reliable "paid" signal: card payments complete via payment.updated (created fires as
 * APPROVED first), while cash/immediate captures can complete directly on payment.created.
 * The receiver gates on payment.status === COMPLETED plus a fully-paid check on the order.
 */
const SQUARE_ORDER_SYNC_EVENT_TYPES = ['payment.created', 'payment.updated'];

/**
 * Square webhook subscriptions are application-level (one subscription receives events for
 * every merchant that authorized the app), so they are managed with the application's
 * personal access token — merchant OAuth tokens are rejected by this API.
 */
function getSquareWebhookAccessToken() {
  const token = process.env.SQUARE_WEBHOOK_ACCESS_TOKEN || process.env.SQUARE_ACCESS_TOKEN || '';
  return String(token).trim() || null;
}

function squareWebhookHeaders(accessToken) {
  return {
    Authorization: `Bearer ${String(accessToken).trim()}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...squareApiVersionHeader(),
  };
}

async function listSquareWebhookSubscriptions(accessToken) {
  const baseUrl = getSquareBaseUrl();
  const subscriptions = [];
  let cursor = null;

  for (let page = 0; page < MAX_WEBHOOK_SUBSCRIPTION_PAGES; page++) {
    const resp = await axios.get(`${baseUrl}/v2/webhooks/subscriptions`, {
      headers: squareWebhookHeaders(accessToken),
      params: { include_disabled: true, ...(cursor ? { cursor } : {}) },
      timeout: 60000,
    });
    const pageSubs = Array.isArray(resp?.data?.subscriptions) ? resp.data.subscriptions : [];
    subscriptions.push(...pageSubs);
    if (!resp?.data?.cursor) break;
    cursor = resp.data.cursor;
  }

  return subscriptions;
}

async function createSquareWebhookSubscription(accessToken, { notificationUrl, eventTypes, name }) {
  const baseUrl = getSquareBaseUrl();
  const resp = await axios.post(
    `${baseUrl}/v2/webhooks/subscriptions`,
    {
      idempotency_key: crypto.randomUUID(),
      subscription: {
        name: name || 'OFA order sync',
        enabled: true,
        event_types: eventTypes,
        notification_url: notificationUrl,
      },
    },
    {
      headers: squareWebhookHeaders(accessToken),
      timeout: 60000,
    }
  );
  return resp?.data?.subscription || null;
}

async function updateSquareWebhookSubscription(accessToken, subscriptionId, patch) {
  const baseUrl = getSquareBaseUrl();
  const resp = await axios.put(
    `${baseUrl}/v2/webhooks/subscriptions/${encodeURIComponent(String(subscriptionId).trim())}`,
    { subscription: patch },
    {
      headers: squareWebhookHeaders(accessToken),
      timeout: 60000,
    }
  );
  return resp?.data?.subscription || null;
}

async function deleteSquareWebhookSubscription(accessToken, subscriptionId) {
  const baseUrl = getSquareBaseUrl();
  await axios.delete(
    `${baseUrl}/v2/webhooks/subscriptions/${encodeURIComponent(String(subscriptionId).trim())}`,
    {
      headers: squareWebhookHeaders(accessToken),
      timeout: 60000,
      validateStatus: (status) => status === 200 || status === 204 || status === 404,
    }
  );
}

/** Matches our notification URL with any order-sync event type (including the legacy
 *  order.created form, so pre-existing subscriptions are found and upgraded, not duplicated). */
function findOrderSyncSubscription(subscriptions, notificationUrl) {
  const target = String(notificationUrl || '').trim();
  return (
    subscriptions.find((sub) => {
      const url = String(sub?.notification_url || '').trim();
      const eventTypes = Array.isArray(sub?.event_types) ? sub.event_types : [];
      return (
        url === target &&
        (eventTypes.includes('order.created') ||
          SQUARE_ORDER_SYNC_EVENT_TYPES.some((t) => eventTypes.includes(t)))
      );
    }) || null
  );
}

function subscriptionHasEventTypes(subscription, eventTypes) {
  const existing = Array.isArray(subscription?.event_types) ? subscription.event_types : [];
  return eventTypes.every((t) => existing.includes(t));
}

module.exports = {
  SQUARE_ORDER_SYNC_EVENT_TYPES,
  getSquareWebhookAccessToken,
  listSquareWebhookSubscriptions,
  createSquareWebhookSubscription,
  updateSquareWebhookSubscription,
  deleteSquareWebhookSubscription,
  findOrderSyncSubscription,
  subscriptionHasEventTypes,
};
