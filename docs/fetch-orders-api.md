# `POST /api/fetch-orders`

One endpoint for fetching orders from connected e-commerce platforms.

**Base URL:** `https://<API_GATEWAY_ID>.execute-api.<region>.amazonaws.com/Prod`. Replace this with the deployed host.

## Platforms

| Platform | Status |
|---|---|
| `wix` | Supported |
| `squarespace` | Supported |
| `square` | Not yet. Returns `501`. Use `POST /api/square/orders` for now. |
| `shopify` | Not yet. Returns `501`. Use `POST /api/shopify/orders` for now. |
| `etsy`, `woocommerce` | Not yet. Returns `501`. |

## How the mode is chosen

There is no mode flag. The endpoint chooses based on what you send:

- **Single-order mode:** the body includes any of `order_id`, `orderId`, `order_number`, `orderNumber`, `orderName` or `order_name`.
- **List mode:** none of those fields are present.

If you send `account_key`, it must be a valid UUID v4. Otherwise you get `400`.

## Request parameters

### Wix

| Field | Required | Notes |
|---|---|---|
| `platform` | Yes | `"wix"` |
| `account_key` | Yes | The Wix token is looked up from the account's saved connection. |
| `startDate`, `endDate` | No (list mode) | Send both or neither. Accepts `YYYY-MM-DD` or a full ISO date-time. |
| `order_number` | Single mode | `"1023"` and `"#1023"` both work. Also accepts an array of up to 100 numbers to fetch several orders at once. |
| `order_id` | Single mode | The Wix order GUID. Do not send it together with `order_number`. |

### Squarespace

| Field | Required | Notes |
|---|---|---|
| `platform` | Yes | `"squarespace"` |
| `access_token` | Yes | The Squarespace access token. |
| `fulfillmentStatus` | Yes (list mode) | `PENDING`, `FULFILLED` or `CANCELED` |
| `startDate`, `endDate` | Yes (list mode) | At least one is required. The date filter only applies when you send both. |
| `customerId` | No | Filters the list by customer. |
| `orderNumber` | Single mode | Can be slow, because the backend pages through every order in the store to find the match. |

## Examples

### 1. Wix: list orders

```bash
curl -X POST "$BASE_URL/api/fetch-orders" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "wix",
    "account_key": "xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx",
    "startDate": "2026-09-01",
    "endDate": "2026-10-05"
  }'
```

### 2. Wix: one order

```bash
curl -X POST "$BASE_URL/api/fetch-orders" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "wix",
    "account_key": "xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx",
    "order_number": "1023"
  }'
```

### 3. Wix: several orders at once (up to 100)

```bash
curl -X POST "$BASE_URL/api/fetch-orders" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "wix",
    "account_key": "xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx",
    "order_number": ["1023", "1024", "1025"]
  }'
```

### 4. Squarespace: list orders

```bash
curl -X POST "$BASE_URL/api/fetch-orders" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "squarespace",
    "account_key": "xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx",
    "access_token": "<SQUARESPACE_ACCESS_TOKEN>",
    "startDate": "2026-09-01T00:00:00Z",
    "endDate": "2026-10-05T23:59:59Z",
    "fulfillmentStatus": "PENDING"
  }'
```

### 5. Squarespace: one order

```bash
curl -X POST "$BASE_URL/api/fetch-orders" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "squarespace",
    "account_key": "xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx",
    "access_token": "<SQUARESPACE_ACCESS_TOKEN>",
    "orderNumber": "1001"
  }'
```

## Responses

### List (examples 1, 3 and 4)

```json
{
  "success": true,
  "platform": "wix",
  "mode": "list",
  "count": 2,
  "orders": [ ... ]
}
```

- The Wix batch call (example 3) returns `"mode": "single"` and may also include `"not_found": ["1025"]`.
- A Squarespace list may also include `totalAvailableCount`, `submittedCount` and `pendingCount`.

### Single (examples 2 and 5)

```json
{
  "success": true,
  "platform": "squarespace",
  "mode": "single",
  "order": { ... }
}
```

### Errors

The response is the platform's own error body with `platform` and `mode` added.

| Status | Meaning |
|---|---|
| `400` | A parameter is missing or invalid, or `platform` is missing or unknown. |
| `401` | The Wix account isn't connected. |
| `404` | No order with that number. |
| `501` | The platform isn't supported by this endpoint yet. |
