const axios = require('axios');
const finerworksService = require('../helpers/finerworks-service');
const { sendApiError } = require('../helpers/api-error');
const { getBigcartelConnection, BIGCARTEL_API_BASE } = require('./bigcartel-auth');
const debug = require('debug');
const log = debug('app:bigcartelOrders');

/**
 * Big Cartel Orders + Shipments API — paths/field names confirmed directly from Big Cartel's
 * own official docs (developers.bigcartel.com/api/v1), fetched twice independently to
 * corroborate. Big Cartel uses the JSON:API spec (`application/vnd.api+json`): every resource
 * is wrapped as {data: {id, type, attributes, relationships}}, so flattenJsonApiResource below
 * merges id+attributes into a plain object for callers, matching the flatter shape every other
 * platform's handlers in this codebase already return.
 *
 * UNCONFIRMED, flagged for live testing: Big Cartel's docs don't show a verbatim example of the
 * POST /shipments request body — the shape used below (attributes: {tracking_number, carrier},
 * relationships: {order: {data: {type: 'orders', id}}}) is inferred from the same JSON:API
 * pattern Big Cartel's own Products docs show, not a quoted example.
 *
 * Big Cartel has NO sku field anywhere — not on products, not on product_options (variants),
 * not on order_line_items. Confirmed from three independent sources: Big Cartel's own API docs
 * (no sku attribute documented on any resource), Big Cartel's own merchant help docs (the
 * product-variant creation form has only "Variant Group Name"/"Variant Value Name" fields, no
 * SKU), and a third-party fulfillment integration guide stating outright that Big Cartel
 * doesn't track SKUs and describing the workaround below as how they solved the same problem.
 * This isn't a documentation gap to flag and move on from — it's a real platform limitation,
 * so resolveLineItemSkus below implements the actual workaround: merchants put `SKU:<value>`
 * at the end of the PRODUCT DESCRIPTION (not a dedicated field, since none exists), and for a
 * product with variants, the final per-variant SKU is that base value with the variant's own
 * option name appended directly (e.g. description ending "SKU:SHIRT-" + option "SMALL" ->
 * "SHIRT-SMALL" — this concatenation convention, including that the merchant's base value
 * already contains any desired separator, comes from the third-party guide, not Big Cartel
 * itself, so it's worth confirming against a real connected shop, but it's the only documented
 * approach anywhere for this platform and is what this code implements end to end).
 */

/** Extracts the merchant-typed SKU from a Big Cartel product description: the `SKU:` marker
 * (case-insensitive) must be the last thing in the description, so an item below any amount of
 * other text/HTML markup is skipped — only the suffix after the marker is taken as the SKU. */
function extractSkuFromDescription(description) {
  if (!description || typeof description !== 'string') return null;
  const plain = description.replace(/<[^>]*>/g, ' ');
  const match = plain.match(/SKU:\s*([^\s<][\s\S]*)$/i);
  if (!match) return null;
  const sku = match[1].replace(/\s+/g, ' ').trim();
  return sku || null;
}

/** Strips a variant's option name down to characters safe to append directly onto a base SKU
 * (e.g. "X-Large" -> "XLARGE") — Big Cartel's own merchant-help example uses bare option values
 * like "SMALL"/"X-LARGE" with no separator of their own, so this normalizes rather than guesses
 * at a separator. */
