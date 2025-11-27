# Update Order Reference Numbers - Sample Payload

## Endpoint
`POST /shopify/update-order-reference-numbers`

## Description
This endpoint accepts an array of orders and updates each order's metafield with a reference number in Shopify using GraphQL API.

## Request Headers (Optional)
```
Authorization: Bearer <access_token>
X-Shopify-Access-Token: <access_token>
```

## Request Body Structure

### Basic Request (All orders use same store and access token)
```json
{
  "storeName": "finerworks-dev-store.myshopify.com",
  "access_token": "shpua_9c16eb994c4401fa6c9d19a95a930795",
  "namespace": "custom",
  "metafieldKey": "reference_number",
  "orders": [
    {
      "orderId": "gid://shopify/Order/6961433379098",
      "orderName": "#1005",
      "referenceNumber": "REF-2024-001"
    },
    {
      "orderId": "gid://shopify/Order/6961433379099",
      "orderName": "#1006",
      "referenceNumber": "REF-2024-002"
    },
    {
      "orderId": "6961433379100",
      "orderName": "#1007",
      "referenceNumber": "REF-2024-003"
    }
  ]
}
```

### Advanced Request (Each order can have its own store and access token)
```json
{
  "storeName": "finerworks-dev-store.myshopify.com",
  "access_token": "shpua_9c16eb994c4401fa6c9d19a95a930795",
  "namespace": "custom",
  "metafieldKey": "reference_number",
  "orders": [
    {
      "orderId": "gid://shopify/Order/6961433379098",
      "orderName": "#1005",
      "referenceNumber": "REF-2024-001",
      "storeName": "finerworks-dev-store.myshopify.com",
      "access_token": "shpua_9c16eb994c4401fa6c9d19a95a930795"
    },
    {
      "orderId": "gid://shopify/Order/6961433379099",
      "orderName": "#1006",
      "referenceNumber": "REF-2024-002",
      "namespace": "finerworks",
      "metafieldKey": "order_ref"
    }
  ]
}
```

### Minimal Request (Using order name instead of orderId)
```json
{
  "storeName": "finerworks-dev-store.myshopify.com",
  "access_token": "shpua_9c16eb994c4401fa6c9d19a95a930795",
  "orders": [
    {
      "orderName": "#1005",
      "referenceNumber": "REF-2024-001"
    },
    {
      "orderName": "#1006",
      "referenceNumber": "REF-2024-002"
    }
  ]
}
```

## Request Parameters

### Top-level Parameters
- `storeName` (required): Shopify store name (e.g., "finerworks-dev-store.myshopify.com" or "finerworks-dev-store")
- `access_token` (required): Shopify access token
- `namespace` (optional, default: "custom"): Metafield namespace
- `metafieldKey` (optional, default: "reference_number"): Metafield key name
- `orders` (required): Array of order objects

### Order Object Parameters
- `orderId` (required*): Shopify order ID (GID format or numeric)
  - Can use: `orderId`, `order_id`, or `id`
  - *Required if `orderName` is not provided
- `orderName` (required*): Shopify order name (e.g., "#1005")
  - Can use: `orderName` or `order_name`
  - *Required if `orderId` is not provided
- `referenceNumber` (required): Reference number to save in metafield
  - Can use: `referenceNumber`, `reference_number`, or `reference`
- `storeName` (optional): Override store name for this specific order
- `access_token` (optional): Override access token for this specific order
- `namespace` (optional): Override namespace for this specific order
- `metafieldKey` (optional): Override metafield key for this specific order
  - Can use: `metafieldKey` or `metafield_key`

## Response Format

### Success Response (All orders succeeded)
```json
{
  "success": true,
  "message": "All orders updated successfully",
  "results": [
    {
      "success": true,
      "orderId": "gid://shopify/Order/6961433379098",
      "orderIndex": 0,
      "order": "#1005",
      "referenceNumber": "REF-2024-001",
      "metafield": {
        "id": "gid://shopify/Metafield/123456789",
        "namespace": "custom",
        "key": "reference_number",
        "value": "REF-2024-001"
      }
    },
    {
      "success": true,
      "orderId": "gid://shopify/Order/6961433379099",
      "orderIndex": 1,
      "order": "#1006",
      "referenceNumber": "REF-2024-002",
      "metafield": {
        "id": "gid://shopify/Metafield/123456790",
        "namespace": "custom",
        "key": "reference_number",
        "value": "REF-2024-002"
      }
    }
  ],
  "total": 2,
  "succeeded": 2,
  "failed": 0
}
```

### Partial Success Response (Some orders failed)
```json
{
  "success": false,
  "message": "Some orders failed to update",
  "results": [
    {
      "success": true,
      "orderId": "gid://shopify/Order/6961433379098",
      "orderIndex": 0,
      "order": "#1005",
      "referenceNumber": "REF-2024-001",
      "metafield": {
        "id": "gid://shopify/Metafield/123456789",
        "namespace": "custom",
        "key": "reference_number",
        "value": "REF-2024-001"
      }
    },
    {
      "success": false,
      "error": "Order not found",
      "orderIndex": 1,
      "order": "#1006",
      "referenceNumber": "REF-2024-002"
    }
  ],
  "total": 2,
  "succeeded": 1,
  "failed": 1
}
```

### Error Response
```json
{
  "success": false,
  "message": "Request body must contain an \"orders\" array"
}
```

## Status Codes
- `200`: All orders updated successfully
- `207`: Multi-Status (some succeeded, some failed)
- `400`: Bad Request (validation errors, all orders failed)
- `500`: Internal Server Error

## Notes
1. Order IDs can be provided in GID format (`gid://shopify/Order/123456`) or numeric format (`123456`)
2. If both `orderId` and `orderName` are provided, `orderId` takes precedence
3. If `orderName` is provided without `orderId`, the function will fetch the order first to get the ID
4. Each order in the array is processed independently - if one fails, others continue processing
5. The metafield will be created if it doesn't exist, or updated if it already exists
6. Default namespace is "custom" and default key is "reference_number" if not specified

## Example cURL Request
```bash
curl -X POST https://your-api-domain.com/shopify/update-order-reference-numbers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer shpua_9c16eb994c4401fa6c9d19a95a930795" \
  -d '{
    "storeName": "finerworks-dev-store.myshopify.com",
    "orders": [
      {
        "orderId": "gid://shopify/Order/6961433379098",
        "orderName": "#1005",
        "referenceNumber": "REF-2024-001"
      },
      {
        "orderId": "gid://shopify/Order/6961433379099",
        "orderName": "#1006",
        "referenceNumber": "REF-2024-002"
      }
    ]
  }'
```

