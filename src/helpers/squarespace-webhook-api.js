const axios = require('axios');

const SQUARESPACE_WEBHOOKS_URL = 'https://api.squarespace.com/1.0/webhook_subscriptions';

function squarespaceHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': process.env.SQUARESPACE_USER_AGENT || 'ofa-node',
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}

async function listSquarespaceWebhookSubscriptions(accessToken) {
  const resp = await axios.get(SQUARESPACE_WEBHOOKS_URL, {
    headers: squarespaceHeaders(accessToken),
    timeout: 60000
  });
  return Array.isArray(resp?.data?.webhookSubscriptions) ? resp.data.webhookSubscriptions : [];
}

async function createSquarespaceWebhookSubscription(accessToken, { endpointUrl, topics }) {
  const resp = await axios.post(
    SQUARESPACE_WEBHOOKS_URL,
    {
      endpointUrl,
      topics
    },
    {
      headers: squarespaceHeaders(accessToken),
      timeout: 60000
    }
  );
  return resp?.data || null;
}

async function deleteSquarespaceWebhookSubscription(accessToken, subscriptionId) {
  await axios.delete(`${SQUARESPACE_WEBHOOKS_URL}/${encodeURIComponent(String(subscriptionId).trim())}`, {
    headers: squarespaceHeaders(accessToken),
    timeout: 60000,
    validateStatus: (status) => status === 204 || status === 404
  });
}

function findOrderCreateSubscription(subscriptions, endpointUrl) {
  const target = String(endpointUrl || '').trim();
  return (
    subscriptions.find((sub) => {
      const url = String(sub?.endpointUrl || '').trim();
      const topics = Array.isArray(sub?.topics) ? sub.topics : [];
      return url === target && topics.includes('order.create');
    }) || null
  );
}

module.exports = {
  listSquarespaceWebhookSubscriptions,
  createSquarespaceWebhookSubscription,
  deleteSquarespaceWebhookSubscription,
  findOrderCreateSubscription
};
