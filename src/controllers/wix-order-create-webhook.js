const jwt = require('jsonwebtoken');
const axios = require('axios');
const debug = require('debug');
const finerworksService = require('../helpers/finerworks-service');
const { validateAccountKey } = require('../validators/accountKey.validator');
const { parseConnectionData, isOrderSyncEnabled } = require('../helpers/platform-connections');
const { fetchAccountKeyByWixInstanceId } = require('../helpers/wix-account-lookup');
const { resolveWixAuth, buildAuthHeaders } = require('./wix-products');
const { fetchWixOrderByGuid } = require('./wix-orders');

const log = debug('app:wix-order-create-webhook');

/** FinerWorks .NET API requires a valid GUID; null is rejected. */
const FINERWORKS_EMPTY_PRODUCT_GUID = '00000000-0000-0000-0000-000000000000';

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

async function resolveFinerWorksProductGuidBySku(sku, account_key) {
  const skuStr = sku != null ? String(sku).trim() : '';
  if (!skuStr || !account_key) return FINERWORKS_EMPTY_PRODUCT_GUID;
  try {
    const resp = await finerworksService.LIST_VIRTUAL_INVENTORY({
      sku_filter: [skuStr],
      account_key
    });
    const guid = pickFinerWorksProductGuid(resp?.products?.[0]);
    return guid || FINERWORKS_EMPTY_PRODUCT_GUID;
  } catch (err) {
    log('LIST_VIRTUAL_INVENTORY failed sku=%s: %s', skuStr, err?.message);
    return FINERWORKS_EMPTY_PRODUCT_GUID;
  }
}

async function enrichOrderItemsWithProductGuids(orderItems, account_key) {
  if (!Array.isArray(orderItems) || !orderItems.length) return orderItems;
  return Promise.all(
    orderItems.map(async (item) => {
      const guid = await resolveFinerWorksProductGuidBySku(item?.product_sku, account_key);
      return { ...item, product_guid: guid };
    })
  );
}

function parseMaybeJsonString(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  if (typeof v !== 'string') return null;
  try {
    return JSON.parse(v);
  } catch (_) {
    return null;
  }
}

function getRawWixWebhookBodyString(req) {
  const raw = req.body;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    try {
      return JSON.stringify(raw);
    } catch (_) {
      return String(raw);
    }
  }
  return '';
}

/** CloudWatch-friendly snapshot (decoded JWT / JSON, not raw Buffer). */
function formatWixWebhookForLog(req) {
  const raw = getRawWixWebhookBodyString(req).trim();
  const parsed = parseIncomingWixWebhookBody(req);
  const unwrapped = unwrapWixWebhookEvent(parsed);
  const { order, orderId } = unwrapped
    ? extractWixOrderFromUnwrapped(unwrapped)
    : parsed
      ? extractWixOrderFromPayload(parsed)
      : { order: null, orderId: null };

  const out = {
    query: req.query,
    bodyEncoding: Buffer.isBuffer(req.body) ? 'buffer' : typeof req.body,
    bodyLength: raw.length,
    instanceId: unwrapped?.instanceId ?? (parsed ? extractWixInstanceId(parsed) : null),
    orderId:
      order?.id ||
      orderId ||
      unwrapped?.orderIdFromEvent ||
      unwrapped?.storesOrderSnapshot?.orderId ||
      null,
    orderNumber: unwrapped?.storesOrderSnapshot?.number ?? null,
    slug: unwrapped?.slug ?? null,
    eventType: unwrapped?.eventType ?? null,
    entityFqdn: unwrapped?.entityFqdn ?? null
  };

  if (raw.startsWith('eyJ')) {
    out.bodyFormat = 'jwt';
    out.jwtPreview = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
    out.decodedPayload = parsed;
  } else if (raw.startsWith('{') || raw.startsWith('[')) {
    out.bodyFormat = 'json';
    out.decodedPayload = parsed;
  } else if (parsed) {
    out.bodyFormat = 'object';
    out.decodedPayload = parsed;
  } else {
    out.bodyFormat = 'unknown';
    out.rawPreview = raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
  }

  return out;
}

function parseIncomingWixWebhookBody(req) {
  let raw = getRawWixWebhookBodyString(req);
  if (typeof raw === 'string') {
    const token = raw.trim();
    if (!token) return null;
    if (token.startsWith('{') || token.startsWith('[')) {
      try {
        return JSON.parse(token);
      } catch (_) {
        return null;
      }
    }
    if (token.startsWith('eyJ')) {
      const decoded = jwt.decode(token, { complete: true });
      return decoded && typeof decoded === 'object' ? decoded.payload : null;
    }
    return null;
  }
  return null;
}

