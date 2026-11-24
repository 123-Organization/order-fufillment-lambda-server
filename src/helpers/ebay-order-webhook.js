const finerworksService = require('./finerworks-service');
const {
  FINERWORKS_EMPTY_PRODUCT_GUID,
  enrichOrderItemsWithProductGuids,
} = require('./tiktok-order-webhook');
const debug = require('debug');
const log = debug('app:ebayOrderWebhook');

/**
 * eBay order (Fulfillment API `GET /sell/fulfillment/v1/order/{orderId}`) -> FinerWorks
 * submit_orders_v2 mapping, readiness rules, and the one submit path shared by the
 * notification webhook and the scheduled order poll.
 */

function placeholderProductImage() {
  return {
    pixel_width: 600,
    pixel_height: 600,
    product_url_file: 'https://via.placeholder.com/150',
    product_url_thumbnail: 'https://via.placeholder.com/150',
  };
}

function isValidFinerWorksShippingCode(value) {
  const code = value != null ? String(value).trim() : '';
  return Boolean(code && code.length <= 2 && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(code));
}

function resolveDefaultShippingCode(shippingOptions) {
  const fromEnv = process.env.EBAY_DEFAULT_SHIPPING_CODE;
  if (fromEnv != null && String(fromEnv).trim() && isValidFinerWorksShippingCode(fromEnv)) {
    return String(fromEnv).trim();
  }
  const opts = shippingOptions?.shipping_options ?? shippingOptions;
  if (Array.isArray(opts)) {
    for (const opt of opts) {
      const code = opt?.shipping_code != null ? String(opt.shipping_code).trim() : '';
      if (isValidFinerWorksShippingCode(code)) return code;
    }
  }
  return '01';
}

/** eBay order ids look like `12-34567-89012`; order_po keeps only letters and digits. */
function buildEbayOrderPo(order) {
  return order?.orderId ? String(order.orderId).replace(/[^A-Za-z0-9]/g, '') : null;
}

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/** The first SHIPPING fulfillment instruction's ship-to (eBay gives the full address to the seller). */
function getShipTo(order) {
  const instructions = Array.isArray(order?.fulfillmentStartInstructions) ? order.fulfillmentStartInstructions : [];
  const step = instructions.find((i) => i?.shippingStep?.shipTo)?.shippingStep;
  return step?.shipTo || null;
}

/** Never invents placeholder address values; returns what's missing instead (same rule as TikTok). */
function buildRecipientFromEbayOrder(order, orderPo) {
  const shipTo = getShipTo(order) || {};
  const addr = shipTo.contactAddress || {};
  const { first, last } = splitName(shipTo.fullName);
  const countryCode = addr.countryCode ? String(addr.countryCode).toLowerCase() : null;
  const isUs = countryCode === 'us';
  const state = addr.stateOrProvince ? String(addr.stateOrProvince).trim() : null;
  const zip = addr.postalCode ? String(addr.postalCode).trim() : null;

  const missingFields = [];
  if (!first) missingFields.push('first_name');
  if (!last) missingFields.push('last_name');
  if (!addr.addressLine1) missingFields.push('address_1');
  if (!addr.city) missingFields.push('city');
  if (!countryCode) missingFields.push('country_code');
  if (isUs && !state) missingFields.push('state_code');
  if (!zip) missingFields.push('zip_postal_code');

  return {
    recipient: {
      first_name: first,
      last_name: last,
      company_name: shipTo.companyName || null,
      address_1: addr.addressLine1 || null,
      address_2: addr.addressLine2 || null,
      address_3: null,
      city: addr.city || null,
      // US: eBay already returns the 2-letter state code (e.g. "CA").
      state_code: isUs && state ? state.slice(0, 2).toLowerCase() : null,
      province: !isUs ? state || '' : '',
      zip_postal_code: isUs && zip ? zip.slice(0, 5) : zip,
      country_code: countryCode,
      phone: shipTo.primaryPhone?.phoneNumber || null,
      email: shipTo.email || order?.buyer?.buyerRegistrationAddress?.email || null,
      address_order_po: orderPo,
    },
    missingFields,
  };
}

