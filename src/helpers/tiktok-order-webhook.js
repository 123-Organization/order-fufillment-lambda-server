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

function isValidFinerWorksShippingCode(value) {
  const code = value != null ? String(value).trim() : '';
  return Boolean(code && code.length <= 2 && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(code));
}

function resolveDefaultShippingCode(shippingOptions) {
  const fromEnv = process.env.TIKTOK_DEFAULT_SHIPPING_CODE;
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

/** TikTok order ids are numeric strings; order_po just strips any stray non-alphanumerics. */
function buildTiktokOrderPo(order) {
  return order?.id ? String(order.id).replace(/[^A-Za-z0-9]/g, '') : null;
}

function normalizeZipForFinerWorks(zip) {
  if (zip == null || String(zip).trim() === '') return null;
  const digits = String(zip).replace(/\D/g, '');
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Finds a district_info entry by matching its address_level_name against a pattern —
 * TikTok's address hierarchy varies by region/market and isn't flatly "city"/"state" like
 * most other platforms in this codebase, so this is a best-effort label match, not a fixed
 * index into the array. */
function findDistrictByLevel(districtInfo, pattern) {
  if (!Array.isArray(districtInfo)) return null;
  const hit = districtInfo.find((d) => pattern.test(String(d?.address_level_name || '')));
  return hit?.address_name || null;
}

/**
 * Maps a TikTok order's recipient_address to FinerWorks' recipient shape. Never invents
 * placeholder values for fields FinerWorks requires (no "Address pending" / "N/A" / fake "na"
 * state codes) — a placeholder either gets silently submitted as a real address or FinerWorks
 * rejects it downstream with a generic, unhelpful error. Returns `missingFields` (empty when
 * nothing's missing) so the caller can report the actual problem instead.
 */
function buildRecipientFromTiktokOrder(order, orderPoDisplay) {
  const addr = order?.recipient_address || {};
  const districtInfo = addr?.district_info || [];

  const firstName = addr.first_name || null;
  const lastName = addr.last_name || null;
  const addressLine = addr.address_line1 || null;
  const stateName = findDistrictByLevel(districtInfo, /state|province|region/i);
  const city = findDistrictByLevel(districtInfo, /city|district|town/i) || null;
  const countryCode = addr.region_code && String(addr.region_code).length === 2
    ? String(addr.region_code).toLowerCase()
    : null;
  const isUs = countryCode === 'us';
  const zip = normalizeZipForFinerWorks(addr.postal_code);

  const missingFields = [];
  if (!firstName) missingFields.push('first_name');
  if (!lastName) missingFields.push('last_name');
  if (!addressLine) missingFields.push('address_1');
  if (!city) missingFields.push('city');
  if (!countryCode) missingFields.push('country_code');
  if (countryCode && isUs && !stateName) missingFields.push('state_code');
  if (countryCode && !isUs && !stateName) missingFields.push('province');
  if (!zip) missingFields.push('zip_postal_code');

  const recipient = {
    first_name: firstName,
    last_name: lastName,
    company_name: null,
    address_1: addressLine,
    address_2: addr.address_line2 || null,
    address_3: [addr.address_line3, addr.address_line4].filter(Boolean).join(' ') || null,
    city,
    state_code: isUs ? (stateName ? String(stateName).toLowerCase().slice(0, 2) : null) : null,
    province: countryCode && !isUs ? stateName || null : '',
    zip_postal_code: zip,
    country_code: countryCode,
    phone: addr.phone_number || null,
    email: order?.buyer_email || null,
    address_order_po: orderPoDisplay,
  };

  return { recipient, missingFields };
}

function tiktokLineItemSkuStartsWithAP(lineItem) {
  const sku = lineItem?.seller_sku != null ? String(lineItem.seller_sku).trim() : '';
  if (!sku) return false;
  return sku.toUpperCase().startsWith('AP');
}

/**
 * Maps a TikTok Shop order (from GET /order/202309/orders) to FinerWorks' submit-order shape.
 * Mirrors transformSquareOrderToFinerWorksPayload/transformWixOrderToFinerWorksPayload.
 */
function transformTiktokOrderToFinerWorksPayload(order, { shippingOptions = null } = {}) {
  const orderPoDisplay = buildTiktokOrderPo(order);
  const { recipient, missingFields: recipientMissingFields } = buildRecipientFromTiktokOrder(order, orderPoDisplay);

  const lineItems = Array.isArray(order?.line_items) ? order.line_items : [];
  const orderItems = lineItems.filter(tiktokLineItemSkuStartsWithAP).map((li) => {
    const imageUrl = li?.sku_image || null;
    return {
      product_order_po: orderPoDisplay || null,
      product_qty: Number.isFinite(Number(li?.quantity)) && Number(li.quantity) > 0 ? Math.round(Number(li.quantity)) : 1,
      product_sku: li?.seller_sku ? String(li.seller_sku).trim() : null,
      product_image: imageUrl
        ? { pixel_width: 600, pixel_height: 600, product_url_file: imageUrl, product_url_thumbnail: imageUrl }
        : placeholderProductImage(),
      product_title: li?.product_name || null,
      template: null,
      product_guid: FINERWORKS_EMPTY_PRODUCT_GUID,
      custom_data_1: li?.sku_id ? String(li.sku_id) : null,
      custom_data_2: li?.id ? String(li.id) : null,
      custom_data_3: null,
    };
  });

  return {
    order_po: orderPoDisplay || null,
    order_key: null,
    recipient,
    recipientMissingFields,
    order_items: orderItems,
    // TikTok orders don't expose a shipping-method title to match against FinerWorks options.
    shipping_code: resolveDefaultShippingCode(shippingOptions),
    ship_by_date: null,
    customs_tax_info: null,
    gift_message: null,
    test_mode: true,
    webhook_order_status_url: null,
    document_url: null,
    acct_number_ups: null,
    acct_number_fedex: null,
    custom_data_1: order?.id ? String(order.id) : null,
    custom_data_2: order?.warehouse_id ? String(order.warehouse_id) : null,
    custom_data_3: null,
    source: 'tiktok',
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

function resolveTiktokApiBaseUrl() {
  const fromEnv = process.env.OFA_PUBLIC_API_BASE_URL || process.env.TIKTOK_ORDER_CREATE_WEBHOOK_URL || '';
  return String(fromEnv).trim().replace(/\/$/, '');
}

/** FinerWorks order-status callback -> POST /api/tiktok/fulfill-order. */
function buildTiktokFulfillmentWebhookUrl({ account_key, orderNumber, orderId }) {
  const apiBase = resolveTiktokApiBaseUrl();
  if (!apiBase) return null;
  const params = new URLSearchParams({
    account_key: String(account_key),
    orderNumber: String(orderNumber || ''),
    order_id: String(orderId || ''),
  });
  return `${apiBase}/api/tiktok/fulfill-order?${params.toString()}`;
}

/** Per-account TikTok order-status-change webhook URL — account_key rides in the query string
 * since TikTok's webhook payload carries shop_id, not account_key (mirrors Squarespace's
 * per-tenant webhook URL pattern in platform-order-sync.js). Same OFA_PUBLIC_API_BASE_URL
 * fallback as resolveTiktokApiBaseUrl so one shared base URL covers both TikTok endpoints. */
function buildTiktokOrderWebhookUrl(account_key) {
  const apiBase = resolveTiktokApiBaseUrl();
  if (!apiBase) return null;
  return `${apiBase}/api/webhooks/tiktok/order-status-change?account_key=${encodeURIComponent(account_key)}`;
}

module.exports = {
  FINERWORKS_EMPTY_PRODUCT_GUID,
  buildTiktokOrderPo,
  buildRecipientFromTiktokOrder,
  transformTiktokOrderToFinerWorksPayload,
  tiktokLineItemSkuStartsWithAP,
  enrichOrderItemsWithProductGuids,
  buildTiktokFulfillmentWebhookUrl,
  buildTiktokOrderWebhookUrl,
};