/** Read instanceId from JWT payload fields without calling unwrapWixWebhookEvent (avoids recursion). */
function readWixInstanceIdDirect(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const direct =
    payload.instanceId ||
    payload.instance_id ||
    payload.metadata?.instanceId ||
    payload.metadata?.instance_id ||
    null;
  if (direct) return String(direct).trim();

  const dataObj = parseMaybeJsonString(payload.data) || (typeof payload.data === 'object' ? payload.data : null);
  if (dataObj) {
    const fromData =
      dataObj.instanceId ||
      dataObj.instance_id ||
      dataObj.metadata?.instanceId ||
      dataObj.metadata?.instance_id ||
      null;
    if (fromData) return String(fromData).trim();

    const innerMeta = parseMaybeJsonString(dataObj.metadata) || dataObj.metadata;
    if (innerMeta?.instanceId) return String(innerMeta.instanceId).trim();
  }

  return null;
}

/**
 * Wix JWT webhooks wrap the real event in payload.data (JSON string) with nested data (JSON string).
 * @see https://dev.wix.com/docs/rest/articles/getting-started/webhook-structure
 */
function unwrapWixWebhookEvent(jwtPayload) {
  if (!jwtPayload || typeof jwtPayload !== 'object') return null;

  const envelope = parseMaybeJsonString(jwtPayload.data) || jwtPayload;
  if (!envelope || typeof envelope !== 'object') return null;

  const instanceId =
    envelope.instanceId ||
    envelope.instance_id ||
    envelope.metadata?.instanceId ||
    null;

  const eventType = envelope.eventType || envelope.event_type || null;

  let inner = parseMaybeJsonString(envelope.data);
  if (!inner && typeof envelope.data === 'object') inner = envelope.data;
  if (!inner && envelope.createdEvent) inner = envelope;
  if (!inner && envelope.entityFqdn) inner = envelope;

  if (!inner || typeof inner !== 'object') {
    return {
      instanceId: instanceId ? String(instanceId).trim() : readWixInstanceIdDirect(jwtPayload),
      eventType: eventType ? String(eventType).trim() : null,
      slug: null,
      entityFqdn: null,
      entityId: null,
      event: null,
      entity: null
    };
  }

  const entity = inner.createdEvent?.entity ?? inner.entity ?? null;
  /** Legacy store webhook: com.wix.ecommerce.orders.api.v2.OrderEvent (orderId, number, buyerInfo only). */
  const storesOrderSnapshot = inner.orderId ? inner : null;

  return {
    instanceId: instanceId ? String(instanceId).trim() : readWixInstanceIdDirect(jwtPayload),
    eventType: eventType ? String(eventType).trim() : null,
    slug: inner.slug != null ? String(inner.slug) : null,
    entityFqdn: inner.entityFqdn != null ? String(inner.entityFqdn) : null,
    entityId:
      inner.entityId != null
        ? String(inner.entityId).trim()
        : storesOrderSnapshot?.orderId
          ? String(storesOrderSnapshot.orderId).trim()
          : null,
    event: inner,
    entity: entity && typeof entity === 'object' ? entity : null,
    storesOrderSnapshot,
    orderIdFromEvent: storesOrderSnapshot?.orderId ? String(storesOrderSnapshot.orderId).trim() : null
  };
}

function extractWixInstanceId(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const unwrapped = unwrapWixWebhookEvent(payload);
  if (unwrapped?.instanceId) return unwrapped.instanceId;

  return readWixInstanceIdDirect(payload);
}

function isWixEcomOrderEvent(unwrapped) {
  if (!unwrapped) return false;
  const fqdn = String(unwrapped.entityFqdn || '').toLowerCase();
  const eventType = String(unwrapped.eventType || '').toLowerCase();
  if (fqdn.includes('wix.ecom') && fqdn.includes('order')) return true;
  if (eventType.includes('ecom') && eventType.includes('order')) return true;
  /** Wix Stores order-created webhook from the site dashboard. */
  if (eventType.includes('ecommerce.orders') || eventType.includes('orderevent')) return true;
  if (unwrapped.storesOrderSnapshot?.orderId || unwrapped.event?.orderId) return true;
  return Boolean(unwrapped.entity?.lineItems?.length);
}

function isWixPricingPlanOrderEvent(unwrapped) {
  if (!unwrapped) return false;
  const fqdn = String(unwrapped.entityFqdn || '').toLowerCase();
  const eventType = String(unwrapped.eventType || '').toLowerCase();
  if (fqdn.includes('pricing_plans') && fqdn.includes('order')) return true;
  if (eventType.includes('pricing_plans') && eventType.includes('order')) return true;
  return Boolean(unwrapped.entity?.planId || unwrapped.entity?.planName);
}