function ebayLineItemIsFinerWorks(li) {
  const sku = li?.sku != null ? String(li.sku).trim() : '';
  return Boolean(sku) && sku.toUpperCase().startsWith('AP');
}

/**
 * eBay readiness rule: submit only orders that are paid, not cancelled, and not yet shipped.
 * Returns { ready, reason }.
 */
function isEbayOrderReadyForFulfillment(order) {
  const payment = String(order?.orderPaymentStatus || '').toUpperCase();
  const fulfillment = String(order?.orderFulfillmentStatus || '').toUpperCase();
  const cancelState = String(order?.cancelStatus?.cancelState || 'NONE_REQUESTED').toUpperCase();
  if (payment !== 'PAID') return { ready: false, reason: `payment status is ${payment || 'unknown'}` };
  if (cancelState === 'CANCELED' || cancelState === 'IN_PROGRESS') return { ready: false, reason: `cancel state is ${cancelState}` };
  if (fulfillment === 'FULFILLED') return { ready: false, reason: 'order is already fulfilled' };
  return { ready: true, reason: null };
}

function isTestMode() {
  return String(process.env.EBAY_ORDER_TEST_MODE ?? 'true').trim().toLowerCase() !== 'false';
}

function transformEbayOrderToFinerWorksPayload(order, { shippingOptions = null } = {}) {
  const orderPo = buildEbayOrderPo(order);
  const { recipient, missingFields } = buildRecipientFromEbayOrder(order, orderPo);
  const lineItems = Array.isArray(order?.lineItems) ? order.lineItems : [];
  const orderItems = lineItems.filter(ebayLineItemIsFinerWorks).map((li) => ({
    product_order_po: orderPo,
    product_qty: Number(li?.quantity) > 0 ? Math.round(Number(li.quantity)) : 1,
    product_sku: String(li.sku).trim(),
    product_image: placeholderProductImage(),
    product_title: li?.title || null,
    template: null,
    product_guid: FINERWORKS_EMPTY_PRODUCT_GUID,
    custom_data_1: li?.legacyItemId ? String(li.legacyItemId) : null,
    custom_data_2: li?.lineItemId ? String(li.lineItemId) : null,
    custom_data_3: null,
  }));

  return {
    order_po: orderPo,
    order_key: null,
    recipient,
    recipientMissingFields: missingFields,
    order_items: orderItems,
    shipping_code: resolveDefaultShippingCode(shippingOptions),
    ship_by_date: null,
    customs_tax_info: null,
    gift_message: null,
    test_mode: isTestMode(),
    webhook_order_status_url: null,
    document_url: null,
    acct_number_ups: null,
    acct_number_fedex: null,
    custom_data_1: order?.orderId ? String(order.orderId) : null,
    custom_data_2: order?.buyer?.username ? String(order.buyer.username) : null,
    custom_data_3: null,
    source: 'ebay',
  };
}

function resolveApiBaseUrl() {
  return String(process.env.OFA_PUBLIC_API_BASE_URL || '').trim().replace(/\/$/, '');
}

/** FinerWorks order-status callback -> POST /api/ebay/fulfill-order (pushes tracking to eBay). */
function buildEbayFulfillmentWebhookUrl({ account_key, orderNumber, orderId }) {
  const apiBase = resolveApiBaseUrl();
  if (!apiBase) return null;
  const params = new URLSearchParams({
    account_key: String(account_key),
    orderNumber: String(orderNumber || ''),
    order_id: String(orderId || ''),
  });
  return `${apiBase}/api/ebay/fulfill-order?${params.toString()}`;
}

/**
 * true  -> FinerWorks already has this order_po (skip),
 * false -> not found (safe to submit),
 * null  -> lookup failed (caller should NOT submit; the next poll/notification retries).
 */
async function isAlreadyInFinerWorks(orderPo, account_key) {
  try {
    const r = await finerworksService.GET_ORDER_STATUS({ order_pos: [orderPo], account_key });
    return Array.isArray(r?.orders) && r.orders.some((o) => String(o?.order_po || '') === String(orderPo));
  } catch (e) {
    if (e?.response?.status === 404) return false;
    log('isAlreadyInFinerWorks lookup failed for %s: %s', orderPo, e?.message);
    return null;
  }
}

