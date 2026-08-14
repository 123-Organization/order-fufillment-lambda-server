const SENSITIVE_KEYS = new Set([
  'stack',
  'config',
  'headers',
  'request',
  'authorization',
  'access_token',
  'accessToken',
  'refresh_token',
  'client_secret',
  'web_api_key',
  'app_key',
  'rawBody',
  'wixResponse',
  'webhook_payload',
  'accountInfo',
]);

const ALLOWED_DATA_KEYS = new Set([
  'code',
  'field',
  'orderId',
  'orderNumber',
  'sku',
  'eventType',
  'entityFqdn',
  'platform',
  'httpStatus',
  'httpStatusText',
  'detail',
  'orderIdFromEvent',
  'shopDomain',
  'hint403',
  'status',
  'message',
  'errors',
  'validationError',
]);

class ApiError extends Error {
  constructor(statusCode, message, data = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.data = data;
  }
}

function sanitizePublicData(data) {
  if (data == null) return {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    return {};
  }

  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEYS.has(key)) continue;
    if (!ALLOWED_DATA_KEYS.has(key)) continue;
    if (value == null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      continue;
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      const nested = sanitizePublicData(value);
      if (Object.keys(nested).length) out[key] = nested;
    }
  }
  return out;
}

function extractAxiosMessage(err) {
  const d = err?.response?.data;
  if (typeof d === 'string' && d.trim()) return d.trim().slice(0, 500);
  if (d && typeof d === 'object') {
    if (typeof d.message === 'string' && d.message.trim()) return d.message.trim();
    // Shippo (and other DRF-style APIs) return errors as { detail: "..." } rather than
    // { message: "..." } — e.g. a revoked/invalid Shippo API token responds with
    // {"detail":"Token does not exist"}. Without this, callers only ever saw the generic
    // axios "Request failed with status code 401" instead of the actual reason.
    if (typeof d.detail === 'string' && d.detail.trim()) return d.detail.trim().slice(0, 500);
    if (Array.isArray(d.errors) && d.errors.length) {
      const parts = d.errors
        .map((e) => (typeof e === 'string' ? e : e?.message))
        .filter(Boolean);
      if (parts.length) return String(parts[0]).slice(0, 500);
    }
  }
  if (typeof err?.message === 'string' && err.message.trim()) return err.message.trim();
  return 'Request failed';
}

function normalizeError(err) {
  if (err instanceof ApiError) {
    return {
      statusCode: err.statusCode,
      message: err.message,
      data: err.data || {},
    };
  }

  // Plain custom error objects (e.g. `{ status, message, data }` thrown directly by application
  // code) land here. Axios errors are excluded via `!err.response` — recent axios versions (1.x)
  // also set `.status` as a convenience alias for `.response.status`, so without this exclusion
  // every axios error would match this branch first and use the generic `err.message` ("Request
  // failed with status code 401") instead of the proper detail-extracting branch below, silently
  // dropping the upstream API's actual error detail (e.g. Shippo's `{"detail":"Token does not
  // exist"}") on every request across the whole codebase, not just this one endpoint.
  if (err && !err.response && typeof err.status === 'number' && err.status >= 400 && err.status < 600) {
    return {
      statusCode: err.status,
      message: typeof err.message === 'string' ? err.message : 'Request failed',
      data: sanitizePublicData(err.data || {}),
    };
  }

  const axiosStatus = err?.response?.status;
  if (axiosStatus != null) {
    const statusCode = axiosStatus >= 400 && axiosStatus < 600 ? axiosStatus : 502;
    return {
      statusCode,
      message: extractAxiosMessage(err),
      data: sanitizePublicData({
        httpStatus: axiosStatus,
        httpStatusText: err?.response?.statusText,
        platform: err?.platform || undefined,
      }),
    };
  }

  return {
    statusCode: 500,
    message:
      typeof err?.message === 'string' && err.message.trim()
        ? err.message.trim()
        : 'Internal server error',
    data: {},
  };
}

/**
 * Send a consistent API error envelope: { status: false, message, data }.
 * Usage:
 *   sendApiError(res, 400, 'Bad request', { field: 'account_key' })
 *   sendApiError(res, err)  // normalizes Error / ApiError / axios
 */
function sendApiError(res, statusCodeOrErr, message, data) {
  if (typeof statusCodeOrErr === 'number') {
    const statusCode = statusCodeOrErr;
    const safeData = sanitizePublicData(data || {});
    return res.status(statusCode).json({
      status: false,
      message: String(message || 'Request failed'),
      data: safeData,
    });
  }

  const normalized = normalizeError(statusCodeOrErr);
  const safeData = sanitizePublicData(normalized.data);
  return res.status(normalized.statusCode).json({
    status: false,
    message: normalized.message,
    data: safeData,
  });
}

function safeWixErrorData(wixPayload) {
  if (!wixPayload || typeof wixPayload !== 'object') return { platform: 'wix' };
  return sanitizePublicData({
    platform: 'wix',
    httpStatus: wixPayload.httpStatus,
    httpStatusText: wixPayload.httpStatusText,
    detail:
      typeof wixPayload.message === 'string'
        ? wixPayload.message.slice(0, 500)
        : undefined,
    hint403: wixPayload.hint403,
  });
}

module.exports = {
  ApiError,
  sendApiError,
  normalizeError,
  sanitizePublicData,
  safeWixErrorData,
};