function extractWixOrderFromUnwrapped(unwrapped) {
  if (!unwrapped) return { order: null, orderId: null, kind: null, storesSnapshot: null };

  const entity = unwrapped.entity;
  const storesSnapshot = unwrapped.storesOrderSnapshot || (unwrapped.event?.orderId ? unwrapped.event : null);

  if (isWixPricingPlanOrderEvent(unwrapped) && entity && typeof entity === 'object') {
    return {
      kind: 'pricing_plans',
      order: entity,
      orderId: entity.id ? String(entity.id).trim() : unwrapped.entityId,
      storesSnapshot: null
    };
  }

  if (isWixEcomOrderEvent(unwrapped)) {
    if (entity && typeof entity === 'object' && Array.isArray(entity.lineItems) && entity.lineItems.length) {
      return {
        kind: 'ecom',
        order: entity,
        orderId: entity.id ? String(entity.id).trim() : unwrapped.entityId,
        storesSnapshot
      };
    }

    const orderId =
      storesSnapshot?.orderId ||
      unwrapped.orderIdFromEvent ||
      unwrapped.entityId ||
      entity?.id ||
      null;

    if (orderId) {
      return {
        kind: 'ecom',
        order: entity?.lineItems?.length ? entity : null,
        orderId: String(orderId).trim(),
        storesSnapshot
      };
    }
  }

  return {
    kind: null,
    order: null,
    orderId: unwrapped.entityId || unwrapped.orderIdFromEvent || null,
    storesSnapshot: null
  };
}

function extractWixOrderFromPayload(payload) {
  const unwrapped = unwrapWixWebhookEvent(payload);
  if (
    unwrapped &&
    (unwrapped.entity ||
      unwrapped.entityId ||
      unwrapped.storesOrderSnapshot ||
      unwrapped.event?.orderId ||
      isWixEcomOrderEvent(unwrapped) ||
      isWixPricingPlanOrderEvent(unwrapped))
  ) {
    return extractWixOrderFromUnwrapped(unwrapped);
  }

  if (!payload || typeof payload !== 'object') return { order: null, orderId: null, kind: null };

  const candidates = [
    payload?.createdEvent?.entity,
    payload?.data?.createdEvent?.entity,
    parseMaybeJsonString(payload?.data)?.createdEvent?.entity,
    payload?.data?.order,
    payload?.order,
    payload?.entity
  ];

  for (const c of candidates) {
    if (c && typeof c === 'object' && (c.id || c.lineItems)) {
      return {
        kind: 'ecom',
        order: c,
        orderId: c.id ? String(c.id).trim() : null,
        storesSnapshot: null
      };
    }
  }

  const orderId =
    payload?.entityId ||
    payload?.data?.orderId ||
    payload?.data?.id ||
    payload?.orderId ||
    payload?.id ||
    null;

  return {
    order: null,
    orderId: orderId ? String(orderId).trim() : null,
    kind: null,
    storesSnapshot: null
  };
}

function mergeStoresSnapshotIntoOrder(order, snapshot) {
  if (!order || !snapshot || typeof snapshot !== 'object') return order;
  const buyer = snapshot.buyerInfo;
  if (!buyer || typeof buyer !== 'object') return order;

  const merged = { ...order };
  merged.buyerInfo = {
    ...(merged.buyerInfo || {}),
    email: merged.buyerInfo?.email || buyer.email || null,
    firstName: merged.buyerInfo?.firstName || buyer.firstName || null,
    lastName: merged.buyerInfo?.lastName || buyer.lastName || null,
    phone: merged.buyerInfo?.phone || buyer.phone || null,
    contactId: merged.buyerInfo?.contactId || buyer.id || null
  };

  if (merged.number == null && snapshot.number != null) {
    merged.number = snapshot.number;
  }

  return merged;
}

async function fetchWixOrderByNumber(wixAuth, orderNumber) {
  const n = Number(String(orderNumber).replace(/\D/g, ''));
  if (!Number.isFinite(n)) {
    return { ok: false, status: 400, message: 'Invalid order number' };
  }

  const headers = buildAuthHeaders(wixAuth);
  const r = await axios.post(
    'https://www.wixapis.com/ecom/v1/orders/search',
    {
      search: {
        filter: { number: { $in: [n] } },
        cursorPaging: { limit: 1 }
      }
    },
    { headers, timeout: 120000, validateStatus: () => true }
  );

  if (r.status < 200 || r.status >= 300) {
    return { ok: false, status: r.status, wixPayload: r.data };
  }

  const orders = Array.isArray(r?.data?.orders) ? r.data.orders : [];
  const order = orders[0] || null;
  if (!order) return { ok: false, status: 404, message: 'Order not found by number' };
  return { ok: true, order, status: r.status };
}

