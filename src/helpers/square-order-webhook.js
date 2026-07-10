const axios = require('axios');
const finerworksService = require('./finerworks-service');

const FINERWORKS_EMPTY_PRODUCT_GUID = '00000000-0000-0000-0000-000000000000';
/** Square Catalog BatchRetrieveCatalogObjects accepts up to 1000 ids; keep batches small. */
const MAX_CATALOG_BATCH_RETRIEVE = 100;

function normalizeZipForFinerWorks(zip) {
  if (zip == null || String(zip).trim() === '') return 0;
  const digits = String(zip).replace(/\D/g, '');
  const n = Number(digits);
  return Number.isFinite(n) ? n : 0;
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

function resolveDefaultShippingCode(shippingOptions) {
  const fromEnv =
    process.env.SQUARE_DEFAULT_SHIPPING_CODE || process.env.WIX_DEFAULT_SHIPPING_CODE;
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

function placeholderProductImage() {
  return {
    pixel_width: 600,
    pixel_height: 600,
    product_url_file: 'https://via.placeholder.com/150',
    product_url_thumbnail: 'https://via.placeholder.com/150',
  };
}

/** Square order ids are alphanumeric (no human order number on the API order). */
function buildSquareOrderPo(order) {
  return order?.id ? String(order.id).replace(/[^A-Za-z0-9]/g, '') : null;
}

/**
 * Square order line items don't carry the SKU — it lives on the catalog ITEM_VARIATION.
 * Resolves catalog_object_id → sku via POST /v2/catalog/batch-retrieve. Throws on a
 * non-2xx response so the webhook fails visibly (Square retries) instead of silently
 * dropping every line item.
 */
async function buildSquareCatalogSkuMap({ baseUrl, withAuthRetry, order }) {
  const lineItems = Array.isArray(order?.line_items) ? order.line_items : [];
  const ids = [
    ...new Set(lineItems.map((li) => li?.catalog_object_id).filter(Boolean)),
  ];
  const skuById = new Map();

  for (let i = 0; i < ids.length; i += MAX_CATALOG_BATCH_RETRIEVE) {
    const batch = ids.slice(i, i + MAX_CATALOG_BATCH_RETRIEVE);
    const r = await withAuthRetry((h) =>
      axios.post(
        `${baseUrl}/v2/catalog/batch-retrieve`,
        { object_ids: batch, include_related_objects: false },
        { headers: h, timeout: 60000, validateStatus: () => true }
      )
    );
    // Square returns 404 when none of the ids exist; treat as "no SKUs" rather than an error.
    if (r.status === 404) continue;
    if (r.status < 200 || r.status >= 300) {
      const err = new Error('Failed to batch-retrieve Square catalog objects for SKU lookup');
      err.response = r;
      throw err;
    }
    const objects = Array.isArray(r?.data?.objects) ? r.data.objects : [];
    for (const obj of objects) {
      const sku = obj?.item_variation_data?.sku;
      if (obj?.id && sku != null && String(sku).trim()) {
        skuById.set(obj.id, String(sku).trim());
      }
    }
  }

  return skuById;
}

function squareLineItemSku(lineItem, skuByCatalogObjectId) {
  const catalogObjectId = lineItem?.catalog_object_id || null;
  if (catalogObjectId && skuByCatalogObjectId?.get(catalogObjectId)) {
    return skuByCatalogObjectId.get(catalogObjectId);
  }
  return null;
}

function squareLineItemSkuStartsWithAP(lineItem, skuByCatalogObjectId) {
  const sku = squareLineItemSku(lineItem, skuByCatalogObjectId);
  if (sku == null) return false;
  return String(sku).trim().toUpperCase().startsWith('AP');
}

function buildRecipientFromSquareOrder(order, orderPoDisplay) {
  const fulfillments = Array.isArray(order?.fulfillments) ? order.fulfillments : [];
  const recipient =
    fulfillments.find((f) => f?.shipment_details?.recipient)?.shipment_details?.recipient ||
    fulfillments.find((f) => f?.pickup_details?.recipient)?.pickup_details?.recipient ||
    fulfillments.find((f) => f?.delivery_details?.recipient)?.delivery_details?.recipient ||
    {};
  const addr = recipient?.address || {};

  const displayName = recipient?.display_name != null ? String(recipient.display_name).trim() : '';
  const nameParts = displayName ? displayName.split(/\s+/) : [];
  const firstName = addr.first_name || nameParts[0] || 'Square';
  const lastName = addr.last_name || (nameParts.length > 1 ? nameParts.slice(1).join(' ') : '') || 'Customer';

  const country = String(addr.country || 'US').toLowerCase();
  const isUs = country === 'us';
  const stateRaw =
    addr.administrative_district_level_1 != null
      ? String(addr.administrative_district_level_1).trim()
      : '';

  return {
    first_name: firstName,
    last_name: lastName,
    company_name: addr.organization || null,
    address_1: addr.address_line_1 || 'Address pending',
    address_2: addr.address_line_2 || null,
    address_3: null,
    city: addr.locality || 'N/A',
    state_code: isUs ? (stateRaw ? stateRaw.toLowerCase().slice(0, 2) : 'na') : 'na',
    province: !isUs ? stateRaw || 'N/A' : '',
    zip_postal_code: normalizeZipForFinerWorks(addr.postal_code),
    country_code: country.length === 2 ? country : 'us',
    phone: recipient?.phone_number != null ? String(recipient.phone_number) : '',
    email: recipient?.email_address || null,
    address_order_po: orderPoDisplay,
  };
}

function transformSquareOrderToFinerWorksPayload(
  order,
  { skuByCatalogObjectId = null, shippingOptions = null } = {}
) {
  const orderPoDisplay = buildSquareOrderPo(order);
  const recipient = buildRecipientFromSquareOrder(order, orderPoDisplay);

  const lineItems = Array.isArray(order?.line_items) ? order.line_items : [];
  const orderItems = lineItems
    .filter((li) => squareLineItemSkuStartsWithAP(li, skuByCatalogObjectId))
    .map((li) => {
      const qty = Number(li?.quantity);
      return {
        product_order_po: orderPoDisplay || null,
        product_qty: Number.isFinite(qty) ? Math.round(qty) : 0,
        product_sku: squareLineItemSku(li, skuByCatalogObjectId),
        product_image: placeholderProductImage(),
        product_title:
          [li?.name, li?.variation_name].filter((s) => s && String(s).trim()).join(' - ') || null,
        template: null,
        product_guid: FINERWORKS_EMPTY_PRODUCT_GUID,
        custom_data_1: li?.catalog_object_id ? String(li.catalog_object_id) : null,
        custom_data_2: li?.uid ? String(li.uid) : null,
        custom_data_3: null,
      };
    });

  return {
    order_po: orderPoDisplay || null,
    order_key: null,
    recipient,
    order_items: orderItems,
    // Square orders don't expose a shipping-method title to match against FinerWorks options.
    shipping_code: resolveDefaultShippingCode(shippingOptions),
    ship_by_date: null,
    customs_tax_info: null,
    gift_message: null,
    test_mode: false, // As per client's info we have set it to false.
    webhook_order_status_url: null,
    document_url: null,
    acct_number_ups: null,
    acct_number_fedex: null,
    custom_data_1: order?.id ? String(order.id) : null,
    custom_data_2: order?.location_id ? String(order.location_id) : null,
    custom_data_3: null,
    source: 'square',
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
        return {
          ...item,
          product_guid: FINERWORKS_EMPTY_PRODUCT_GUID,
          product_image: placeholderProductImage(),
        };
      }
    })
  );
}