function normalizeOptionNameForSku(optionName) {
  if (!optionName) return '';
  return String(optionName).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Resolves a usable SKU for each Big Cartel order line item by fetching each distinct
 * product's description and applying the SKU:-marker + variant-name convention above.
 * Dedupes product fetches (one request per distinct product_id in the order, not per line
 * item) and returns the same line items with `.sku` attached (null when no SKU: marker was
 * found in that product's description — the caller decides how to treat that, same as any
 * other platform's "couldn't resolve a SKU" case).
 */
async function resolveLineItemSkus({ accessToken, accountId, lineItems }) {
  if (!Array.isArray(lineItems) || !lineItems.length) return lineItems || [];

  const productIds = [...new Set(lineItems.map((li) => li?.product_id).filter(Boolean).map(String))];
  const baseSkuByProductId = new Map();

  await Promise.all(
    productIds.map(async (productId) => {
      try {
        const r = await bigcartelApiCall({
          method: 'GET',
          path: `/v1/accounts/${accountId}/products/${encodeURIComponent(productId)}`,
          accessToken,
        });
        if (r.status >= 200 && r.status < 300) {
          const product = flattenJsonApiResource(r.data?.data);
          baseSkuByProductId.set(productId, extractSkuFromDescription(product?.description));
        } else {
          baseSkuByProductId.set(productId, null);
        }
      } catch (_e) {
        baseSkuByProductId.set(productId, null);
      }
    })
  );

  return lineItems.map((li) => {
    const baseSku = li?.product_id ? baseSkuByProductId.get(String(li.product_id)) : null;
    if (!baseSku) return { ...li, sku: null };
    const variantSuffix = li?.product_option_id ? normalizeOptionNameForSku(li?.product_option_name) : '';
    return { ...li, sku: `${baseSku}${variantSuffix}` };
  });
}

function flattenJsonApiResource(resource) {
  if (!resource || typeof resource !== 'object') return null;
  return { id: resource.id, type: resource.type, ...(resource.attributes || {}) };
}

function flattenJsonApiCollection(body) {
  const data = body?.data;
  if (!Array.isArray(data)) return [];
  return data.map(flattenJsonApiResource).filter(Boolean);
}

async function resolveBigcartelAuth({ account_key }) {
  if (!account_key || !String(account_key).trim()) {
    const err = new Error('account_key is required');
    err.status = 400;
    throw err;
  }
  const trimmedKey = String(account_key).trim();
  const conn = await getBigcartelConnection(trimmedKey);
  if (!conn?.access_token || !conn?.account_id) {
    const err = new Error('No Big Cartel connection found for this account. Connect via GET /bigcartel/auth first.');
    err.status = 400;
    throw err;
  }
  return { accessToken: conn.access_token, accountId: conn.account_id };
}

function summarizeBigcartelHttpError(err) {
  const data = err?.response?.data;
  if (!data) return { message: err?.message || 'Unknown error' };
  return {
    errors: data.errors || data,
    httpStatus: err?.response?.status,
  };
}

async function bigcartelApiCall({ method, path, accessToken, params = {}, body = null }) {
  return axios({
    method,
    url: `${BIGCARTEL_API_BASE}${path}`,
    params,
    data: body || undefined,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.api+json',
      ...(body ? { 'Content-Type': 'application/vnd.api+json' } : {}),
    },
    timeout: 60000,
    validateStatus: () => true,
  });
}

/**
 * Lists orders for a connected Big Cartel account.
 *
 * Big Cartel's docs only document pagination/sort query params (page[limit], page[offset],
 * sort) — no documented date-range or status filter, unlike every other platform's
 * /orders endpoint in this codebase (TikTok/Square/Squarespace all support a startDate/endDate
 * filter server-side). So this endpoint paginates through Big Cartel's results itself and, if
 * startDate/endDate were passed, filters client-side on `created_at` — more requests than a
 * server-side filter would need, but there's no documented alternative.
 *
 * Expects body/query: { account_key, page_limit?, startDate?, endDate?, sort? }.
 */
const getBigcartelOrders = async (req, res) => {
  try {
    const account_key = req.body?.account_key || req.query?.account_key;
    const startDate = req.body?.startDate || req.query?.startDate;
    const endDate = req.body?.endDate || req.query?.endDate;
    const sort = req.body?.sort || req.query?.sort || null;
    const pageLimit = Math.min(Number(req.body?.page_limit || req.query?.page_limit) || 20, 100);

    const { accessToken, accountId } = await resolveBigcartelAuth({ account_key });

    const startMs = startDate ? Date.parse(startDate) : null;
    const endMs = endDate ? Date.parse(endDate) : null;

    const orders = [];
    let offset = 0;
    for (let page = 0; page < 50; page++) {
      const r = await bigcartelApiCall({
        method: 'GET',
        path: `/v1/accounts/${accountId}/orders`,
        accessToken,
        params: {
          'page[limit]': pageLimit,
          'page[offset]': offset,
          ...(sort ? { sort } : {}),
        },
      });
      if (r.status < 200 || r.status >= 300) {
        const err = new Error('Big Cartel order list failed');
        err.response = r;
        throw err;
      }
      const pageOrders = flattenJsonApiCollection(r.data);
      orders.push(...pageOrders);
      const total = r.data?.meta?.count ?? null;
      offset += pageLimit;
      if (!pageOrders.length || (total != null && offset >= total)) break;
    }

    const filtered = (startMs || endMs)
      ? orders.filter((o) => {
        const t = Date.parse(o?.created_at);
        if (!Number.isFinite(t)) return true;
        if (startMs && t < startMs) return false;
        if (endMs && t > endMs) return false;
        return true;
      })
      : orders;

    console.log(JSON.stringify({
      level: 'INFO',
      platform: 'bigcartel',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'getBigcartelOrders',
      operation: 'Big Cartel orders list fetched successfully',
      account_key: String(account_key).trim(),
      result: { count: filtered.length, accountId },
      timestamp: new Date().toISOString(),
    }));

    return res.status(200).json({ success: true, count: filtered.length, orders: filtered });
  } catch (err) {
    console.error(JSON.stringify({
      level: 'ERROR',
      platform: 'bigcartel',
      source: err?.response ? 'bigcartel_api' : 'lambda',
      function: 'getBigcartelOrders',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || err?.status || null,
      message: `Failed to fetch Big Cartel orders: ${err?.message || 'Unknown error'}`,
      detail: summarizeBigcartelHttpError(err),
      timestamp: new Date().toISOString(),
    }));
    return sendApiError(res, err?.status || 500, err?.message || 'Unknown error', err?.data);
  }
};

/** Fetches one Big Cartel order by id, with its line items. */
const getBigcartelOrderById = async (req, res) => {
  try {
    const account_key = req.body?.account_key || req.query?.account_key;
    const order_id = req.body?.order_id || req.query?.order_id;
    if (!order_id) {
      return sendApiError(res, 400, 'Missing required parameter: order_id');
    }

    const { accessToken, accountId } = await resolveBigcartelAuth({ account_key });

    const r = await bigcartelApiCall({
      method: 'GET',
      path: `/v1/accounts/${accountId}/orders/${encodeURIComponent(order_id)}`,
      accessToken,
      params: { include: 'items' },
    });
    if (r.status === 404) {
      return sendApiError(res, 404, `Order not found for id: ${order_id}`);
    }
    if (r.status < 200 || r.status >= 300) {
      return sendApiError(res, r.status >= 400 ? r.status : 502, 'Failed to fetch Big Cartel order detail', summarizeBigcartelHttpError({ response: r }));
    }

    const order = flattenJsonApiResource(r.data?.data);
    // Line items may arrive sideloaded in `included` (JSON:API) rather than inline —
    // surface them alongside the order rather than requiring the caller to parse JSON:API.
    const included = Array.isArray(r.data?.included) ? r.data.included.map(flattenJsonApiResource) : [];
    const lineItems = included.filter((i) => i?.type === 'order_line_items');
    if (lineItems.length) {
      order.items = await resolveLineItemSkus({ accessToken, accountId, lineItems });
    }

    log('Success in getBigcartelOrderById: order_id=%s', order_id);
    return res.status(200).json({ success: true, order });
  } catch (err) {
    console.error(JSON.stringify({
      level: 'ERROR',
      platform: 'bigcartel',
      source: err?.response ? 'bigcartel_api' : 'lambda',
      function: 'getBigcartelOrderById',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      httpStatus: err?.response?.status || err?.status || null,
      message: `Failed to fetch Big Cartel order by id: ${err?.message || 'Unknown error'}`,
      detail: summarizeBigcartelHttpError(err),
      timestamp: new Date().toISOString(),
    }));
    return sendApiError(res, err?.status || 500, err?.message || 'Unknown error', err?.data);
  }
};

/**
 * Adds tracking info to a Big Cartel order once FinerWorks has shipped it, by creating a
 * Shipment resource (POST /shipments) linked to the order — the Big Cartel equivalent of every
 * other platform's "fulfill order with tracking info". See this file's header comment: the
 * exact shipment request body isn't verified against a real Big Cartel account yet.
 *
 * Expects body: { account_key, order_id, carrier?, trackingNumber? } — trackingNumber is
 * looked up from FinerWorks via orderNumber if not supplied directly (same pattern as every
 * other platform's fulfill handler in this codebase).
 */
const fulfillBigcartelOrderWithTrackingInfo = async (req, res) => {
  try {
    const account_key = req.body?.account_key || req.query?.account_key;
    const order_id = req.body?.order_id || req.query?.order_id;
    const orderNumber = req.body?.orderNumber || req.body?.order_po || null;
    const carrier = req.body?.carrier || req.query?.carrier || null;

    if (!order_id) {
      return sendApiError(res, 400, 'Missing required parameter: order_id');
    }

    const { accessToken, accountId } = await resolveBigcartelAuth({ account_key });

    let trackingNumber = req.body?.trackingNumber || req.body?.tracking_number || null;
    if (!trackingNumber && orderNumber) {
      const orderStatusData = await finerworksService.GET_ORDER_STATUS({
        order_pos: [orderNumber],
        account_key: String(account_key).trim(),
      });
      trackingNumber = orderStatusData?.orders?.[0]?.shipments?.[0]?.tracking_number || null;
    }
    if (!trackingNumber) {
      return sendApiError(res, 400, 'Missing required parameter: trackingNumber (or orderNumber to look it up from FinerWorks)');
    }

    const r = await bigcartelApiCall({
      method: 'POST',
      path: `/v1/accounts/${accountId}/shipments`,
      accessToken,
      body: {
        data: {
          type: 'shipments',
          attributes: {
            tracking_number: trackingNumber,
            ...(carrier ? { carrier } : {}),
          },
          relationships: {
            order: { data: { type: 'orders', id: String(order_id) } },
          },
        },
      },
    });
    if (r.status < 200 || r.status >= 300) {
      return sendApiError(res, r.status >= 400 ? r.status : 502, 'Failed to create Big Cartel shipment', summarizeBigcartelHttpError({ response: r }));
    }

    console.log(JSON.stringify({
      level: 'INFO',
      platform: 'bigcartel',
      method: req.method,
      api: req.originalUrl || req.url,
      function: 'fulfillBigcartelOrderWithTrackingInfo',
      operation: 'Big Cartel order fulfilled with tracking info successfully',
      account_key: String(account_key).trim(),
      result: { order_id, trackingNumber, carrier },
      timestamp: new Date().toISOString(),
    }));

    return res.status(200).json({
      success: true,
      message: 'Big Cartel order fulfilled with tracking info',
      shipment: flattenJsonApiResource(r.data?.data),
    });
  } catch (err) {
    console.error(JSON.stringify({
      level: 'ERROR',
      platform: 'bigcartel',
      source: err?.response ? 'bigcartel_api' : 'finerworks_api',
      function: 'fulfillBigcartelOrderWithTrackingInfo',
      account_key: req.body?.account_key || req.query?.account_key || 'unknown',
      order_id: req.body?.order_id || req.query?.order_id || 'unknown',
      httpStatus: err?.response?.status || err?.status || null,
      message: `Big Cartel order fulfillment failed: ${err?.message || 'Unknown error'}`,
      detail: summarizeBigcartelHttpError(err),
      timestamp: new Date().toISOString(),
    }));
    return sendApiError(res, err?.status || 500, err?.message || 'Unknown error', err?.data);
  }
};

module.exports = {
  getBigcartelOrders,
  getBigcartelOrderById,
  fulfillBigcartelOrderWithTrackingInfo,
  resolveBigcartelAuth,
  bigcartelApiCall,
  flattenJsonApiResource,
  flattenJsonApiCollection,
  summarizeBigcartelHttpError,
  extractSkuFromDescription,
  resolveLineItemSkus,
};