/** Load full eCommerce order for legacy OrderEvent webhooks (orderId + optional number). */
async function fetchWixOrderForWebhook(wixAuth, orderId, storesSnapshot) {
  const guid = String(orderId || '').trim();
  if (guid) {
    const byId = await fetchWixOrderByGuid(wixAuth, guid);
    if (byId.ok && byId.order) {
      return { ...byId, order: mergeStoresSnapshotIntoOrder(byId.order, storesSnapshot) };
    }
    log('fetchWixOrderByGuid failed status=%s orderId=%s', byId.status, guid);
  }

  const orderNumber = storesSnapshot?.number;
  if (orderNumber != null && String(orderNumber).trim() !== '') {
    const byNum = await fetchWixOrderByNumber(wixAuth, orderNumber);
    if (byNum.ok && byNum.order) {
      return { ...byNum, order: mergeStoresSnapshotIntoOrder(byNum.order, storesSnapshot) };
    }
    return byNum;
  }

  return { ok: false, status: 404, message: 'Could not load order by id or number' };
}

function wixLineItemSkuStartsWithAP(lineItem) {
  const sku = lineItem?.physicalProperties?.sku ?? lineItem?.sku ?? null;
  if (sku == null) return false;
  return String(sku).trim().toUpperCase().startsWith('AP');
}

function pickTranslatedString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'object') {
    const t = v.translated || v.original || v.name;
    return t != null ? String(t).trim() || null : null;
  }
  return null;
}

function looksLikeUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(value || '').trim());
}

function matchShippingOptionId(title, options, carrierCode = null) {
  if (!Array.isArray(options) || !options.length) return null;
  const code = carrierCode != null ? String(carrierCode).trim() : '';
  // Wix shippingInfo.code is a Wix GUID, not a FinerWorks shipping_code — skip UUID carrier matching.
  if (code && !looksLikeUuid(code)) {
    const byCode = options.find((o) => String(o?.shipping_code || '').trim() === code);
    if (byCode) return byCode.id ?? byCode.shipping_code ?? null;
    const byId = options.find((o) => String(o?.id || '').trim() === code);
    if (byId) return byId.id ?? byId.shipping_code ?? null;
  }
  const t = title != null ? String(title).trim() : '';
  if (!t) return null;
  const exact = options.find((o) => o?.shipping_method === t);
  if (exact) return exact.id ?? exact.shipping_code ?? null;
  const contains = options.find((o) =>
    String(o?.shipping_method || '')
      .toLowerCase()
      .includes(t.toLowerCase())
  );
  return contains ? contains.id ?? contains.shipping_code ?? null : null;
}

function resolveDefaultShippingCode(shippingOptions) {
  const fromEnv = process.env.WIX_DEFAULT_SHIPPING_CODE;
  if (fromEnv != null && String(fromEnv).trim()) return String(fromEnv).trim();
  const opts = shippingOptions?.shipping_options ?? shippingOptions;
  const first = Array.isArray(opts) ? opts[0] : null;
  if (first?.id != null) return String(first.id);
  if (first?.shipping_code != null) return String(first.shipping_code);
  return '01';
}

function resolveFinerWorksShippingCode(order, shippingOptions) {
  const opts = shippingOptions?.shipping_options ?? shippingOptions;
  const shippingTitle = order?.shippingInfo?.title ?? order?.shippingInfo?.logistics?.title ?? null;
  const shippingCodeRaw = order?.shippingInfo?.code ?? null;
  const matched = matchShippingOptionId(shippingTitle, opts, shippingCodeRaw);
  if (matched != null) return String(matched);
  return resolveDefaultShippingCode(shippingOptions);
}

function normalizeZipForFinerWorks(zip) {
  if (zip == null || String(zip).trim() === '') return 0;
  const digits = String(zip).replace(/\D/g, '');
  const n = Number(digits);
  return Number.isFinite(n) ? n : 0;
}

async function fetchWixContactById(wixAuth, contactId) {
  const id = String(contactId || '').trim();
  if (!id) return null;
  const headers = buildAuthHeaders(wixAuth);
  const url = `https://www.wixapis.com/contacts/v4/contacts/${encodeURIComponent(id)}`;
  const r = await axios.get(url, {
    headers,
    params: { fieldsets: ['FULL'] },
    timeout: 60000,
    validateStatus: () => true
  });
  if (r.status < 200 || r.status >= 300) {
    log('fetchWixContactById failed status=%s contactId=%s', r.status, id);
    return null;
  }
  return r?.data?.contact ?? null;
}