/**
 * Validates, maps and submits one eBay order to FinerWorks. Never throws for business outcomes;
 * returns { status: 'submitted' | 'skipped' | 'failed', reason, order_po, ... }.
 * `trace(step, message, data)` receives step-by-step logs.
 */
async function submitEbayOrderToFinerWorks(order, account_key, { trace = () => {} } = {}) {
  const orderId = order?.orderId || null;
  const readiness = isEbayOrderReadyForFulfillment(order);
  if (!readiness.ready) {
    trace('A', `skip ${orderId}: ${readiness.reason}`);
    return { status: 'skipped', reason: readiness.reason, orderId };
  }

  let shippingOptions = null;
  try {
    shippingOptions = await finerworksService.SHIPPING_OPTIONS_LIST();
  } catch (e) {
    log('SHIPPING_OPTIONS_LIST failed (using default code): %s', e?.message);
  }
  const transformed = transformEbayOrderToFinerWorksPayload(order, {
    shippingOptions: shippingOptions?.shipping_options ?? shippingOptions,
  });
  trace('B', 'Mapped to FinerWorks order', {
    order_po: transformed.order_po,
    skus: transformed.order_items.map((i) => i.product_sku),
    shipping_code: transformed.shipping_code,
    test_mode: transformed.test_mode,
    missing: transformed.recipientMissingFields,
  });

  if (!transformed.order_items.length) {
    return { status: 'skipped', reason: 'no FinerWorks line items (eBay SKU must start with AP)', orderId, order_po: transformed.order_po };
  }
  if (transformed.recipientMissingFields.length) {
    return {
      status: 'failed',
      reason: `missing recipient fields: ${transformed.recipientMissingFields.join(', ')}`,
      orderId,
      order_po: transformed.order_po,
    };
  }
  delete transformed.recipientMissingFields;

  const existing = await isAlreadyInFinerWorks(transformed.order_po, account_key);
  trace('C', `Already in FinerWorks: ${existing === null ? 'lookup failed' : existing}`);
  if (existing === true) return { status: 'skipped', reason: 'already submitted to FinerWorks', orderId, order_po: transformed.order_po };
  if (existing === null) return { status: 'failed', reason: 'could not check FinerWorks for an existing order; will retry', orderId, order_po: transformed.order_po };

  transformed.order_items = await enrichOrderItemsWithProductGuids(transformed.order_items, account_key);
  const fulfillmentUrl = buildEbayFulfillmentWebhookUrl({ account_key, orderNumber: transformed.order_po, orderId });
  if (fulfillmentUrl) transformed.webhook_order_status_url = fulfillmentUrl;

  const finalPayload = {
    orders: [transformed],
    validate_only: false,
    payment_token: process.env.EBAY_WEBHOOK_PAYMENT_TOKEN || 'xxxx',
    account_key,
  };
  trace('D', 'FinerWorks payload (payment_token masked)', { ...finalPayload, payment_token: '***' });

  try {
    const submitData = await finerworksService.SUBMIT_ORDERS(finalPayload);
    trace('E', 'FinerWorks submit response', submitData);
    return { status: 'submitted', orderId, order_po: transformed.order_po, submitData };
  } catch (e) {
    const finerworksError = e?.response?.data ?? e?.message ?? null;
    trace('E', 'FinerWorks submit FAILED', finerworksError);
    return {
      status: 'failed',
      reason: 'FinerWorks rejected the order',
      orderId,
      order_po: transformed.order_po,
      finerworksStatus: e?.response?.status || null,
      finerworksError,
    };
  }
}

module.exports = {
  buildEbayOrderPo,
  buildRecipientFromEbayOrder,
  transformEbayOrderToFinerWorksPayload,
  isEbayOrderReadyForFulfillment,
  ebayLineItemIsFinerWorks,
  buildEbayFulfillmentWebhookUrl,
  submitEbayOrderToFinerWorks,
};