function resolveSquareApiBaseUrl() {
  const fromEnv =
    process.env.OFA_PUBLIC_API_BASE_URL || process.env.SQUARE_ORDER_CREATE_WEBHOOK_URL || '';
  return String(fromEnv).trim().replace(/\/$/, '');
}

/**
 * FinerWorks order-status callback → POST /api/square/fulfill-order (Task: mark order
 * shipped with tracking). No access_token in the URL — the fulfill controller resolves
 * Square credentials from the tenant connection.
 */
function buildSquareFulfillmentWebhookUrl({ account_key, orderNumber, orderId }) {
  const apiBase = resolveSquareApiBaseUrl();
  if (!apiBase) return null;

  const params = new URLSearchParams({
    account_key: String(account_key),
    orderNumber: String(orderNumber || ''),
    order_id: String(orderId || ''),
  });
  return `${apiBase}/api/square/fulfill-order?${params.toString()}`;
}

module.exports = {
  FINERWORKS_EMPTY_PRODUCT_GUID,
  buildSquareOrderPo,
  buildSquareCatalogSkuMap,
  transformSquareOrderToFinerWorksPayload,
  enrichOrderItemsWithProductGuids,
  buildSquareFulfillmentWebhookUrl,
  squareLineItemSkuStartsWithAP,
};