function buildRecipientFromWixContact(contact, orderPoDisplay, fallbackEmail = null) {
  const info = contact?.info || {};
  const name = info.name || {};
  const addresses = info.addresses;
  const addrList = Array.isArray(addresses) ? addresses : addresses?.items || [];
  const addr = addrList[0]?.address || addrList[0] || {};
  const emails = info.emails;
  const emailList = Array.isArray(emails) ? emails : emails?.items || [];
  const email = emailList[0]?.email || emailList[0]?.address || fallbackEmail || null;
  const phones = info.phones;
  const phoneList = Array.isArray(phones) ? phones : phones?.items || [];
  const phone = phoneList[0]?.phone || phoneList[0]?.formattedPhone || null;

  const subdivision = addr.subdivision || addr.subdivisionFullname || null;
  const stateCode =
    subdivision && String(subdivision).includes('-')
      ? String(subdivision).split('-').pop()
      : subdivision;

  const country = (addr.country || 'US').toLowerCase();
  const isUs = country === 'us';

  return {
    first_name: name.first || name.firstName || 'Wix',
    last_name: name.last || name.lastName || 'Customer',
    company_name: addr.company || null,
    address_1: addr.addressLine || addr.addressLine1 || addr.streetAddress?.name || 'Address pending',
    address_2: addr.addressLine2 || null,
    address_3: null,
    city: addr.city || 'N/A',
    state_code: isUs ? (stateCode ? String(stateCode).toLowerCase().slice(0, 2) : 'na') : 'na',
    province: !isUs ? subdivision || 'N/A' : '',
    zip_postal_code: normalizeZipForFinerWorks(addr.postalCode || addr.zipCode),
    country_code: country.length === 2 ? country : 'us',
    phone: phone || null,
    email,
    address_order_po: orderPoDisplay
  };
}

function buildPricingPlanProductSku(entity) {
  const fromEnv = process.env.WIX_PRICING_PLAN_PRODUCT_SKU;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  const planId = entity?.planId ? String(entity.planId).replace(/[^A-Za-z0-9]/g, '').slice(0, 20) : 'PLAN';
  return `AP-WIX-${planId}`;
}

async function transformWixPricingPlanOrderToFinerWorksPayload(entity, { wixAuth, shippingOptions = null }) {
  const orderPoDisplay =
    (entity?.id ? String(entity.id).replace(/[^A-Za-z0-9]/g, '') : null) ||
    (entity?.subscriptionId ? String(entity.subscriptionId).replace(/[^A-Za-z0-9]/g, '') : null);

  const contactId = entity?.buyer?.contactId || entity?.buyer?.memberId || null;
  let recipient = null;
  if (contactId && wixAuth?.accessToken) {
    const contact = await fetchWixContactById(wixAuth, contactId);
    if (contact) recipient = buildRecipientFromWixContact(contact, orderPoDisplay);
  }

  if (!recipient) {
    recipient = {
      first_name: 'Wix',
      last_name: 'Customer',
      company_name: null,
      address_1: process.env.WIX_WEBHOOK_DEFAULT_ADDRESS_1 || 'Address pending',
      address_2: null,
      address_3: null,
      city: process.env.WIX_WEBHOOK_DEFAULT_CITY || 'N/A',
      state_code: process.env.WIX_WEBHOOK_DEFAULT_STATE_CODE || 'na',
      province: '',
      zip_postal_code: normalizeZipForFinerWorks(process.env.WIX_WEBHOOK_DEFAULT_ZIP || '0'),
      country_code: (process.env.WIX_WEBHOOK_DEFAULT_COUNTRY_CODE || 'us').toLowerCase(),
      phone: null,
      email: null,
      address_order_po: orderPoDisplay
    };
  }

  const qty = 1;
  const sku = buildPricingPlanProductSku(entity);
  const planTitle = entity?.planName ? String(entity.planName).trim() : 'Wix Plan';

  return {
    order_po: orderPoDisplay || null,
    order_key: entity?.subscriptionId ? String(entity.subscriptionId) : null,
    recipient,
    order_items: [
      {
        product_order_po: orderPoDisplay || null,
        product_qty: qty,
        product_sku: sku,
        product_image: {
          pixel_width: 600,
          pixel_height: 600,
          product_url_file: 'https://via.placeholder.com/150',
          product_url_thumbnail: 'https://via.placeholder.com/150'
        },
        product_title: planTitle,
        template: null,
        product_guid: entity?.planId ? String(entity.planId) : FINERWORKS_EMPTY_PRODUCT_GUID,
        custom_data_1: entity?.type ? String(entity.type) : null,
        custom_data_2: entity?.status ? String(entity.status) : null,
        custom_data_3: null
      }
    ],
    shipping_code: resolveDefaultShippingCode(shippingOptions),
    ship_by_date: null,
    customs_tax_info: null,
    gift_message: entity?.planDescription ? String(entity.planDescription) : null,
    test_mode: process.env.WIX_WEBHOOK_TEST_MODE !== 'false',
    webhook_order_status_url: null,
    document_url: null,
    acct_number_ups: null,
    acct_number_fedex: null,
    custom_data_1: 'wix_pricing_plans',
    custom_data_2: entity?.planId ? String(entity.planId) : null,
    custom_data_3: null,
    source: 'wix_pricing_plans'
  };
}

