const axios = require('axios');
const {
  resolveWixAuth,
  buildAuthHeaders,
  summarizeWixHttpError,
  maybePersistDiscoveredWixSiteId
} = require('./wix-products');

const WIX_SEARCH_ORDERS_URL = 'https://www.wixapis.com/ecom/v1/orders/search';
const MAX_ORDER_SEARCH_PAGES = 100;

function toIsoOrNull(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Wix search rejects putting both bounds in one map: `{ createdDate: { $gte, $lte } }`.
 * Use `$and` with two clauses. Operators here are the standard Wix query language
 * `$gte` / `$lte` (not `$ge` / `$le`; those appear on other endpoints only).
 */
function createdDateRangeFilter(startIso, endIso) {
  return {
    $and: [{ createdDate: { $gte: startIso } }, { createdDate: { $lte: endIso } }]
  };
}

/** For `YYYY-MM-DD` only (no time), bound to full UTC days so last day is inclusive. */
function parseDateRangeInputs(startRaw, endRaw) {
  const startTrim = String(startRaw || '').trim();
  const endTrim = String(endRaw || '').trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;

  let startIso = null;
  let endIso = null;

  if (dateOnly.test(startTrim)) {
    startIso = `${startTrim}T00:00:00.000Z`;
  } else {
    startIso = toIsoOrNull(startTrim);
  }

  if (dateOnly.test(endTrim)) {
    endIso = `${endTrim}T23:59:59.999Z`;
  } else {
    endIso = toIsoOrNull(endTrim);
  }

  return { startIso, endIso };
}


/** UUID-ish order id used for GET order by path. */
function looksLikeOrderGuid(raw) {
  const s = String(raw || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function parseOrderNumber(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const s = String(raw).trim().replace(/^#/, '');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function searchWixOrdersPage(wixAuth, body) {
  const headers = buildAuthHeaders(wixAuth);
  return axios.post(WIX_SEARCH_ORDERS_URL, body, {
    headers,
    timeout: 120000,
    validateStatus: () => true
  });
}

async function fetchAllOrdersBySearch({ wixAuth, buildFirstBodyFn }) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < MAX_ORDER_SEARCH_PAGES; page++) {
    const searchPayload =
      page === 0
        ? buildFirstBodyFn()
        : {
            search: {
              cursorPaging: {
                limit: 100,
                cursor
              }
            }
          };

    const r = await searchWixOrdersPage(wixAuth, searchPayload);

    if (r.status < 200 || r.status >= 300) {
      const err = new Error('Wix search orders failed');
      err.response = r;
      throw err;
    }

    const orders = Array.isArray(r?.data?.orders) ? r.data.orders : [];
    out.push(...orders);

    const meta = r?.data?.metadata || r?.data?.pagingMetadata || {};
    const hasNext = meta.hasNext === true;
    const nextCursor =
      meta.cursors?.next || meta.cursor?.next || (typeof meta.next === 'string' ? meta.next : null);

    if (!hasNext || !nextCursor) break;
    cursor = nextCursor;
  }

  return out;
}

/**
 * Lists Wix eCommerce orders, optionally filtered by createdDate range.
 * Mirrors POST /squarespace/orders shape: account_key, startDate/endDate (optional pairs).
 *
 * Requires app permission: READ-ORDERS.
 */
exports.getWixOrders = async (req, res) => {
  try {
    const account_key =
      req.body?.account_key ||
      req.body?.accountKey ||
      req.query?.account_key ||
      req.query?.accountKey;

    const access_token =
      req.body?.access_token ||
      req.query?.access_token ||
      req.headers['x-wix-access-token'];

    if (!account_key || !String(account_key).trim()) {
      return res.status(400).json({ success: false, message: 'account_key is required' });
    }

    const wixAuth = await resolveWixAuth({
      account_key: String(account_key).trim(),
      access_token,
      ignoreRequestToken: false
    });

    if (!wixAuth?.accessToken) {
      return res.status(401).json({
        success: false,
        message: 'Wix credentials not configured. Connect Wix / pass access_token or set env vars.'
      });
    }

    if (wixAuth.siteId && account_key) {
      await maybePersistDiscoveredWixSiteId(String(account_key).trim(), wixAuth.siteId);
    }

    const startDate =
      req.body?.startDate || req.body?.start_date || req.query?.startDate || req.query?.start_date;
    const endDate =
      req.body?.endDate || req.body?.end_date || req.query?.endDate || req.query?.end_date;

    const { startIso, endIso } = parseDateRangeInputs(startDate, endDate);

    if ((startIso && !endIso) || (!startIso && endIso)) {
      return res.status(400).json({
        success: false,
        message: 'Provide both startDate and endDate or omit both.'
      });
    }

    let filter = {};
    if (startIso && endIso) {
      filter = createdDateRangeFilter(startIso, endIso);
    }

    const orders = await fetchAllOrdersBySearch({
      wixAuth,
      buildFirstBodyFn: () => ({
        search: {
          ...(Object.keys(filter).length ? { filter } : {}),
          cursorPaging: { limit: 100 },
          sort: [{ fieldName: 'createdDate', order: 'DESC' }]
        }
      })
    });

    return res.status(200).json({
      success: true,
      count: orders.length,
      orders
    });
  } catch (err) {
    const r = err?.response;
    const status = r?.status || err?.response?.status || 500;
    const wixPayload = typeof r?.data !== 'undefined' ? summarizeWixHttpError(r) : null;
    return res.status(status).json({
      success: false,
      message: 'Failed to retrieve Wix orders',
      error: wixPayload?.message || err?.message || 'Unknown error',
      ...(wixPayload ? { wixError: wixPayload } : {})
    });
  }
};

/**
 * Fetches one order by Wix order GUID (`order_id`) or by dashboard order `number`.
 * Accepts Shopify-style `#12345` display form for numbers.
 *
 * Provide exactly one of: order_id | order_number / orderNumber / orderName.
 */
exports.getWixOrderByNumber = async (req, res) => {
  try {
    const account_key =
      req.body?.account_key ||
      req.body?.accountKey ||
      req.query?.account_key ||
      req.query?.accountKey;

    const access_token =
      req.body?.access_token ||
      req.query?.access_token ||
      req.headers['x-wix-access-token'];

    const orderIdRaw =
      req.body?.order_id ||
      req.body?.orderId ||
      req.query?.order_id ||
      req.query?.orderId ||
      null;

    const orderNumRaw =
      req.body?.order_number ||
      req.body?.orderNumber ||
      req.body?.orderName ||
      req.body?.order_name ||
      req.query?.order_number ||
      req.query?.orderNumber ||
      req.query?.orderName ||
      null;

    if (!account_key || !String(account_key).trim()) {
      return res.status(400).json({ success: false, message: 'account_key is required' });
    }

    const orderIdTrim = orderIdRaw != null && String(orderIdRaw).trim() ? String(orderIdRaw).trim() : null;
    const orderNumStrTrim =
      orderNumRaw !== undefined && orderNumRaw !== null && String(orderNumRaw).trim()
        ? String(orderNumRaw).trim()
        : null;

    if (orderIdTrim && orderNumStrTrim) {
      return res.status(400).json({
        success: false,
        message: 'Provide only one of order_id or order_number (order_number / orderName)'
      });
    }

    if (!orderIdTrim && !orderNumStrTrim) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameter: order_id or order_number'
      });
    }

    const wixAuth = await resolveWixAuth({
      account_key: String(account_key).trim(),
      access_token,
      ignoreRequestToken: false
    });

    if (!wixAuth?.accessToken) {
      return res.status(401).json({
        success: false,
        message: 'Wix credentials not configured. Connect Wix / pass access_token or set env vars.'
      });
    }

    if (wixAuth.siteId && account_key) {
      await maybePersistDiscoveredWixSiteId(String(account_key).trim(), wixAuth.siteId);
    }

    const headers = buildAuthHeaders(wixAuth);

    const fetchOrderByGuid = async (guid) => {
      const url = `https://www.wixapis.com/ecom/v1/orders/${encodeURIComponent(guid)}`;
      const r = await axios.get(url, { headers, timeout: 120000, validateStatus: () => true });

      if (r.status >= 200 && r.status < 300) {
        const order = r?.data?.order ?? r?.data ?? null;
        if (!order) {
          return res.status(502).json({ success: false, message: 'Wix returned an empty order payload' });
        }
        return res.status(200).json({ success: true, order });
      }

      const wixPayload = summarizeWixHttpError(r);
      const st = r.status >= 400 && r.status < 600 ? r.status : 502;
      if (st === 404) {
        return res.status(404).json({
          success: false,
          message: `Order not found for order_id: ${guid}`,
          wixError: wixPayload
        });
      }
      return res.status(st).json({
        success: false,
        message: 'Failed to retrieve Wix order by id',
        wixError: wixPayload
      });
    };

    if (orderIdTrim) {
      if (!looksLikeOrderGuid(orderIdTrim)) {
        return res.status(400).json({
          success: false,
          message: 'order_id must be a Wix order GUID (UUID)'
        });
      }
      return fetchOrderByGuid(orderIdTrim);
    }

    if (looksLikeOrderGuid(orderNumStrTrim)) {
      return fetchOrderByGuid(orderNumStrTrim);
    }

    const orderNum = parseOrderNumber(orderNumStrTrim);
    if (orderNum === null) {
      return res.status(400).json({
        success: false,
        message: 'order_number must be numeric or a Wix order GUID (UUID)'
      });
    }

    const r = await searchWixOrdersPage(wixAuth, {
      search: {
        filter: { number: orderNum },
        cursorPaging: { limit: 5 }
      }
    });

    if (r.status < 200 || r.status >= 300) {
      const wixPayload = summarizeWixHttpError(r);
      return res.status(r.status >= 400 ? r.status : 502).json({
        success: false,
        message: 'Failed to search Wix order by number',
        wixError: wixPayload
      });
    }

    const orders = Array.isArray(r?.data?.orders) ? r.data.orders : [];
    const found = orders.find((o) => Number(o?.number) === orderNum) || orders[0] || null;

    if (!found) {
      return res.status(404).json({
        success: false,
        message: `Order not found for order_number: ${orderNumStrTrim}`
      });
    }

    return res.status(200).json({ success: true, order: found });
  } catch (err) {
    const r = err?.response;
    const status = r?.status || err?.response?.status || 500;
    const wixPayload = typeof r?.data !== 'undefined' ? summarizeWixHttpError(r) : null;
    return res.status(status).json({
      success: false,
      message: 'Failed to retrieve Wix order',
      error: wixPayload?.message || err?.message || 'Unknown error',
      ...(wixPayload ? { wixError: wixPayload } : {})
    });
  }
};
