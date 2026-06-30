const axios = require('axios');
const finerworksService = require('./finerworks-service');

const SQUARESPACE_ORDERS_URL = 'https://api.squarespace.com/1.0/commerce/orders';
const FINERWORKS_EMPTY_PRODUCT_GUID = '00000000-0000-0000-0000-000000000000';

function squarespaceHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': process.env.SQUARESPACE_USER_AGENT || 'ofa-node',
    Accept: 'application/json',
  };
}

function normalizeZipForFinerWorks(zip) {
  if (zip == null || String(zip).trim() === '') return 0;
  const digits = String(zip).replace(/\D/g, '');
  const n = Number(digits);
  return Number.isFinite(n) ? n : 0;
}

function squarespaceLineItemSkuStartsWithAP(lineItem) {
  const sku = lineItem?.sku ?? null;
  if (sku == null) return false;
  return String(sku).trim().toUpperCase().startsWith('AP');
}

function looksLikeUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(value || '').trim());
}

function isValidFinerWorksShippingCode(value) {
  const code = value != null ? String(value).trim() : '';
  return Boolean(code && code.length <= 2 && !looksLikeUuid(code));
}

function finerWorksShippingCodeFromOption(option) {
  if (!option || typeof option !== 'object') return null;
  const shippingCode = option.shipping_code != null ? String(option.shipping_code).trim() : '';
  if (isValidFinerWorksShippingCode(shippingCode)) return shippingCode;
  const id = option.id != null ? String(option.id).trim() : '';
  if (isValidFinerWorksShippingCode(id)) return id;
  return null;
}

function matchShippingOptionId(title, options, carrierCode = null) {
  if (!Array.isArray(options) || !options.length) return null;
  const code = carrierCode != null ? String(carrierCode).trim() : '';
  // Squarespace shippingOptionServiceType may be a platform id, not a FinerWorks shipping_code.
  if (code && !looksLikeUuid(code)) {
    const byCode = options.find((o) => String(o?.shipping_code || '').trim() === code);
    if (byCode) return finerWorksShippingCodeFromOption(byCode);
    const byId = options.find((o) => String(o?.id || '').trim() === code);
    if (byId) return finerWorksShippingCodeFromOption(byId);
  }
  const t = title != null ? String(title).trim() : '';
  if (!t) return null;
  const exact = options.find((o) => o?.shipping_method === t);
  if (exact) return finerWorksShippingCodeFromOption(exact);
  const contains = options.find((o) =>
    String(o?.shipping_method || '')
      .toLowerCase()
      .includes(t.toLowerCase())
  );
  return contains ? finerWorksShippingCodeFromOption(contains) : null;
}

function resolveDefaultShippingCode(shippingOptions) {
  const fromEnv =
    process.env.SQUARESPACE_DEFAULT_SHIPPING_CODE || process.env.WIX_DEFAULT_SHIPPING_CODE;
  if (fromEnv != null && String(fromEnv).trim()) {
    const envCode = String(fromEnv).trim();
    if (isValidFinerWorksShippingCode(envCode)) return envCode;
  }
  const opts = shippingOptions?.shipping_options ?? shippingOptions;
  if (!Array.isArray(opts)) return '01';
  for (const opt of opts) {
    const code = finerWorksShippingCodeFromOption(opt);
    if (code) return code;
  }
  return '01';
}

function resolveSquarespaceShippingCode(order, shippingOptions) {
  const opts = shippingOptions?.shipping_options ?? shippingOptions;
  const shippingLine = Array.isArray(order?.shippingLines) ? order.shippingLines[0] : null;
  const shippingTitle = shippingLine?.method || order?.shippingOptionName || null;
  const shippingCodeRaw = order?.shippingOptionServiceType || null;
  const matched = matchShippingOptionId(shippingTitle, opts, shippingCodeRaw);
  if (matched != null) return String(matched);
  return resolveDefaultShippingCode(shippingOptions);
}