function buildRecipientFromWixOrder(order, orderPoDisplay) {
  const shipBlock =
    order?.recipientInfo ||
    order?.shippingInfo?.logistics?.shippingDestination ||
    order?.billingInfo ||
    {};
  const addr = shipBlock?.address || {};
  const contact = shipBlock?.contactDetails || order?.buyerInfo || {};

  const subdivision = addr.subdivision || addr.subdivisionFullname || null;
  const stateCode =
    subdivision && String(subdivision).includes('-')
      ? String(subdivision).split('-').pop()
      : subdivision;

  const country = (addr.country || 'US').toLowerCase();
  const isUs = country === 'us';

  return {
    first_name: contact.firstName || contact.first || 'Wix',
    last_name: contact.lastName || contact.last || 'Customer',
    company_name: contact.company || null,
    address_1: addr.addressLine ?? addr.addressLine1 ?? 'Address pending',
    address_2: addr.addressLine2 ?? null,
    address_3: null,
    city: addr.city || 'N/A',
    state_code: isUs ? (stateCode ? String(stateCode).toLowerCase().slice(0, 2) : 'na') : 'na',
    province: !isUs ? subdivision || 'N/A' : '',
    zip_postal_code: normalizeZipForFinerWorks(addr.postalCode),
    country_code: country.length === 2 ? country : 'us',
    phone: contact.phone ?? null,
    email: order?.buyerInfo?.email ?? contact.email ?? null,
    address_order_po: orderPoDisplay
  };
}

function transformWixOrderToFinerWorksPayload(order, { shippingOptions = null }) {
  const orderNumber = order?.number != null ? String(order.number) : '';
  const orderPoDisplay = orderNumber.replace(/\D/g, '') || (order?.id ? String(order.id).replace(/[^A-Za-z0-9]/g, '') : null);

  const recipient = buildRecipientFromWixOrder(order, orderPoDisplay);

  const lineItems = Array.isArray(order?.lineItems) ? order.lineItems : [];
  const orderItems = lineItems
    .filter(wixLineItemSkuStartsWithAP)
    .map((li) => {
      const imageUrl = li?.image?.url ?? null;
      return {
        product_order_po: orderPoDisplay || null,
        product_qty: li.quantity ?? 0,
        product_sku: li?.physicalProperties?.sku ?? li?.sku ?? null,
        product_image: imageUrl
          ? {
              pixel_width: li?.image?.width ?? 600,
              pixel_height: li?.image?.height ?? 600,
              product_url_file: imageUrl,
              product_url_thumbnail: imageUrl
            }
          : {
              pixel_width: 600,
              pixel_height: 600,
              product_url_file: 'https://via.placeholder.com/150',
              product_url_thumbnail: 'https://via.placeholder.com/150'
            },
        product_title: pickTranslatedString(li?.productName) ?? pickTranslatedString(li?.name) ?? null,
        template: null,
        product_guid: FINERWORKS_EMPTY_PRODUCT_GUID,
        custom_data_1: null,
        custom_data_2: null,
        custom_data_3: null
      };
    });

  const shippingCodeStr = resolveFinerWorksShippingCode(order, shippingOptions);

  return {
    order_po: orderPoDisplay || null,
    order_key: null,
    recipient,
    order_items: orderItems,
    shipping_code: shippingCodeStr,
    ship_by_date: null,
    customs_tax_info: null,
    gift_message: order?.buyerNote?.message ?? order?.buyerNote ?? null,
    test_mode: true,
    webhook_order_status_url: null,
    document_url: null,
    acct_number_ups: null,
    acct_number_fedex: null,
    custom_data_1: null,
    custom_data_2: null,
    custom_data_3: null,
    source: 'wix'
  };
}

