const axios = require('axios');
const debug = require('debug');
const log = debug('app:ebayApi');

/**
 * Shared eBay REST plumbing: environment (sandbox vs production) host map, OAuth scopes,
 * the application (client-credentials) token, and a single call helper used by every eBay
 * controller.
 *
 * eBay keeps sandbox and production completely separate (different keys, RuName, hosts, test
 * users), so EBAY_ENV picks the whole set at once:
 *   - auth host  : where the seller signs in and grants consent
 *   - api host   : every Sell/Commerce REST API + the OAuth token endpoint
 *   - apiz host  : the Identity API (GET /commerce/identity/v1/user/) lives on its own host
 */
const EBAY_HOSTS = {
  production: {
    auth: 'https://auth.ebay.com',
    api: 'https://api.ebay.com',
    apiz: 'https://apiz.ebay.com',
  },
  sandbox: {
    auth: 'https://auth.sandbox.ebay.com',
    api: 'https://api.sandbox.ebay.com',
    apiz: 'https://apiz.sandbox.ebay.com',
  },
};

function getEbayEnv() {
  const v = String(process.env.EBAY_ENV || 'sandbox').trim().toLowerCase();
  return v === 'production' || v === 'prod' ? 'production' : 'sandbox';
}

function getEbayHosts() {
  return EBAY_HOSTS[getEbayEnv()];
}

const getEbayClientId = () => String(process.env.EBAY_CLIENT_ID || '').trim();
const getEbayClientSecret = () => String(process.env.EBAY_CLIENT_SECRET || '').trim();
const getEbayRuName = () => String(process.env.EBAY_RUNAME || '').trim();
const getEbayMarketplaceId = () => String(process.env.EBAY_MARKETPLACE_ID || 'EBAY_US').trim();
const getEbayCurrency = () => String(process.env.EBAY_CURRENCY || 'USD').trim();
const getEbayContentLanguage = () => String(process.env.EBAY_CONTENT_LANGUAGE || 'en-US').trim();

/**
 * User-consent scopes requested on connect. eBay only issues tokens for scopes the app's keyset
 * is granted in the developer portal, and a refresh must ask for the same (or a subset of the)
 * scopes the seller consented to — so this one list is reused for both.
 *   sell.inventory   -> listings (inventory items, offers, publish)
 *   sell.account     -> business policies (shipping/payment/return), program opt-in
 *   sell.fulfillment -> orders + shipping fulfillment (tracking)
 *   commerce.identity.readonly -> the seller's eBay userId/username (maps notifications to an account)
 *   commerce.notification.subscription -> per-seller order notification subscriptions
 */
const DEFAULT_EBAY_USER_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
  'https://api.ebay.com/oauth/api_scope/commerce.notification.subscription',
];

function getEbayUserScopes() {
  const fromEnv = String(process.env.EBAY_SCOPES || '').trim();
  if (fromEnv) return fromEnv.split(/[\s,]+/).filter(Boolean);
  return DEFAULT_EBAY_USER_SCOPES;
}

function basicAuthHeader() {
  const id = getEbayClientId();
  const secret = getEbayClientSecret();
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
}

/** POST to eBay's OAuth token endpoint (code exchange, refresh, client credentials). */
async function postEbayToken(form) {
  return axios.post(`${getEbayHosts().api}/identity/v1/oauth2/token`, new URLSearchParams(form).toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(),
    },
    timeout: 20000,
  });
}

/**
 * Application access token (client-credentials grant). Used for calls that act as the app
 * rather than a seller: Taxonomy (categories/item specifics), Notification public keys and
 * destinations. Cached in memory until 5 minutes before expiry (Lambda containers reuse it).
 */
let appTokenCache = { token: null, expiresAt: 0, env: null };
async function getEbayAppToken() {
  const env = getEbayEnv();
  if (appTokenCache.token && appTokenCache.env === env && Date.now() < appTokenCache.expiresAt - 5 * 60_000) {
    return appTokenCache.token;
  }
  if (!getEbayClientId() || !getEbayClientSecret()) {
    const err = new Error('EBAY_CLIENT_ID / EBAY_CLIENT_SECRET not configured');
    err.status = 500;
    throw err;
  }
  const resp = await postEbayToken({
    grant_type: 'client_credentials',
    scope: 'https://api.ebay.com/oauth/api_scope',
  });
  const token = resp?.data?.access_token;
  if (!token) {
    const err = new Error('eBay did not return an application access token');
    err.status = 502;
    throw err;
  }
  appTokenCache = {
    token,
    expiresAt: Date.now() + (Number(resp.data.expires_in) || 7200) * 1000,
    env,
  };
  return token;
}

/**
 * One eBay REST call. Never throws on HTTP status (validateStatus: always true) so callers can
 * read eBay's error envelope ({ errors: [{ errorId, message, longMessage, parameters }] }) and
 * decide what to do; network errors still throw.
 *
 * `host`: 'api' (default) or 'apiz' (Identity API).
 * Inventory/offer writes require Content-Language, so it is always sent.
 */
async function ebayApiCall({ method = 'GET', path, accessToken, params, body, headers = {}, host = 'api', timeout = 60000 }) {
  const base = getEbayHosts()[host] || getEbayHosts().api;
  return axios({
    method,
    url: `${base}${path}`,
    params,
    data: body === undefined || body === null ? undefined : body,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Content-Language': getEbayContentLanguage(),
      'X-EBAY-C-MARKETPLACE-ID': getEbayMarketplaceId(),
      ...headers,
    },
    timeout,
    validateStatus: () => true,
  });
}

function isOk(resp) {
  return resp && resp.status >= 200 && resp.status < 300;
}

/** Compact, log-safe view of an eBay error (no tokens, no request bodies). */
function summarizeEbayHttpError(errOrResp) {
  const resp = errOrResp?.response || (errOrResp?.status && errOrResp?.data !== undefined ? errOrResp : null);
  const data = resp?.data;
  if (!data) return { message: errOrResp?.message || 'Unknown error', httpStatus: resp?.status || null };
  const first = Array.isArray(data.errors) ? data.errors[0] : null;
  return {
    httpStatus: resp?.status || null,
    errorId: first?.errorId ?? null,
    message: first?.message || data.error_description || data.error || errOrResp?.message || 'Unknown error',
    longMessage: first?.longMessage || null,
    parameters: Array.isArray(first?.parameters) ? first.parameters : undefined,
    errors: Array.isArray(data.errors) && data.errors.length > 1
      ? data.errors.map((e) => ({ errorId: e?.errorId, message: e?.message }))
      : undefined,
  };
}

/** Build an Error carrying an eBay response so the shared catch blocks can summarize it. */
function ebayError(message, resp, status) {
  const err = new Error(message);
  err.response = resp;
  err.status = status || (resp?.status >= 400 ? resp.status : 502);
  err.data = summarizeEbayHttpError({ response: resp });
  return err;
}

function isEbayUrl(err) {
  const url = err?.response?.config?.url || err?.config?.url || '';
  return /ebay\.com/i.test(url);
}

log('eBay API helper loaded (env=%s)', getEbayEnv());

module.exports = {
  EBAY_HOSTS,
  getEbayEnv,
  getEbayHosts,
  getEbayClientId,
  getEbayClientSecret,
  getEbayRuName,
  getEbayMarketplaceId,
  getEbayCurrency,
  getEbayContentLanguage,
  getEbayUserScopes,
  postEbayToken,
  getEbayAppToken,
  ebayApiCall,
  isOk,
  summarizeEbayHttpError,
  ebayError,
  isEbayUrl,
};
