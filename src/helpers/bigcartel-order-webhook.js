const finerworksService = require('./finerworks-service');

const FINERWORKS_EMPTY_PRODUCT_GUID = '00000000-0000-0000-0000-000000000000';

function placeholderProductImage() {
  return {
    pixel_width: 600,
    pixel_height: 600,
    product_url_file: 'https://via.placeholder.com/150',
    product_url_thumbnail: 'https://via.placeholder.com/150',
  };
}

function normalizeZipForFinerWorks(zip) {
  if (zip == null || String(zip).trim() === '') return null;
  const digits = String(zip).replace(/\D/g, '');
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function buildBigcartelOrderPo(order) {
  return order?.id ? String(order.id).replace(/[^A-Za-z0-9]/g, '') : null;
}

/**
 * Maps a Big Cartel order's shipping_* fields to FinerWorks' recipient shape. Never invents
 * placeholder values for fields FinerWorks requires — same no-placeholder/missingFields
 * discipline used for every other platform's webhook transform in this codebase (TikTok,
 * and the earlier Wix fix this pattern originated from).
 *
 * UNCONFIRMED, flagged for live testing: `shipping_country_id` is documented only as an id —
 * Big Cartel's docs list a separate `GET /v1/countries` lookup resource, and it's not confirmed
 * whether that id IS the 2-letter ISO code (as used here, lowercased) or a numeric/other
 * identifier requiring a real lookup. Same for `shipping_state` — not confirmed whether it's
 * already a 2-letter code or a full state name.
 */
function buildRecipientFromBigcartelOrder(order, orderPoDisplay) {
  const firstName = order?.customer_first_name || null;
  const lastName = order?.customer_last_name || null;
  const addressLine = order?.shipping_address_1 || null;
  const city = order?.shipping_city || null;
  const stateRaw = order?.shipping_state || null;
  const countryRaw = order?.shipping_country_id != null ? String(order.shipping_country_id) : null;
  const countryCode = countryRaw && countryRaw.length === 2 ? countryRaw.toLowerCase() : countryRaw;
  const isUs = countryCode === 'us';
  const zip = normalizeZipForFinerWorks(order?.shipping_zip);

  const missingFields = [];
  if (!firstName) missingFields.push('first_name');
  if (!lastName) missingFields.push('last_name');
  if (!addressLine) missingFields.push('address_1');
  if (!city) missingFields.push('city');
  if (!countryCode) missingFields.push('country_code');
  if (!stateRaw) missingFields.push(isUs ? 'state_code' : 'province');
  if (!zip) missingFields.push('zip_postal_code');

  const recipient = {
    first_name: firstName,
    last_name: lastName,
    company_name: null,
    address_1: addressLine,
    address_2: order?.shipping_address_2 || null,
    address_3: null,
    city,
    state_code: isUs && stateRaw ? String(stateRaw).toLowerCase().slice(0, 2) : null,
    province: countryCode && !isUs ? stateRaw || null : '',
    zip_postal_code: zip,
    country_code: countryCode,
    phone: order?.customer_phone_number || null,
    email: order?.customer_email || null,
    address_order_po: orderPoDisplay,
  };

  return { recipient, missingFields };
}

/**
 * Maps a Big Cartel order (from GET /v1/accounts/{id}/orders/{order_id}?include=items) to
 * FinerWorks' submit-order shape.
 *
 * Big Cartel has no native sku field anywhere (see bigcartel-orders.js's header comment for the
 * three-source confirmation), so by the time an order reaches this function its line items have
 * already been run through resolveLineItemSkus (in bigcartel-orders.js / the webhook receiver
 * in platform-order-sync.js), which reads the merchant's `SKU:<value>` marker from each
 * product's description and combines it with the variant's option name. `item.sku` here is
 * that resolved value (or null if the merchant never added the marker to that product).
 * Filters to "SKU starts with AP" exactly like every other platform in this codebase, to
 * distinguish FinerWorks-fulfilled print products from a merchant's other listings.
 * `skuFieldMissing: true` means NONE of this order's items resolved a sku at all — most likely
 * every product in the order is missing the `SKU:` marker in its description — so the caller
 * refuses to auto-submit and surfaces a message pointing at the fix, rather than guessing.
 */
function transformBigcartelOrderToFinerWorksPayload(order, { shippingOptions = null } = {}) {
  const orderPoDisplay = buildBigcartelOrderPo(order);
  const { recipient, missingFields: recipientMissingFields } = buildRecipientFromBigcartelOrder(order, orderPoDisplay);

  const lineItems = Array.isArray(order?.items) ? order.items : [];
  const skuFieldMissing = lineItems.length > 0 && lineItems.every((li) => li?.sku == null);

  const orderItems = skuFieldMissing
    ? []
    : lineItems
      .filter((li) => li?.sku != null && String(li.sku).trim().toUpperCase().startsWith('AP'))
      .map((li) => ({
        product_order_po: orderPoDisplay || null,
        product_qty: Number.isFinite(Number(li?.quantity)) && Number(li.quantity) > 0 ? Math.round(Number(li.quantity)) : 1,
        product_sku: li?.sku ? String(li.sku).trim() : null,
        product_image: li?.image_url
          ? { pixel_width: 600, pixel_height: 600, product_url_file: li.image_url, product_url_thumbnail: li.image_url }
          : placeholderProductImage(),
        product_title: li?.product_name || null,
        template: null,
        product_guid: FINERWORKS_EMPTY_PRODUCT_GUID,
        custom_data_1: li?.product_id ? String(li.product_id) : null,
        custom_data_2: li?.product_option_id ? String(li.product_option_id) : null,
        custom_data_3: null,
      }));

  return {
    order_po: orderPoDisplay || null,
    order_key: null,
    recipient,
    recipientMissingFields,
    skuFieldMissing,
    order_items: orderItems,
    shipping_code: '01',
    ship_by_date: null,
    customs_tax_info: null,
    gift_message: order?.customer_note || null,
    test_mode: true,
    webhook_order_status_url: null,
    document_url: null,
    acct_number_ups: null,
    acct_number_fedex: null,
    custom_data_1: order?.id ? String(order.id) : null,
    custom_data_2: null,
    custom_data_3: null,
    source: 'bigcartel',
  };
}

function pickFinerWorksProductGuid(product) {
  if (!product || typeof product !== 'object') return null;
  const productGuid = product.product_guid ?? product.productGuid ?? null;
  if (productGuid && String(productGuid).trim() && String(productGuid).trim() !== FINERWORKS_EMPTY_PRODUCT_GUID) {
    return String(productGuid).trim();
  }
  const imageGuid = product.image_guid ?? product.imageGuid ?? null;
  if (imageGuid && String(imageGuid).trim() && String(imageGuid).trim() !== FINERWORKS_EMPTY_PRODUCT_GUID) {
    return String(imageGuid).trim();
  }
  return null;
}

async function enrichOrderItemsWithProductGuids(orderItems, account_key) {
  if (!Array.isArray(orderItems) || !orderItems.length) return orderItems;
  return Promise.all(
    orderItems.map(async (item) => {
      const skuStr = item?.product_sku != null ? String(item.product_sku).trim() : '';
      if (!skuStr || !account_key) {
        return { ...item, product_guid: FINERWORKS_EMPTY_PRODUCT_GUID, product_image: placeholderProductImage() };
      }
      try {
        const resp = await finerworksService.LIST_VIRTUAL_INVENTORY({ sku_filter: [skuStr], account_key });
        const product = resp?.products?.[0];
        const guid = pickFinerWorksProductGuid(product) || FINERWORKS_EMPTY_PRODUCT_GUID;
        const imageUrl = product?.image_url_1 || product?.image_url || null;
        return {
          ...item,
          product_guid: guid,
          product_image: imageUrl
            ? { pixel_width: 600, pixel_height: 600, product_url_file: imageUrl, product_url_thumbnail: imageUrl }
            : placeholderProductImage(),
        };
      } catch (_e) {
        return { ...item, product_guid: FINERWORKS_EMPTY_PRODUCT_GUID, product_image: placeholderProductImage() };
      }
    })
  );
}

function resolveBigcartelApiBaseUrl() {
  const fromEnv = process.env.OFA_PUBLIC_API_BASE_URL || process.env.BIGCARTEL_ORDER_CREATE_WEBHOOK_URL || '';
  return String(fromEnv).trim().replace(/\/$/, '');
}

/** FinerWorks order-status callback -> POST /api/bigcartel/fulfill-order. */
function buildBigcartelFulfillmentWebhookUrl({ account_key, orderNumber, orderId }) {
  const apiBase = resolveBigcartelApiBaseUrl();
  if (!apiBase) return null;
  const params = new URLSearchParams({
    account_key: String(account_key),
    orderNumber: String(orderNumber || ''),
    order_id: String(orderId || ''),
  });
  return `${apiBase}/api/bigcartel/fulfill-order?${params.toString()}`;
}

/** Per-account Big Cartel order webhook URL — account_key rides in the query string, same
 * pattern as every other per-tenant webhook URL in this codebase (Squarespace/TikTok), since
 * Big Cartel's webhook payload carries its own account_id, not our account_key. */
function buildBigcartelOrderWebhookUrl(account_key) {
  const apiBase = resolveBigcartelApiBaseUrl();
  if (!apiBase) return null;
  return `${apiBase}/api/webhooks/bigcartel/order-event?account_key=${encodeURIComponent(account_key)}`;
}

module.exports = {
  FINERWORKS_EMPTY_PRODUCT_GUID,
  buildBigcartelOrderPo,
  buildRecipientFromBigcartelOrder,
  transformBigcartelOrderToFinerWorksPayload,
  enrichOrderItemsWithProductGuids,
  buildBigcartelFulfillmentWebhookUrl,
  buildBigcartelOrderWebhookUrl,
};