async function resolveAccountKeyForWebhook(req, payload) {
  let account_key =
    req.query?.account_key ||
    req.query?.accountKey ||
    req.headers['x-account-key'] ||
    req.body?.account_key ||
    req.body?.accountKey ||
    null;

  if (account_key && String(account_key).trim()) {
    return String(account_key).trim();
  }

  const instanceId = extractWixInstanceId(payload);
  if (instanceId) {
    const fromService = await fetchAccountKeyByWixInstanceId(instanceId);
    if (fromService) return fromService;

    const fromConnections = await findAccountKeyByInstanceInConnections(instanceId);
    if (fromConnections) return fromConnections;
  }

  return null;
}

/**
 * Fallback when account-info service is unavailable: scan is not possible via GET_INFO alone.
 * Optional internal lookup URL (same host pattern as Shopify account-info).
 */
async function findAccountKeyByInstanceInConnections(instanceId) {
  const lookupUrl = process.env.WIX_INSTANCE_ACCOUNT_LOOKUP_URL;
  if (!lookupUrl) return null;
  try {
    const resp = await axios.post(
      lookupUrl,
      { instance_id: String(instanceId).trim() },
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000, validateStatus: () => true }
    );
    if (resp.status < 200 || resp.status >= 300) return null;
    const key = resp?.data?.account_key || resp?.data?.accountKey;
    return key ? String(key).trim() : null;
  } catch (_) {
    return null;
  }
}

function getWixConnection(connections) {
  if (!Array.isArray(connections)) return null;
  return connections.find((c) => c && c.name === 'Wix') || null;
}

/**
 * Wix eCommerce order created webhook.
 * Configure in Wix Dev Center → Webhooks → Order Created.
 *
 * Resolves tenant via query/header `account_key` and/or `instanceId` in the payload (account-info service).
 * When `order_sync` is true in Wix connection `data`, fetches full order (if needed) and submits to FinerWorks.
 */