function buildRecipientFromSquarespaceOrder(order, orderPoDisplay) {
  const addr = order?.shippingAddress || order?.billingAddress || {};
  const country = (addr.countryCode || 'US').toLowerCase();
  const isUs = country === 'us';
  const stateRaw = addr.state ? String(addr.state).trim() : '';

  return {
    first_name: addr.firstName || 'Squarespace',
    last_name: addr.lastName || 'Customer',
    company_name: null,
    address_1: addr.address1 || 'Address pending',
    address_2: addr.address2 || null,
    address_3: null,
    city: addr.city || 'N/A',
    state_code: isUs ? (stateRaw ? stateRaw.toLowerCase().slice(0, 2) : 'na') : 'na',
    province: !isUs ? stateRaw || 'N/A' : '',
    zip_postal_code: normalizeZipForFinerWorks(addr.postalCode),
    country_code: country.length === 2 ? country : 'us',
    phone: addr.phone != null ? String(addr.phone) : '',
    email: order?.customerEmail || null,
    address_order_po: orderPoDisplay,
  };
}

function pickFinerWorksProductGuid(product) {
  if (!product || typeof product !== 'object') return null;
  const productGuid = product.product_guid ?? product.productGuid ?? null;
  if (
    productGuid &&
    String(productGuid).trim() &&
    String(productGuid).trim() !== FINERWORKS_EMPTY_PRODUCT_GUID
  ) {
    return String(productGuid).trim();
  }
  const imageGuid = product.image_guid ?? product.imageGuid ?? null;
  if (
    imageGuid &&
    String(imageGuid).trim() &&
    String(imageGuid).trim() !== FINERWORKS_EMPTY_PRODUCT_GUID
  ) {
    return String(imageGuid).trim();
  }
  return null;
}

async function resolveFinerWorksProductGuidBySku(sku, account_key) {
  const skuStr = sku != null ? String(sku).trim() : '';
  if (!skuStr || !account_key) return FINERWORKS_EMPTY_PRODUCT_GUID;
  try {
    const resp = await finerworksService.LIST_VIRTUAL_INVENTORY({
      sku_filter: [skuStr],
      account_key,
    });
    const guid = pickFinerWorksProductGuid(resp?.products?.[0]);
    return guid || FINERWORKS_EMPTY_PRODUCT_GUID;
  } catch (_) {
    return FINERWORKS_EMPTY_PRODUCT_GUID;
  }
}

function placeholderProductImage() {
  return {
    pixel_width: 600,
    pixel_height: 600,
    product_url_file: 'https://via.placeholder.com/150',
    product_url_thumbnail: 'https://via.placeholder.com/150',
  };
}

async function enrichOrderItemsWithProductGuids(orderItems, account_key) {
  if (!Array.isArray(orderItems) || !orderItems.length) return orderItems;
  return Promise.all(
    orderItems.map(async (item) => {
      const skuStr = item?.product_sku != null ? String(item.product_sku).trim() : '';
      if (!skuStr || !account_key) {
        return {
          ...item,
          product_guid: FINERWORKS_EMPTY_PRODUCT_GUID,
          product_image: placeholderProductImage(),
        };
      }
      try {
        const resp = await finerworksService.LIST_VIRTUAL_INVENTORY({
          sku_filter: [skuStr],
          account_key,
        });
        const product = resp?.products?.[0];
        const guid = pickFinerWorksProductGuid(product) || FINERWORKS_EMPTY_PRODUCT_GUID;
        const imageUrl = product?.image_url_1 || product?.image_url || null;
        return {
          ...item,
          product_guid: guid,
          product_image: imageUrl
            ? {
                pixel_width: 600,
                pixel_height: 600,
                product_url_file: imageUrl,
                product_url_thumbnail: imageUrl,
              }
            : placeholderProductImage(),
        };
      } catch (_) {
        const guid = await resolveFinerWorksProductGuidBySku(skuStr, account_key);
        return {
          ...item,
          product_guid: guid,
          product_image: placeholderProductImage(),
        };
      }
    })
  );
}

