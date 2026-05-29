/**
 * Routes exempt from optional account_key UUID validation.
 * Paths are relative to the /api mount (no /api prefix).
 * method: 'ALL' matches any HTTP verb.
 */
const SKIP_ACCOUNT_KEY_VALIDATION = [
  { method: 'GET', path: '/health-check' },

  // OAuth / install callbacks (external platforms; account_key usually absent)
  { method: 'GET', path: '/shopify/auth' },
  { method: 'GET', path: '/shopify/' },
  { method: 'POST', path: '/shopify/callback' },
  { method: 'GET', path: '/squarespace/auth' },
  { method: 'GET', path: '/squarespace/callback' },
  { method: 'GET', path: '/wix/oauth/start' },
  { method: 'GET', path: '/wix/oauth/install-return' },
  { method: 'POST', path: '/wix/oauth/callback' },
  { method: 'GET', path: '/wix/instance/connect' },

  // Inbound platform webhooks (no account_key or resolved elsewhere)
  { method: 'POST', path: '/webhooks/orders-create' },
  { method: 'POST', path: '/webhooks/product-delete' },
  { method: 'POST', path: '/webhooks/wix/order-create' },

  // Shopify carrier rate callback
  { method: 'POST', path: '/shopify/carrier-service/callback' }
];

function normalizeApiPath(path) {
  if (!path) return '/';
  const withLeading = path.startsWith('/') ? path : `/${path}`;
  if (withLeading.length > 1 && withLeading.endsWith('/')) {
    return withLeading.slice(0, -1);
  }
  return withLeading;
}

function pathsMatch(rulePath, requestPath) {
  return normalizeApiPath(rulePath) === normalizeApiPath(requestPath);
}

function shouldSkipAccountKeyValidation(req) {
  const path = normalizeApiPath(req.path || '');
  const method = (req.method || 'GET').toUpperCase();

  return SKIP_ACCOUNT_KEY_VALIDATION.some((rule) => {
    const methodOk = rule.method === 'ALL' || rule.method === method;
    if (!methodOk) return false;

    if (rule.pathPrefix) {
      const prefix = normalizeApiPath(rule.pathPrefix);
      return path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(prefix);
    }

    if (rule.path) {
      return pathsMatch(rule.path, path);
    }

    return false;
  });
}

module.exports = {
  SKIP_ACCOUNT_KEY_VALIDATION,
  shouldSkipAccountKeyValidation
};
