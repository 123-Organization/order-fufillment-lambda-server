# API error responses

Platform APIs (Shopify, Squarespace, Wix) return errors in a consistent envelope. **Success responses are unchanged** (`success: true`, `ignored: true`, batch `results`, etc.).

## Error envelope

```json
{
  "status": false,
  "message": "Human-readable error message",
  "data": {}
}
```

| Field | Description |
|-------|-------------|
| `status` | Always `false` for errors |
| `message` | Safe message for clients |
| `data` | Optional non-sensitive metadata (never tokens, stack traces, or raw upstream payloads) |

HTTP status code is set on the response (400, 401, 404, 502, etc.).

## Infrastructure

| File | Role |
|------|------|
| [`src/helpers/api-error.js`](../src/helpers/api-error.js) | `ApiError`, `sendApiError`, `normalizeError`, `sanitizePublicData`, `safeWixErrorData` |
| [`src/middleware/error-handler.js`](../src/middleware/error-handler.js) | Express 4-arg middleware; catches `next(err)` and unhandled throws |
| [`src/middleware/async-handler.js`](../src/middleware/async-handler.js) | Wraps async route handlers so rejections reach the error middleware |
| [`app.js`](../app.js) | Registers `notFoundHandler`, `errorHandler`, process-level rejection logging |

Platform routes in [`src/controllers/routes.js`](../src/controllers/routes.js) and Wix JWT routes in `app.js` use `asyncHandler(...)`.

## Usage in controllers

### Validation / operational errors

```javascript
const { sendApiError } = require('../helpers/api-error');

if (!account_key) {
  return sendApiError(res, 400, 'account_key is required');
}
```

### With safe metadata

```javascript
return sendApiError(res, 404, 'Wix order not found', {
  orderId: guid,
  platform: 'wix',
});
```

### Catch blocks

```javascript
} catch (err) {
  return sendApiError(res, err);
}
```

Or throw / `next(err)` when the handler is wrapped with `asyncHandler`:

```javascript
throw new ApiError(502, 'Upstream service unavailable', { platform: 'wix' });
```

### Wix upstream errors

Do not return raw `wixError` / `wixResponse`. Use:

```javascript
const { sendApiError, safeWixErrorData } = require('../helpers/api-error');

return sendApiError(res, 502, 'Failed to create Wix fulfillment', safeWixErrorData(wixPayload));
```

## Allowed `data` fields

`code`, `field`, `orderId`, `orderNumber`, `sku`, `eventType`, `entityFqdn`, `platform`, `httpStatus`, `httpStatusText`, `detail`, `orderIdFromEvent`, `shopDomain`, `hint403`, `status`, `message`, `errors`, `validationError`.

**Never expose:** stack traces, axios `config`, headers, access tokens, env secrets, full webhook bodies, raw JWTs.

## Frontend migration

For platform APIs, check **`status === false`** (or HTTP 4xx/5xx) instead of only `success === false`.

Success paths still use `success: true` until a future migration.

## Manual checks

```bash
# 400 validation
curl -s -X POST http://localhost:9001/api/wix/sync-products \
  -H 'Content-Type: application/json' \
  -d '{"productList":[]}' | jq .

# 404 unknown route
curl -s http://localhost:9001/api/does-not-exist | jq .
```

Expected error shape: `{ "status": false, "message": "...", "data": {} }`.