exports.handleWixOrderCreateWebhook = async (req, res) => {
  try {
    log('Wix order create webhook received %s', JSON.stringify(formatWixWebhookForLog(req)));
    const payload = parseIncomingWixWebhookBody(req);
    if (!payload) {
      return res.status(400).json({
        success: false,
        message: 'Invalid webhook body (expected JSON or JWT string)'
      });
    }

    const account_key = await resolveAccountKeyForWebhook(req, payload);
    if (!account_key) {
      return res.status(200).json({
        success: true,
        ignored: true,
        message:
          'Could not resolve account_key. Pass ?account_key= on the webhook URL or map instanceId via account-info.'
      });
    }

    const { valid, error } = validateAccountKey(account_key);
    if (!valid) {
      return res.status(400).json({ success: false, message: error.message });
    }

    const getInformation = await finerworksService.GET_INFO({ account_key });
    const wixConn = getWixConnection(getInformation?.user_account?.connections);

    if (!wixConn) {
      return res.status(200).json({
        success: true,
        ignored: true,
        message: 'No Wix connection for this account'
      });
    }

    if (!isOrderSyncEnabled(wixConn, 'Wix')) {
      return res.status(200).json({
        success: true,
        ignored: true,
        message: 'Order sync is disabled for this Wix connection'
      });
    }

    const unwrapped = unwrapWixWebhookEvent(payload);
    let { order, orderId, kind, storesSnapshot } = extractWixOrderFromPayload(payload);

    const wixAuth = await resolveWixAuth({
      account_key,
      access_token: null,
      ignoreRequestToken: true
    });

    if (!wixAuth?.accessToken) {
      return res.status(401).json({
        success: false,
        message: 'Wix credentials not configured for this account'
      });
    }

    if (!kind && unwrapped) {
      if (isWixEcomOrderEvent(unwrapped)) kind = 'ecom';
      else if (isWixPricingPlanOrderEvent(unwrapped)) kind = 'pricing_plans';
    }

    if (!kind) {
      return res.status(200).json({
        success: true,
        ignored: true,
        message: 'Unsupported Wix webhook event (expected store/eCommerce or Pricing Plans order created)',
        eventType: unwrapped?.eventType ?? null,
        entityFqdn: unwrapped?.entityFqdn ?? null,
        orderIdFromEvent: unwrapped?.orderIdFromEvent ?? null
      });
    }

    if (kind === 'ecom') {
      if ((!order || !Array.isArray(order.lineItems) || !order.lineItems.length) && orderId) {
        log(
          'Fetching Wix eCommerce order orderId=%s number=%s eventType=%s',
          orderId,
          storesSnapshot?.number ?? null,
          unwrapped?.eventType ?? null
        );
        const fetchResult = await fetchWixOrderForWebhook(wixAuth, orderId, storesSnapshot);
        if (!fetchResult.ok || !fetchResult.order) {
          const status = fetchResult.status === 404 ? 404 : fetchResult.status || 502;
          return res.status(status).json({
            success: false,
            message: 'Failed to load Wix eCommerce order for webhook',
            orderId,
            orderNumber: storesSnapshot?.number ?? null,
            eventType: unwrapped?.eventType ?? null,
            ...(fetchResult.wixPayload ? { wixError: fetchResult.wixPayload } : {}),
            ...(fetchResult.message ? { detail: fetchResult.message } : {})
          });
        }
        order = fetchResult.order;
      } else if (order && storesSnapshot) {
        order = mergeStoresSnapshotIntoOrder(order, storesSnapshot);
      }
    }

    if (!order) {
      return res.status(400).json({
        success: false,
        message: 'Missing order entity in webhook payload',
        eventType: unwrapped?.eventType ?? null,
        entityFqdn: unwrapped?.entityFqdn ?? null
      });
    }

    let shippingOptions = null;
    try {
      shippingOptions = await finerworksService.SHIPPING_OPTIONS_LIST();
    } catch (shipErr) {
      log('SHIPPING_OPTIONS_LIST failed: %s', shipErr?.message);
    }

    const shippingOptsList = shippingOptions?.shipping_options ?? null;

    let transformedOrder = null;
    if (kind === 'pricing_plans') {
      transformedOrder = await transformWixPricingPlanOrderToFinerWorksPayload(order, {
        wixAuth,
        shippingOptions: shippingOptsList
      });
      log('Wix pricing plan order mapped for FinerWorks order_po=%s', transformedOrder.order_po);
      console.log('Wix pricing plan order mapped for FinerWorks: ', transformedOrder);
    } else {
      transformedOrder = transformWixOrderToFinerWorksPayload(order, {
        shippingOptions: shippingOptsList
      });
      console.log('Wix eCommerce order mapped for FinerWorks: ', transformedOrder);
      if (!transformedOrder.order_items?.length) {
        return res.status(200).json({
          success: true,
          ignored: true,
          message: 'No FinerWorks line items (eCommerce SKU must start with AP)',
          orderId: order.id || orderId,
          eventType: unwrapped?.eventType ?? null
        });
      }
    }

    transformedOrder.order_items = await enrichOrderItemsWithProductGuids(
      transformedOrder.order_items,
      account_key
    );

    const apiBase = String(process.env.OFA_PUBLIC_API_BASE_URL || '').trim().replace(/\/$/, '');
    if (apiBase) {
      transformedOrder.webhook_order_status_url = `${apiBase}/api/wix/fulfill-order?account_key=${encodeURIComponent(
        account_key
      )}&order_id=${encodeURIComponent(order.id || orderId || '')}&order_number=${encodeURIComponent(
        transformedOrder.order_po || ''
      )}`;
    }

    const finalPayload = {
      orders: [transformedOrder],
      validate_only: false,
      payment_token: process.env.WIX_WEBHOOK_PAYMENT_TOKEN || 'xxxx',
      account_key
    };

    let submitData = null;
    try {
      log('Submitting Wix order to FinerWorks: order_po=%s', transformedOrder.order_po);
      console.log('Submitting Wix order to FinerWorks: ', finalPayload);
      submitData = await finerworksService.SUBMIT_ORDERS(finalPayload);
    } catch (submitErr) {
      const fwError = submitErr?.response?.data;
      log('SUBMIT_ORDERS failed: %s', submitErr?.message);
      console.log('SUBMIT_ORDERS failed: ', fwError || submitErr?.message || submitErr);
      return res.status(submitErr?.response?.status === 400 ? 400 : 502).json({
        success: false,
        message: 'Failed to submit order to FinerWorks',
        orderId: order.id || orderId,
        error: submitErr?.message || 'Unknown error',
        ...(fwError && typeof fwError === 'object' ? { finerworksError: fwError } : {})
      });
    }

    return res.status(200).json({
      success: true,
      submitted: true,
      orderKind: kind,
      eventType: unwrapped?.eventType ?? null,
      entityFqdn: unwrapped?.entityFqdn ?? null,
      orderId: order.id || orderId,
      order_po: transformedOrder.order_po,
      account_key,
      submitData
    });
  } catch (err) {
    console.log("handleWixOrderCreateWebhook error: ", err);
    log('handleWixOrderCreateWebhook error: %s', err?.message);
    return res.status(500).json({
      success: false,
      message: 'Wix order create webhook handler failed',
      error: err?.message || 'Unknown error'
    });
  }
};