function buildSquarespaceOrderPo(order) {
  const orderNumber = order?.orderNumber != null ? String(order.orderNumber) : '';
  return (
    orderNumber.replace(/[^A-Za-z0-9]/g, '') ||
    (order?.id ? String(order.id).replace(/[^A-Za-z0-9]/g, '') : null)
  );
}

function transformSquarespaceOrderToFinerWorksPayload(order, { shippingOptions = null } = {}) {
  const orderPoDisplay = buildSquarespaceOrderPo(order);
  const recipient = buildRecipientFromSquarespaceOrder(order, orderPoDisplay);

  const lineItems = Array.isArray(order?.lineItems) ? order.lineItems : [];
  const orderItems = lineItems.filter(squarespaceLineItemSkuStartsWithAP).map((li) => ({
    product_order_po: orderPoDisplay || null,
    product_qty: li.quantity ?? 0,
    product_sku: li?.sku ?? null,
    product_image: placeholderProductImage(),
    product_title: li?.productName ?? null,
    template: null,
    product_guid: FINERWORKS_EMPTY_PRODUCT_GUID,
    custom_data_1: li?.productId ? String(li.productId) : null,
    custom_data_2: li?.variantId ? String(li.variantId) : null,
    custom_data_3: null,
  }));

  return {
    order_po: orderPoDisplay || null,
    order_key: null,
    recipient,
    order_items: orderItems,
    shipping_code: resolveSquarespaceShippingCode(order, shippingOptions),
    ship_by_date: null,
    customs_tax_info: null,
    gift_message: null,
    test_mode: false, // As per client's info we have set it to false.
    webhook_order_status_url: null,
    document_url: null,
    acct_number_ups: null,
    acct_number_fedex: null,
    custom_data_1: order?.id ? String(order.id) : null,
    custom_data_2: order?.orderNumber != null ? String(order.orderNumber) : null,
    custom_data_3: null,
    source: 'squarespace',
  };
}

function resolveSquarespaceApiBaseUrl() {
  const fromEnv =
    process.env.OFA_PUBLIC_API_BASE_URL || process.env.SQUARESPACE_ORDER_CREATE_WEBHOOK_URL || '';
  return String(fromEnv).trim().replace(/\/$/, '');
}

function buildSquarespaceFulfillmentWebhookUrl({ account_key, accessToken, orderNumber, orderId }) {
  const apiBase = resolveSquarespaceApiBaseUrl();
  if (!apiBase) return null;

  const params = new URLSearchParams({
    account_key: String(account_key),
    orderNumber: String(orderNumber || ''),
    orderId: String(orderId || ''),
  });
  if (accessToken) {
    params.set('access_token', String(accessToken));
  }
  return `${apiBase}/api/squarespace/fulfill-order?${params.toString()}`;
}

async function fetchSquarespaceOrderById(accessToken, orderId) {
  const id = String(orderId || '').trim();
  if (!id) {
    const err = new Error('Missing Squarespace order id');
    err.status = 400;
    throw err;
  }

  const endpoint = `${SQUARESPACE_ORDERS_URL}/${encodeURIComponent(id)}`;
  const resp = await axios.get(endpoint, {
    headers: squarespaceHeaders(accessToken),
    timeout: 120000,
  });

  const order = resp?.data;
  if (!order || typeof order !== 'object' || !order.id) {
    const err = new Error('Invalid Squarespace order response');
    err.status = 502;
    throw err;
  }

  return order;
}

module.exports = {
  FINERWORKS_EMPTY_PRODUCT_GUID,
  fetchSquarespaceOrderById,
  transformSquarespaceOrderToFinerWorksPayload,
  enrichOrderItemsWithProductGuids,
  buildSquarespaceFulfillmentWebhookUrl,
  buildSquarespaceOrderPo,
  squarespaceLineItemSkuStartsWithAP,
};
