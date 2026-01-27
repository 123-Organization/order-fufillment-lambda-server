const axios = require('axios');
const finerworksService = require("../helpers/finerworks-service");

const normalizeShopDomain = (shopInput) => {
  if (!shopInput) return null;
  let shopDomain = shopInput.trim().toLowerCase();
  if (!shopDomain.includes('.')) {
    shopDomain = `${shopDomain}.myshopify.com`;
  }
  if (!shopDomain.endsWith('.myshopify.com')) {
    // If user passed full domain that isn't myshopify subdomain, keep as-is
    // but most Shopify Admin API calls expect *.myshopify.com
    // We'll assume provided input is correct in that case
    return shopDomain;
  }
  return shopDomain;
};

// Reusable GraphQL mutation for creating a Shopify product
// NOTE: media is provided as a separate argument, NOT inside ProductInput.
const PRODUCT_CREATE_MUTATION = `
  mutation productCreate($input: ProductInput!, $media: [CreateMediaInput!]) {
    productCreate(input: $input, media: $media) {
      product {
        id
        title
        handle
        status
        media(first: 5) {
          nodes {
            ... on MediaImage {
              id
              image {
                url
                altText
              }
            }
          }
        }
        variants(first: 1) {
          nodes {
            id
            inventoryItem {
              id
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// Map incoming inventory product to Shopify ProductInput
const mapInventoryProductToShopifyInput = (product) => {
  const labels = Array.isArray(product?.labels) ? product.labels : [];

  const findLabelValue = (key) => {
    const entry = labels.find(l => String(l.key).toLowerCase() === String(key).toLowerCase());
    return entry ? entry.value : null;
  };

  const title = product?.name || findLabelValue('title') || product?.sku || product?.product_code || 'Untitled Product';
  const descriptionHtml = product?.description_long || product?.description_short || '';
  const productType = findLabelValue('type') || null;

  const tags = labels.map(l => `${l.key}: ${l.value}`);

  // Optional: product options (for variants) can be precomputed and attached
  // to the product object as `product.productOptions` by higher-level logic
  // (for example, based on grouped variants sharing the same image_guid).
  const productOptions = Array.isArray(product?.productOptions)
    ? product.productOptions
    : null;

  // NOTE:
  // New Shopify Product APIs (2024-04+) no longer allow variants/images/media
  // on ProductInput. We create a basic product here, then attach media and
  // inventory separately.
  const input = {
    title,
    descriptionHtml,
    status: 'ACTIVE',
    tags: tags.length ? tags : undefined,
    productType: productType || undefined,
    productOptions: productOptions || undefined
  };

  // Remove undefined fields to keep the payload clean
  Object.keys(input).forEach((key) => {
    if (input[key] === undefined || input[key] === null) {
      delete input[key];
    }
  });

  return input;
};

// Low-level helper to call Shopify productCreate
const createShopifyProduct = async ({ shopDomain, accessToken, apiVersion, product }) => {
  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  const headers = {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json'
  };

  const input = mapInventoryProductToShopifyInput(product);

  // Build media array from product image URLs (if any)
  const media = [];
  if (product?.image_url_1) {
    media.push({
      alt: product?.name || product?.sku || null,
      mediaContentType: 'IMAGE',
      originalSource: product.image_url_1
    });
  }

  let resp;
  try {
    resp = await axios.post(
      endpoint,
      {
        query: PRODUCT_CREATE_MUTATION,
        variables: {
          input,
          // If no media, pass null so GraphQL can accept optional variable
          media: media.length ? media : null
        }
      },
      { headers }
    );
  } catch (err) {
    const status = err?.response?.status || 500;
    const message =
      (err?.response?.data && (err.response.data.errors || err.response.data.error)) ||
      err.message ||
      'Request failed';
    const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = status;
    throw error;
  }

  if (resp.data.errors) {
    const message = Array.isArray(resp.data.errors)
      ? resp.data.errors.map(e => e.message).join('; ')
      : 'Unknown GraphQL error';
    const error = new Error(message);
    error.status = 502;
    throw error;
  }

  const createPayload = resp.data?.data?.productCreate;
  if (!createPayload) {
    const error = new Error('Invalid Shopify response for productCreate');
    error.status = 502;
    throw error;
  }

  if (Array.isArray(createPayload.userErrors) && createPayload.userErrors.length > 0) {
    const message = createPayload.userErrors
      .map(e => `${e.field ? e.field.join('.') : 'error'}: ${e.message}`)
      .join('; ');
    const error = new Error(message);
    error.status = 400;
    throw error;
  }

  return createPayload.product;
};

// (Image media is now attached via the productCreate media argument; no separate mutation needed here.)

// Query to get available locations (we'll choose a sensible default in code)
const LOCATIONS_QUERY = `
{
  locations(first: 20) {
    edges {
      node {
        id
        name
      }
    }
  }
}
`;

const fetchPrimaryLocation = async ({ shopDomain, accessToken, apiVersion }) => {
  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  const headers = {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json'
  };

  try {
    const resp = await axios.post(
      endpoint,
      {
        query: LOCATIONS_QUERY,
        variables: {}
      },
      { headers }
    );

    if (resp.data.errors) {
      const message = Array.isArray(resp.data.errors)
        ? resp.data.errors.map(e => e.message).join('; ')
        : 'Unknown GraphQL error';
      const error = new Error(message);
      error.status = 502;
      throw error;
    }

    const data = resp.data?.data || {};
    const edges = data.locations?.edges || [];
    if (!edges.length) {
      return null;
    }

    // Prefer a location whose name includes "shop location" (case-insensitive)
    const shopLocationEdge = edges.find(
      (e) => e?.node?.name && e.node.name.toLowerCase().includes('shop location')
    );

    const chosen = shopLocationEdge || edges[0];
    return chosen.node.id;
  } catch (err) {
    const status = err?.response?.status || 500;
    const message =
      (err?.response?.data && (err.response.data.errors || err.response.data.error)) ||
      err.message ||
      'Request failed';
    const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = status;
    throw error;
  }
};

// Query to list delivery (shipping) profiles via GraphQL Admin API
const DELIVERY_PROFILES_QUERY = `
{
  deliveryProfiles(first: 50) {
    edges {
      node {
        id
        name
      }
    }
  }
}
`;

// Fetch a delivery profile GID by its human-readable name (e.g. "FinerWorks Shipping")
const fetchDeliveryProfileGidByName = async ({ shopDomain, accessToken, apiVersion, profileName }) => {
  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  const headers = {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json'
  };

  try {
    const resp = await axios.post(
      endpoint,
      {
        query: DELIVERY_PROFILES_QUERY,
        variables: {}
      },
      { headers }
    );
    if (resp.data.errors) {
      const message = Array.isArray(resp.data.errors)
        ? resp.data.errors.map(e => e.message).join('; ')
        : 'Unknown GraphQL error';
      const error = new Error(message);
      error.status = 502;
      throw error;
    }

    const edges = resp.data?.data?.deliveryProfiles?.edges || [];
    if (!edges.length) {
      return null;
    }

    const matchEdge = edges.find(
      (e) =>
        e?.node?.name &&
        e.node.name.trim().toLowerCase() === profileName.trim().toLowerCase()
    );

    return matchEdge?.node?.id || null;
  } catch (err) {
    const status = err?.response?.status || 500;
    const message =
      (err?.response?.data && (err.response.data.errors || err.response.data.error)) ||
      err.message ||
      'Request failed';
    const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = status;
    throw error;
  }
};

// GraphQL mutation to associate variants with a given delivery (shipping) profile
const DELIVERY_PROFILE_UPDATE_MUTATION = `
  mutation deliveryProfileUpdate($id: ID!, $profile: DeliveryProfileInput!) {
    deliveryProfileUpdate(id: $id, profile: $profile) {
      profile {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const assignVariantsToShippingProfile = async ({
  shopDomain,
  accessToken,
  apiVersion,
  deliveryProfileGid,
  variantGids
}) => {
  if (!deliveryProfileGid || !Array.isArray(variantGids) || !variantGids.length) {
    return null;
  }

  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  const headers = {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json'
  };

  try {
    const resp = await axios.post(
      endpoint,
      {
        query: DELIVERY_PROFILE_UPDATE_MUTATION,
        variables: {
          id: deliveryProfileGid,
          profile: {
            variantsToAssociate: variantGids
          }
        }
      },
      { headers }
    );

    if (resp.data.errors) {
      const message = Array.isArray(resp.data.errors)
        ? resp.data.errors.map(e => e.message).join('; ')
        : 'Unknown GraphQL error';
      const error = new Error(message);
      error.status = 502;
      throw error;
    }

    const payload = resp.data?.data?.deliveryProfileUpdate;
    if (!payload) {
      const error = new Error('Invalid Shopify response for deliveryProfileUpdate');
      error.status = 502;
      throw error;
    }

    if (Array.isArray(payload.userErrors) && payload.userErrors.length > 0) {
      const message = payload.userErrors
        .map(e => `${e.field ? e.field.join('.') : 'error'}: ${e.message}`)
        .join('; ');
      const error = new Error(message);
      error.status = 400;
      throw error;
    }

    return payload.profile || null;
  } catch (err) {
    const status = err?.response?.status || 500;
    const message =
      (err?.response?.data && (err.response.data.errors || err.response.data.error)) ||
      err.message ||
      'Request failed';
    const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = status;
    throw error;
  }
};

// Query and mutation helpers to publish products to a sales channel (e.g., Online Store)
// NOTE: Keep this query minimal to stay compatible with older API versions.
const PUBLICATIONS_QUERY = `
{
  publications(first: 20) {
    edges {
      node {
        id
        name
      }
    }
  }
}
`;

const PUBLISHABLE_PUBLISH_MUTATION = `
  mutation publishProduct($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      publishable {
        ... on Product {
          id
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const fetchPrimaryPublication = async ({ shopDomain, accessToken, apiVersion }) => {
  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  const headers = {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json'
  };

  try {
    const resp = await axios.post(
      endpoint,
      {
        query: PUBLICATIONS_QUERY,
        variables: {}
      },
      { headers }
    );

    if (resp.data.errors) {
      const message = Array.isArray(resp.data.errors)
        ? resp.data.errors.map(e => e.message).join('; ')
        : 'Unknown GraphQL error';
      const error = new Error(message);
      error.status = 502;
      throw error;
    }

    const edges = resp.data?.data?.publications?.edges || [];
    if (!edges.length) return null;

    // Prefer a publication whose name mentions "online store" (case-insensitive), otherwise first
    const onlineStorePub = edges.find(
      e =>
        e?.node?.name &&
        typeof e.node.name === 'string' &&
        e.node.name.toLowerCase().includes('online store')
    );

    const chosen = onlineStorePub || edges[0];
    return chosen.node.id;
  } catch (err) {
    const status = err?.response?.status || 500;
    const message =
      (err?.response?.data && (err.response.data.errors || err.response.data.error)) ||
      err.message ||
      'Request failed';
    const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = status;
    throw error;
  }
};

const publishProductToPrimaryChannel = async ({ shopDomain, accessToken, apiVersion, productId }) => {
  if (!productId) return null;

  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  const headers = {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json'
  };

  const publicationId = await fetchPrimaryPublication({ shopDomain, accessToken, apiVersion });
  if (!publicationId) {
    const error = new Error('No active publications found to publish product');
    error.status = 400;
    throw error;
  }

  const variables = {
    id: productId,
    input: [
      {
        publicationId
        // publishDate: null // publish immediately
      }
    ]
  };

  try {
    const resp = await axios.post(
      endpoint,
      {
        query: PUBLISHABLE_PUBLISH_MUTATION,
        variables
      },
      { headers }
    );

    if (resp.data.errors) {
      const message = Array.isArray(resp.data.errors)
        ? resp.data.errors.map(e => e.message).join('; ')
        : 'Unknown GraphQL error';
      const error = new Error(message);
      error.status = 502;
      throw error;
    }

    const payload = resp.data?.data?.publishablePublish;
    if (!payload) {
      const error = new Error('Invalid Shopify response for publishablePublish');
      error.status = 502;
      throw error;
    }

    if (Array.isArray(payload.userErrors) && payload.userErrors.length > 0) {
      const message = payload.userErrors
        .map(e => `${e.field ? e.field.join('.') : 'error'}: ${e.message}`)
        .join('; ');
      const error = new Error(message);
      error.status = 400;
      throw error;
    }

    return payload.publishable;
  } catch (err) {
    const status = err?.response?.status || 500;
    const message =
      (err?.response?.data && (err.response.data.errors || err.response.data.error)) ||
      err.message ||
      'Request failed';
    const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = status;
    throw error;
  }
};

// Mutation to activate (stock) an inventory item at a location
const INVENTORY_ACTIVATE_MUTATION = `
  mutation inventoryActivate($inventoryItemId: ID!, $locationId: ID!) {
    inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
      inventoryLevel {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const ensureInventoryItemStockedAtLocation = async ({ shopDomain, accessToken, apiVersion, inventoryItemId, locationId }) => {
  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  const headers = {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json'
  };

  const variables = {
    inventoryItemId,
    locationId
  };

  try {
    const resp = await axios.post(
      endpoint,
      {
        query: INVENTORY_ACTIVATE_MUTATION,
        variables
      },
      { headers }
    );

    if (resp.data.errors) {
      const message = Array.isArray(resp.data.errors)
        ? resp.data.errors.map(e => e.message).join('; ')
        : 'Unknown GraphQL error';
      const error = new Error(message);
      error.status = 502;
      throw error;
    }

    const payload = resp.data?.data?.inventoryActivate;
    if (!payload) {
      const error = new Error('Invalid Shopify response for inventoryActivate');
      error.status = 502;
      throw error;
    }

    if (Array.isArray(payload.userErrors) && payload.userErrors.length > 0) {
      const message = payload.userErrors
        .map(e => `${e.field ? e.field.join('.') : 'error'}: ${e.message}`)
        .join('; ');
      const error = new Error(message);
      error.status = 400;
      throw error;
    }

    return payload.inventoryLevel;
  } catch (err) {
    const status = err?.response?.status || 500;
    const message =
      (err?.response?.data && (err.response.data.errors || err.response.data.error)) ||
      err.message ||
      'Request failed';
    const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = status;
    throw error;
  }
};

// Mutation to set inventory quantity using the newer InventorySetQuantities API
const INVENTORY_SET_QUANTITIES_MUTATION = `
  mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup {
        id
        createdAt
        changes {
          quantityAfterChange
          delta
          item {
            id
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const setInventoryQuantity = async ({ shopDomain, accessToken, apiVersion, inventoryItemId, locationId, quantity }) => {
  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  const headers = {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json'
  };

  const variables = {
    input: {
      name: 'available',
      reason: 'correction',
      ignoreCompareQuantity: true,
      quantities: [
        {
          inventoryItemId,
          locationId,
          quantity
        }
      ]
    }
  };

  try {
    const resp = await axios.post(
      endpoint,
      {
        query: INVENTORY_SET_QUANTITIES_MUTATION,
        variables
      },
      { headers }
    );

    if (resp.data.errors) {
      const message = Array.isArray(resp.data.errors)
        ? resp.data.errors.map(e => e.message).join('; ')
        : 'Unknown GraphQL error';
      const error = new Error(message);
      error.status = 502;
      throw error;
    }

    const adjustPayload = resp.data?.data?.inventorySetQuantities;
    if (!adjustPayload) {
      const error = new Error('Invalid Shopify response for inventorySetQuantities');
      error.status = 502;
      throw error;
    }

    if (Array.isArray(adjustPayload.userErrors) && adjustPayload.userErrors.length > 0) {
      const message = adjustPayload.userErrors
        .map(e => `${e.field ? e.field.join('.') : 'error'}: ${e.message}`)
        .join('; ');
      const error = new Error(message);
      error.status = 400;
      throw error;
    }

    return adjustPayload.inventoryAdjustmentGroup;
  } catch (err) {
    const status = err?.response?.status || 500;
    const message =
      (err?.response?.data && (err.response.data.errors || err.response.data.error)) ||
      err.message ||
      'Request failed';
    const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = status;
    throw error;
  }
};

// Mutation to create variants in bulk for a product (used here to set SKU/price)
// NOTE: With the new Product APIs, we replace the standalone default variant
// created by productCreate using strategy: REMOVE_STANDALONE_VARIANT.
const PRODUCT_VARIANTS_BULK_CREATE_MUTATION = `
  mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
      productVariants {
        id
        sku
        price
        inventoryItem {
          id
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const createOrReplaceVariantFromPayload = async ({ shopDomain, accessToken, apiVersion, productId, variants }) => {
  if (!productId) return null;

  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  const headers = {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json'
  };

  const variantInputs = [];
  if (Array.isArray(variants)) {
    for (const v of variants) {
      if (!v) continue;
      const { sku, price, optionValues } = v;
      const variantInput = {};

      if (price !== undefined && price !== null) {
        variantInput.price = String(price);
      }
      if (sku) {
        variantInput.inventoryItem = {
          sku: String(sku)
        };
      }
      if (Array.isArray(optionValues) && optionValues.length) {
        variantInput.optionValues = optionValues.map((ov) => ({
          optionName: ov.optionName,
          name: ov.name
        }));
      }

      // Skip empty entries
      if (
        !variantInput.price &&
        !variantInput.inventoryItem &&
        !variantInput.optionValues
      ) {
        continue;
      }

      variantInputs.push(variantInput);
    }
  }

  // Nothing to create
  if (!variantInputs.length) return null;

  const variables = {
    productId,
    strategy: 'REMOVE_STANDALONE_VARIANT',
    variants: variantInputs
  };

  try {
    const resp = await axios.post(
      endpoint,
      {
        query: PRODUCT_VARIANTS_BULK_CREATE_MUTATION,
        variables
      },
      { headers }
    );

    if (resp.data.errors) {
      const message = Array.isArray(resp.data.errors)
        ? resp.data.errors.map(e => e.message).join('; ')
        : 'Unknown GraphQL error';
      const error = new Error(message);
      error.status = 502;
      throw error;
    }

    const payload = resp.data?.data?.productVariantsBulkCreate;
    if (!payload) {
      const error = new Error('Invalid Shopify response for productVariantsBulkCreate');
      error.status = 502;
      throw error;
    }

    if (Array.isArray(payload.userErrors) && payload.userErrors.length > 0) {
      const message = payload.userErrors
        .map(e => `${e.field ? e.field.join('.') : 'error'}: ${e.message}`)
        .join('; ');
      const error = new Error(message);
      error.status = 400;
      throw error;
    }

    return payload.productVariants || [];
  } catch (err) {
    const status = err?.response?.status || 500;
    const message =
      (err?.response?.data && (err.response.data.errors || err.response.data.error)) ||
      err.message ||
      'Request failed';
    const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = status;
    throw error;
  }
};

const normalizeOrderId = (orderId) => {
  if (!orderId) return null;
  // If it's already a GID, return as-is
  if (orderId.startsWith('gid://shopify/Order/')) {
    return orderId;
  }
  // If it's a numeric ID, convert to GID
  if (/^\d+$/.test(orderId)) {
    return `gid://shopify/Order/${orderId}`;
  }
  // Otherwise assume it's already in the correct format
  return orderId;
};

// const buildOrdersQuery = (startDate, endDate, first = 10, after = null) => {
//   const normalizeDateTime = (value, isEnd) => {
//     if (!value) return null;
//     // If caller passed a full datetime, use as-is; else add day bounds in UTC
//     if (value.includes('T')) return value;
//     return `${value}T${isEnd ? '23:59:59' : '00:00:00'}Z`;
//   };
//   const isoStart = normalizeDateTime(startDate, false);
//   const isoEnd = normalizeDateTime(endDate, true);
//   const searchClauses = [];
//   if (isoStart) searchClauses.push(`created_at:>=${isoStart}`);
//   if (isoEnd) searchClauses.push(`created_at:<=${isoEnd}`);
//     searchClauses.push('status:open');

//   const queryFilter = searchClauses.length ? `, query: \"${searchClauses.join(' ')}\"` : '';

//   return `
// {
//   orders(first: ${first}${after ? `, after: \"${after}\"` : ''}${queryFilter}, sortKey: CREATED_AT, reverse: true) {
//     edges {
//       cursor
//       node {
//         id
//         name
//         createdAt
//         updatedAt
//         totalPriceSet {
//           shopMoney {
//             amount
//             currencyCode
//           }
//         }
//         subtotalPriceSet {
//           shopMoney {
//             amount
//             currencyCode
//           }
//         }
//         totalTaxSet {
//           shopMoney {
//             amount
//             currencyCode
//           }
//         }
//          totalShippingPriceSet {
//           shopMoney {
//             amount
//             currencyCode
//           }
//         }
//         currencyCode
//         displayFinancialStatus
//         displayFulfillmentStatus
//         customer { id 

//         }
//          shippingAddress {

//           city
//           province
//           country
//           company
//         }
//         shippingLine{
//             title
//             originalPrice{
//               amount
//             }

//         }
//         customer {
//           id
//           tags          
//         }
//           fulfillments {
//           id
//           status
//           createdAt
//           trackingInfo {
//             number
//             url
//             company
//           }
//         }
//         shippingLines(first: 10) {
//           edges {
//             node {
//               title
//               code
//               carrierIdentifier
//               originalPriceSet { shopMoney { amount currencyCode } }
//               discountedPriceSet { shopMoney { amount currencyCode } }
//               requestedFulfillmentService { id serviceName }
//             }
//           }
//         }
//         lineItems(first: 100) {
//           edges {
//             node {
//               id
//               title
//               quantity
//               originalUnitPriceSet {
//                 shopMoney {
//                   amount
//                   currencyCode
//                 }
//               }
//               variant {
//                 id
//                 title
//                 sku
//                 image {
//                   url
//                   altText
//                 }
//                 product {
//                   id
//                   title
//                    featuredImage {
//                     url
//                     altText
//                   }
//                 }
//               }
//             }
//           }
//         }
//       }
//     }
//     pageInfo {
//       hasNextPage
//       endCursor
//     }
//   }
// }
// `;
// };
const buildOrdersQuery = (startDate, endDate, first = 10, after = null) => {
  const normalizeDateTime = (value, isEnd) => {
    if (!value) return null;
    // If caller passed a full datetime, use as-is; else add day bounds in UTC
    if (value.includes('T')) return value;
    return `${value}T${isEnd ? '23:59:59' : '00:00:00'}Z`;
  };
  const isoStart = normalizeDateTime(startDate, false);
  const isoEnd = normalizeDateTime(endDate, true);
  const searchClauses = [];
  if (isoStart) searchClauses.push(`created_at:>=${isoStart}`);
  if (isoEnd) searchClauses.push(`created_at:<=${isoEnd}`);
  searchClauses.push('status:open');

  const queryFilter = searchClauses.length ? `, query: \"${searchClauses.join(' ')}\"` : '';

  return `
{
  orders(first: ${first}${after ? `, after: \"${after}\"` : ''}${queryFilter}, sortKey: CREATED_AT, reverse: true) {
    edges {
      cursor
      node {
        id
        name
        createdAt
        updatedAt
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        subtotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalTaxSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalShippingPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        currencyCode
        displayFinancialStatus
        displayFulfillmentStatus
        confirmed
        processedAt
        customerLocale
        
        # Customer Details
        customer { 
          id
          displayName
          createdAt
          updatedAt
          tags
          emailMarketingConsent {
            marketingState
            marketingOptInLevel
          }
          smsMarketingConsent {
            marketingState
            marketingOptInLevel
          }
          note
          metafields(first: 10) {
            edges {
              node {
                id
                key
                value
              }
            }
          }
          # Protected fields - remove if you get errors:
          firstName
          lastName
          email
          phone
          defaultAddress {
            address1
            address2
            city
            province
            provinceCode
            country
            countryCodeV2
            zip
            phone
            company
            name
            formatted
            formattedArea
          }
          addresses(first: 10) {
            address1
            address2
            city
            province
            provinceCode
            country
            countryCodeV2
            zip
            phone
            company
            name
            formatted
            formattedArea
          }
        }
        
        # Shipping Address Details
        shippingAddress {
          name
          formatted
          formattedArea
          company
          city
          province
          provinceCode
          country
          countryCodeV2
          latitude
          longitude
          # Protected fields - remove if you get errors:
          firstName
          lastName
          address1
          address2
          zip
          phone
        }
        
        # Billing Address
        billingAddress {
          name
          formatted
          formattedArea
          company
          city
          province
          provinceCode
          country
          countryCodeV2
          # Protected fields - remove if you get errors:
          firstName
          lastName
          address1
          address2
          zip
          phone
        }
        
        # Shipping Information
        shippingLine {
          title
          originalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          code
          carrierIdentifier
          requestedFulfillmentService {
            id
            serviceName
          }
          phone
          discountedPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          taxLines {
            priceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
        }
        
        # Fulfillment Details
        fulfillments {
          id
          status
          createdAt
          updatedAt
          deliveredAt
          estimatedDeliveryAt
          trackingInfo {
            number
            url
            company
          }
          fulfillmentLineItems(first: 10) {
            edges {
              node {
                lineItem {
                  id
                  title
                }
                quantity
              }
            }
          }
        }
        
        # Discount Information
        totalDiscountsSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        discountApplications(first: 5) {
          edges {
            node {
              allocationMethod
              targetSelection
              targetType
              value {
                ... on MoneyV2 {
                  amount
                  currencyCode
                }
                ... on PricingPercentageValue {
                  percentage
                }
              }
            }
          }
        }
        
        # Shipping Lines
        shippingLines(first: 10) {
          edges {
            node {
              title
              code
              carrierIdentifier
              originalPriceSet { 
                shopMoney { 
                  amount 
                  currencyCode 
                } 
              }
              discountedPriceSet { 
                shopMoney { 
                  amount 
                  currencyCode 
                } 
              }
              requestedFulfillmentService { 
                id 
                serviceName 
              }
              taxLines {
                priceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
        
        # Line Items with enhanced details and inventory locations
        lineItems(first: 100) {
          edges {
            node {
              id
              title
              sku
              quantity
              originalTotalSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              originalUnitPriceSet { 
                shopMoney { 
                  amount 
                  currencyCode 
                } 
              }
              discountedTotalSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              discountedUnitPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              variant {
                id
                title
                sku
                inventoryQuantity
                image { 
                  url 
                  altText 
                }
                product { 
                  id 
                  title 
                  handle
                  productType
                  vendor
                  featuredImage { 
                    url 
                    altText 
                  }
                }
                # Inventory locations for this variant
                inventoryItem {
                  id
                  inventoryLevels(first: 10) {
                    edges {
                      node {
                        location {
                          id
                          name
                          address {
                            address1
                            address2
                            city
                            province
                            country
                            zip
                          }
                        }
                      }
                    }
                  }
                }
              }
              taxLines {
                priceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
              }
              discountAllocations {
                allocatedAmountSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
        
        # Order Notes and Attributes
        note
        
        # Metadata
        metafields(first: 10) {
          edges {
            node {
              id
              key
              value
            }
          }
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;
};

// const buildOrdersQuery = (startDate, endDate, first = 10, after = null) => {
//   const normalizeDateTime = (value, isEnd) => {
//     if (!value) return null;
//     // If caller passed a full datetime, use as-is; else add day bounds in UTC
//     if (value.includes('T')) return value;
//     return `${value}T${isEnd ? '23:59:59' : '00:00:00'}Z`;
//   };
//   const isoStart = normalizeDateTime(startDate, false);
//   const isoEnd = normalizeDateTime(endDate, true);
//   const searchClauses = [];
//   if (isoStart) searchClauses.push(`created_at:>=${isoStart}`);
//   if (isoEnd) searchClauses.push(`created_at:<=${isoEnd}`);
//   const queryFilter = searchClauses.length ? `, query: \"${searchClauses.join(' ')}\"` : '';

//   return `
// {
//   orders(first: ${first}${after ? `, after: \"${after}\"` : ''}${queryFilter}, sortKey: CREATED_AT, reverse: true) {
//     edges {
//       cursor
//       node {
//         id
//         name
//         createdAt
//         updatedAt
//         totalPriceSet {
//           shopMoney {
//             amount
//             currencyCode
//           }
//         }
//         subtotalPriceSet {
//           shopMoney {
//             amount
//             currencyCode
//           }
//         }
//         totalTaxSet {
//           shopMoney {
//             amount
//             currencyCode
//           }
//         }
//         totalShippingPriceSet {
//           shopMoney {
//             amount
//             currencyCode
//           }
//         }
//         currencyCode
//         displayFinancialStatus
//         displayFulfillmentStatus
//         customer { id }
//         shippingAddress {
//           name
//           company
//           city
//           province
//           country
//           countryCodeV2
//           formattedArea
//           formatted
//         }
//         shippingLine {
//           title
//           originalPriceSet {
//             shopMoney {
//               amount
//               currencyCode
//             }
//           }
//           code
//           carrierIdentifier
//           discountAllocations {
//             allocatedAmountSet {
//               shopMoney {
//                 amount
//                 currencyCode
//               }
//             }
//           }
//         }
//         fulfillments {
//           id
//           status
//           createdAt
//           updatedAt
//           trackingInfo {
//             company
//             number
//             url
//           }
//           estimatedDeliveryAt
//         }
//         fulfillmentOrders(first: 5) {
//           edges {
//             node {
//               id
//               status
//               fulfillAt
//               fulfillBy
//               assignedLocation {
//                 name
//                 location {
//                   name
//                   address {
//                     address1
//                     address2
//                     city
//                     provinceCode
//                     countryCode
//                     zip
//                   }
//                 }
//               }
//             }
//           }
//         }
//         lineItems(first: 100) {
//           edges {
//             node {
//               id
//               title
//               quantity
//               originalUnitPriceSet {
//                 shopMoney {
//                   amount
//                   currencyCode
//                 }
//               }
//               variant {
//                 id
//                 title
//                 sku
//                 image {
//                   url
//                   altText
//                 }
//                 product {
//                   id
//                   title
//                    featuredImage {
//                     url
//                     altText
//                   }
//                 }
//               }
//             }
//           }
//         }
//       }
//     }
//     pageInfo {
//       hasNextPage
//       endCursor
//     }
//   }
// }
// `;
// };
const fetchAllOrders = async ({ shopDomain, accessToken, apiVersion, query: overrideQuery, startDate, endDate }) => {
  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  console.log("endpoint=========>>>>>>", endpoint);

  const headers = {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json',
    // 'Accept': 'application/json'
  };
  console.log("headers=====>>>>", headers);

  const query = overrideQuery || buildOrdersQuery(startDate, endDate);
  console.log("query================", query);
  const variables = {};
  let resp;
  try {
    resp = await axios.post(endpoint, { query, variables }, { headers });
  } catch (err) {
    console.log("err=========>>>>>>>>>>>>>>>>", err?.response?.status, err?.response?.data || err?.message);
    const status = err?.response?.status || 500;
    const message = (err?.response?.data && (err.response.data.errors || err.response.data.error)) || err.message || 'Request failed';
    const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = status;
    throw error;
  }
  console.log("resp=========>>>>>>>>>>>>>>>>", resp)
  if (resp.data.errors) {
    const message = Array.isArray(resp.data.errors) ? resp.data.errors.map(e => e.message).join('; ') : 'Unknown GraphQL error';
    const error = new Error(message);
    error.status = 502;
    throw error;
  }
  const payload = resp.data.data && resp.data.data.orders ? resp.data.data.orders : null;
  if (!payload) return [];
  const orders = [];
  const pageEdges = payload.edges || [];
  for (const edge of pageEdges) {
    if (edge && edge.node) orders.push(edge.node);
  }
  return orders;
};

const getShopifyOrders = async (req, res) => {
  try {
    let accessToken = req.body?.access_token || req.headers['x-shopify-access-token'];
    const authHeader = req.headers?.authorization || req.headers?.Authorization;
    const startDate = req.body?.startDate || req.body?.start_date || req.query?.startDate || req.query?.start_date;
    const endDate = req.body?.endDate || req.body?.end_date || req.query?.endDate || req.query?.end_date;

    if (!accessToken && authHeader && authHeader.startsWith('Bearer ')) {
      accessToken = authHeader.slice(7).trim();
    }
    const storeName = req.body?.storeName || req.body?.shop || req.body?.store || req.query?.storeName || req.query?.shop;
    const apiVersion = process.env.SHOPIFY_API_VERSION || '2025-10';

    if (!accessToken || !storeName) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters: accessToken and storeName'
      });
    }

    const shopDomain = normalizeShopDomain(storeName);
    console.log("shopDomain==============", shopDomain);
    if (!shopDomain || !shopDomain.match(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid storeName. Expected shopname or shopname.myshopify.com'
      });
    }
    var shippingOptions = await finerworksService.SHIPPING_OPTIONS_LIST();
    const query = req.body?.query; // optional override for custom queries
    let orders = await fetchAllOrders({ shopDomain, accessToken, apiVersion, query, startDate, endDate });

    // Filter orders to only those with at least one line item sourced from "Shop location"
    const TARGET_LOCATION_NAME = 'Shop location';
    orders = orders.filter(order => {
      const lineItemEdges = order?.lineItems?.edges || [];
      return lineItemEdges.some(liEdge => {
        const inventoryItem = liEdge?.node?.variant?.inventoryItem;
        const inventoryLevelEdges = inventoryItem?.inventoryLevels?.edges || [];
        return inventoryLevelEdges.some(levelEdge => levelEdge?.node?.location?.name === TARGET_LOCATION_NAME);
      });
    });

    orders.forEach(order => {
      order.shippingLines.edges.forEach(edge => {
        if (edge.node.title === 'Standard') {
          shippingOptions.shipping_options.forEach(option => {
            if (option.shipping_method === 'Standard - Parcel') {
              edge.node.code = option.id;
            }
          });
        }
        if (edge.node.title === 'Economy') {
          shippingOptions.shipping_options.forEach(option => {
            if (option.shipping_method === 'Economy') {
              edge.node.code = option.id;
            }
          });
        }
      });
    });
    return res.status(200).json({ success: true, count: orders.length, orders });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      success: false,
      message: 'Failed to retrieve Shopify orders',
      error: err.message || 'Unknown error'
    });
  }
};

// const buildOrderByNameQuery = (orderName) => {
//   const normalized = orderName && orderName.startsWith('#') ? orderName : `#${orderName}`;
//   return `
// {
//   orders(first: 1, query: \"name:${normalized}\") {
//     edges {
//       node {
//         id
//         name
//         createdAt
//         updatedAt
//         totalPriceSet { shopMoney { amount currencyCode } }
//         subtotalPriceSet { shopMoney { amount currencyCode } }
//         totalTaxSet { shopMoney { amount currencyCode } }
//         currencyCode
//         displayFinancialStatus
//         displayFulfillmentStatus
//         customer { id firstName lastName email }
//         lineItems(first: 100) {
//           edges {
//             node {
//               id
//               title
//               quantity
//               originalUnitPriceSet { shopMoney { amount currencyCode } }
//               variant {
//                 id
//                 title
//                 sku
//                 image { url altText }
//                 product { id title featuredImage { url altText } }
//               }
//             }
//           }
//         }
//       }
//     }
//   }
// }
// `;
// };


// const buildOrderByNameQuery = (orderName) => {
//   const normalized = orderName && orderName.startsWith('#') ? orderName : `#${orderName}`;
//   return `
// {
//   orders(first: 1, query: "name:${normalized}") {
//     edges {
//       node {
//         id
//         name
//         createdAt
//         updatedAt
//         totalPriceSet { 
//           shopMoney { 
//             amount 
//             currencyCode 
//           } 
//         }
//         subtotalPriceSet { 
//           shopMoney { 
//             amount 
//             currencyCode 
//           } 
//         }
//         totalTaxSet { 
//           shopMoney { 
//             amount 
//             currencyCode 
//           } 
//         }
//         totalShippingPriceSet { 
//           shopMoney { 
//             amount 
//             currencyCode 
//           } 
//         }
//         currencyCode
//         displayFinancialStatus
//         displayFulfillmentStatus
//         customer { 
//           id
//           tags
//           firstName
//           addresses{
//             address1
//             address2
//           }
//         }
//         shippingAddress {
//           city
//           province
//           country
//           company
//         }
//         fulfillments {
//           id
//           status
//           createdAt
//           trackingInfo {
//             number
//             url
//             company
//           }
//         }
//         shippingLines(first: 10) {
//           edges {
//             node {
//               title
//               code
//               carrierIdentifier
//               originalPriceSet { shopMoney { amount currencyCode } }
//               discountedPriceSet { shopMoney { amount currencyCode } }
//               requestedFulfillmentService { id serviceName }
//             }
//           }
//         }
//         lineItems(first: 100) {
//           edges {
//             node {
//               id
//               title
//               sku
//               quantity
//               originalUnitPriceSet { 
//                 shopMoney { 
//                   amount 
//                   currencyCode 
//                 } 
//               }
//               variant {
//                 id
//                 title
//                 sku
//                 image { 
//                   url 
//                   altText 
//                 }
//                 product { 
//                   id 
//                   title 
//                   featuredImage { 
//                     url 
//                     altText 
//                   } 
//                 }
//               }
//             }
//           }
//         }
//       }
//     }
//   }
// }
// `;
// };
// const buildOrderByNameQuery = (orderName) => {
//   const normalized = orderName && orderName.startsWith('#') ? orderName : `#${orderName}`;
//   return `
// {
//   orders(first: 1, query: "name:${normalized}") {
//     edges {
//       node {
//         id
//         name
//         createdAt
//         updatedAt
//         totalPriceSet { 
//           shopMoney { 
//             amount 
//             currencyCode 
//           } 
//         }
//         subtotalPriceSet { 
//           shopMoney { 
//             amount 
//             currencyCode 
//           } 
//         }
//         totalTaxSet { 
//           shopMoney { 
//             amount 
//             currencyCode 
//           } 
//         }
//         totalShippingPriceSet { 
//           shopMoney { 
//             amount 
//             currencyCode 
//           } 
//         }
//         currencyCode
//         displayFinancialStatus
//         displayFulfillmentStatus

//         # Customer Details
//         customer { 
//           id
//           displayName
//           createdAt
//           updatedAt
//           tags
//           emailMarketingConsent {
//             marketingState
//             marketingOptInLevel
//           }
//           smsMarketingConsent {
//             marketingState
//             marketingOptInLevel
//           }
//           note
//           # Protected fields - remove if you get errors:
//           firstName
//           lastName
//           email
//           phone
//           defaultAddress {
//             address1
//             address2
//             city
//             province
//             country
//             zip
//             phone
//             company
//           }
//           addresses {
//             address1
//             address2
//             city
//             province
//             country
//             zip
//             phone
//             company
//             name
//           }
//         }

//         # Shipping Address Details
//         shippingAddress {
//           name
//           formatted
//           formattedArea
//           company
//           city
//           province
//           provinceCode
//           country
//           countryCodeV2
//           # Protected fields - remove if you get errors:
//           firstName
//           lastName
//           address1
//           address2
//           zip
//           phone
//         }

//         # Billing Address
//         billingAddress {
//           name
//           formatted
//           formattedArea
//           company
//           city
//           province
//           country
//           # Protected fields - remove if you get errors:
//           firstName
//           lastName
//           address1
//           address2
//           zip
//           phone
//         }

//         fulfillments {
//           id
//           status
//           createdAt
//           updatedAt
//           trackingInfo {
//             number
//             url
//             company
//           }
//           estimatedDeliveryAt
//         }

//         shippingLines(first: 10) {
//           edges {
//             node {
//               title
//               code
//               carrierIdentifier
//               originalPriceSet { 
//                 shopMoney { 
//                   amount 
//                   currencyCode 
//                 } 
//               }
//               discountedPriceSet { 
//                 shopMoney { 
//                   amount 
//                   currencyCode 
//                 } 
//               }
//               requestedFulfillmentService { 
//                 id 
//                 serviceName 
//               }
//             }
//           }
//         }

//         lineItems(first: 100) {
//           edges {
//             node {
//               id
//               title
//               sku
//               quantity
//               originalUnitPriceSet { 
//                 shopMoney { 
//                   amount 
//                   currencyCode 
//                 } 
//               }
//               variant {
//                 id
//                 title
//                 sku
//                 image { 
//                   url 
//                   altText 
//                 }
//                 product { 
//                   id 
//                   title 
//                   featuredImage { 
//                     url 
//                     altText 
//                   } 
//                 }
//               }
//             }
//           }
//         }
//       }
//     }
//   }
// }
// `;
// };

const buildOrderByNameQuery = (orderName) => {
  const normalized = orderName && orderName.startsWith('#') ? orderName : `#${orderName}`;
  return `
{
  orders(first: 1, query: "name:${normalized}") {
    edges {
      node {
        id
        name
        createdAt
        updatedAt
        totalPriceSet { 
          shopMoney { 
            amount 
            currencyCode 
          } 
        }
        subtotalPriceSet { 
          shopMoney { 
            amount 
            currencyCode 
          } 
        }
        totalTaxSet { 
          shopMoney { 
            amount 
            currencyCode 
          } 
        }
        totalShippingPriceSet { 
          shopMoney { 
            amount 
            currencyCode 
          } 
        }
        currencyCode
        displayFinancialStatus
        displayFulfillmentStatus
        confirmed
        processedAt
        customerLocale
        
        # Customer Details
        customer { 
          id
          displayName
          createdAt
          updatedAt
          tags
          emailMarketingConsent {
            marketingState
            marketingOptInLevel
          }
          smsMarketingConsent {
            marketingState
            marketingOptInLevel
          }
          note
          metafields(first: 10) {
            edges {
              node {
                id
                key
                value
              }
            }
          }
          # Protected fields - remove if you get errors:
          firstName
          lastName
          email
          phone
          defaultAddress {
            address1
            address2
            city
            province
            provinceCode
            country
            countryCodeV2
            zip
            phone
            company
            name
            formatted
            formattedArea
          }
          addresses(first: 10) {
            address1
            address2
            city
            province
            provinceCode
            country
            countryCodeV2
            zip
            phone
            company
            name
            formatted
            formattedArea
          }
        }
        
        # Shipping Address Details
        shippingAddress {
          name
          formatted
          formattedArea
          company
          city
          province
          provinceCode
          country
          countryCodeV2
          latitude
          longitude
          # Protected fields - remove if you get errors:
          firstName
          lastName
          address1
          address2
          zip
          phone
        }
        
        # Billing Address
        billingAddress {
          name
          formatted
          formattedArea
          company
          city
          province
          provinceCode
          country
          countryCodeV2
          # Protected fields - remove if you get errors:
          firstName
          lastName
          address1
          address2
          zip
          phone
        }
        
        # Shipping Information
        shippingLine {
          title
          originalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          code
          carrierIdentifier
          requestedFulfillmentService {
            id
            serviceName
          }
          phone
          discountedPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          taxLines {
            priceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
        }
        
        # Fulfillment Details
        fulfillments {
          id
          status
          createdAt
          updatedAt
          deliveredAt
          estimatedDeliveryAt
          trackingInfo {
            number
            url
            company
          }
          fulfillmentLineItems(first: 10) {
            edges {
              node {
                lineItem {
                  id
                  title
                }
                quantity
              }
            }
          }
        }
      
        
        # Discount Information
        totalDiscountsSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        discountApplications(first: 5) {
          edges {
            node {
              allocationMethod
              targetSelection
              targetType
              value {
                ... on MoneyV2 {
                  amount
                  currencyCode
                }
                ... on PricingPercentageValue {
                  percentage
                }
              }
            }
          }
        }
        
        # Shipping Lines
        shippingLines(first: 10) {
          edges {
            node {
              title
              code
              carrierIdentifier
              originalPriceSet { 
                shopMoney { 
                  amount 
                  currencyCode 
                } 
              }
              discountedPriceSet { 
                shopMoney { 
                  amount 
                  currencyCode 
                } 
              }
              requestedFulfillmentService { 
                id 
                serviceName 
              }
              taxLines {
                priceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
        
        # Line Items with enhanced details
        lineItems(first: 100) {
          edges {
            node {
              id
              title
              sku
              quantity
              originalTotalSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              originalUnitPriceSet { 
                shopMoney { 
                  amount 
                  currencyCode 
                } 
              }
              discountedTotalSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              discountedUnitPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              variant {
                id
                title
                sku
                inventoryQuantity
                image { 
                  url 
                  altText 
                }
                product { 
                  id 
                  title 
                  handle
                  productType
                  vendor
                  featuredImage { 
                    url 
                    altText 
                  }
                }
              }
              taxLines {
                priceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
              }
              discountAllocations {
                allocatedAmountSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
        
        # Order Notes and Attributes
        note
        
        # Metadata
        metafields(first: 10) {
          edges {
            node {
              id
              key
              value
            }
          }
        }
      }
    }
  }
}
`;
};
const fetchOrderByName = async ({ shopDomain, accessToken, apiVersion, orderName }) => {
  console.log("orderName====>>>>", orderName);
  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  const headers = {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json'
  };
  const query = buildOrderByNameQuery(orderName);
  let resp;
  try {
    resp = await axios.post(endpoint, { query, variables: {} }, { headers });
    console.log("resp==========", resp.data);
    var shippingOptions = await finerworksService.SHIPPING_OPTIONS_LIST();
    console.log("shippingOptions=====>>>>", shippingOptions);

  } catch (err) {
    const status = err?.response?.status || 500;
    const message = (err?.response?.data && (err.response.data.errors || err.response.data.error)) || err.message || 'Request failed';
    const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = status;
    throw error;
  }
  if (resp.data.errors) {
    const message = Array.isArray(resp.data.errors) ? resp.data.errors.map(e => e.message).join('; ') : 'Unknown GraphQL error';
    const error = new Error(message);
    error.status = 502;
    throw error;
  }
  const edges = resp?.data?.data?.orders?.edges || [];
  const node = edges.length > 0 ? edges[0].node : null;
  console.log("node=====", node.shippingLines);
  node.shippingLines.edges.forEach(edge => {
    console.log("edge=====", edge.node.title);
    if (edge.node.title === 'Standard') {
      shippingOptions.shipping_options.forEach(option => {
        if (option.shipping_method === 'Standard - Parcel') {
          edge.node.code = option.id;
        }
      });
    } else if (edge.node.title === 'Economy') {
      shippingOptions.shipping_options.forEach(option => {
        if (option.shipping_method === 'Economy') {
          edge.node.code = option.id;
        }
      });
    }
  });

  return node;
};

const getShopifyOrderByName = async (req, res) => {
  try {
    let accessToken = req.body?.access_token || req.headers['x-shopify-access-token'];
    const authHeader = req.headers?.authorization || req.headers?.Authorization;
    if (!accessToken && authHeader && authHeader.startsWith('Bearer ')) {
      accessToken = authHeader.slice(7).trim();
    }
    const storeName = req.body?.storeName || req.body?.shop || req.body?.store || req.query?.storeName || req.query?.shop;
    const orderName = req.body?.orderName || req.body?.name || req.query?.orderName || req.query?.name;
    const apiVersion = process.env.SHOPIFY_API_VERSION || '2025-10';

    if (!accessToken || !storeName || !orderName) {
      return res.status(400).json({ success: false, message: 'Missing required parameters: accessToken, storeName, orderName' });
    }
    const shopDomain = normalizeShopDomain(storeName);
    if (!shopDomain || !shopDomain.match(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/)) {
      return res.status(400).json({ success: false, message: 'Invalid storeName. Expected shopname or shopname.myshopify.com' });
    }

    const order = await fetchOrderByName({ shopDomain, accessToken, apiVersion, orderName });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    return res.status(200).json({ success: true, order });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ success: false, message: 'Failed to retrieve order by name', error: err.message || 'Unknown error' });
  }
};

const buildFulfillmentMutation = (fulfillmentOrderId, lineItems, trackingInfo) => {
  // Build line items for fulfillment
  const fulfillmentLineItems = lineItems && lineItems.length > 0
    ? lineItems.map(item => ({
      id: item.lineItemId,
      quantity: item.quantity || null
    }))
    : null;

  // Build tracking info if provided
  const trackingInput = trackingInfo ? {
    number: trackingInfo.number || null,
    url: trackingInfo.url || null,
    company: trackingInfo.company || null
  } : null;

  // If line items are specified, use them; otherwise fulfill all
  let lineItemsInput;
  if (fulfillmentLineItems && fulfillmentLineItems.length > 0) {
    const lineItemsStr = fulfillmentLineItems.map(item => {
      const quantityStr = item.quantity !== null && item.quantity !== undefined
        ? item.quantity.toString()
        : 'null';
      return `{ id: "${item.id}", quantity: ${quantityStr} }`;
    }).join(', ');

    lineItemsInput = `lineItemsByFulfillmentOrder: [{
        fulfillmentOrderId: "${fulfillmentOrderId}",
        fulfillmentOrderLineItems: [${lineItemsStr}]
      }]`;
  } else {
    lineItemsInput = `lineItemsByFulfillmentOrder: [{
        fulfillmentOrderId: "${fulfillmentOrderId}"
      }]`;
  }

  let trackingInputStr = '';
  if (trackingInput) {
    const trackingParts = [];
    if (trackingInput.number) trackingParts.push(`number: "${trackingInput.number}"`);
    if (trackingInput.url) trackingParts.push(`url: "${trackingInput.url}"`);
    if (trackingInput.company) trackingParts.push(`company: "${trackingInput.company}"`);

    if (trackingParts.length > 0) {
      trackingInputStr = `, trackingInfo: { ${trackingParts.join(', ')} }`;
    }
  }

  return `
    mutation {
      fulfillmentCreateV2(
        fulfillment: {
          ${lineItemsInput}
          ${trackingInputStr}
          notifyCustomer: true
        }
      ) {
        fulfillment {
          id
          status
          createdAt
          trackingInfo {
            number
            url
            company
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
};

const getFulfillmentOrdersQuery = (orderId) => {
  return `
    {
      order(id: "${orderId}") {
        id
        name
        fulfillmentOrders(first: 10) {
          edges {
            node {
              id
              status
              requestStatus
              lineItems(first: 100) {
                edges {
                  node {
                    id
                    remainingQuantity
                    lineItem {
                      id
                      title
                      sku
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
};

const fetchFulfillmentOrders = async ({ shopDomain, accessToken, apiVersion, orderId }) => {
  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  const headers = {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json'
  };
  const query = getFulfillmentOrdersQuery(orderId);

  try {
    const resp = await axios.post(endpoint, { query, variables: {} }, { headers });

    if (resp.data.errors) {
      const message = Array.isArray(resp.data.errors)
        ? resp.data.errors.map(e => e.message).join('; ')
        : 'Unknown GraphQL error';
      const error = new Error(message);
      error.status = 502;
      throw error;
    }

    return resp.data.data?.order;
  } catch (err) {
    const status = err?.response?.status || err.status || 500;
    const message = (err?.response?.data && (err.response.data.errors || err.response.data.error))
      || err.message || 'Request failed';
    const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = status;
    throw error;
  }
};

const createFulfillment = async ({ shopDomain, accessToken, apiVersion, fulfillmentOrderId, lineItems, trackingInfo }) => {
  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  const headers = {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json'
  };

  const mutation = buildFulfillmentMutation(fulfillmentOrderId, lineItems, trackingInfo);

  try {
    const resp = await axios.post(endpoint, { query: mutation, variables: {} }, { headers });

    if (resp.data.errors) {
      const message = Array.isArray(resp.data.errors)
        ? resp.data.errors.map(e => e.message).join('; ')
        : 'Unknown GraphQL error';
      const error = new Error(message);
      error.status = 502;
      throw error;
    }

    const fulfillmentData = resp.data.data?.fulfillmentCreateV2;

    if (fulfillmentData?.userErrors && fulfillmentData.userErrors.length > 0) {
      const errorMessages = fulfillmentData.userErrors.map(e => `${e.field}: ${e.message}`).join('; ');
      const error = new Error(errorMessages);
      error.status = 400;
      throw error;
    }

    return fulfillmentData?.fulfillment;
  } catch (err) {
    const status = err?.response?.status || err.status || 500;
    const message = (err?.response?.data && (err.response.data.errors || err.response.data.error))
      || err.message || 'Request failed';
    const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = status;
    throw error;
  }
};

// Helper function to process a single order fulfillment
const processSingleOrderFulfillment = async ({ orderData, shopDomain, accessToken, apiVersion }) => {
  const orderId = orderData?.orderId || orderData?.order_id || orderData?.id;
  const orderName = orderData?.orderName || orderData?.order_name || orderData?.name;
  const lineItems = orderData?.lineItems || orderData?.line_items;
  const trackingInfo = orderData?.trackingInfo || orderData?.tracking_info;

  if (!orderId && !orderName) {
    throw new Error('Missing required parameter: orderId or orderName');
  }

  let shopifyOrderId = orderId;

  // If orderName is provided instead of orderId, fetch the order first
  if (orderName && !orderId) {
    const order = await fetchOrderByName({ shopDomain, accessToken, apiVersion, orderName });
    if (!order) {
      throw new Error('Order not found');
    }
    shopifyOrderId = order.id;
  }

  // Normalize order ID to GID format
  shopifyOrderId = normalizeOrderId(shopifyOrderId);

  // Get fulfillment orders for the order
  const orderFulfillmentData = await fetchFulfillmentOrders({
    shopDomain,
    accessToken,
    apiVersion,
    orderId: shopifyOrderId
  });

  if (!orderFulfillmentData || !orderFulfillmentData.fulfillmentOrders || orderFulfillmentData.fulfillmentOrders.edges.length === 0) {
    throw new Error('No fulfillment orders found for this order');
  }

  // Get the first fulfillment order (or you could iterate through all)
  const fulfillmentOrder = orderFulfillmentData.fulfillmentOrders.edges[0].node;
  const fulfillmentOrderId = fulfillmentOrder.id;

  // Prepare line items - if not specified, fulfill all items with all remaining quantities
  let fulfillmentLineItems = null;
  if (lineItems && Array.isArray(lineItems) && lineItems.length > 0) {
    // Map provided line items to fulfillment order line items
    fulfillmentLineItems = lineItems.map(item => {
      // Find matching fulfillment order line item
      const fulfillmentLineItem = fulfillmentOrder.lineItems.edges.find(
        edge => edge.node.lineItem.id === item.lineItemId ||
          edge.node.lineItem.sku === item.sku
      );

      if (!fulfillmentLineItem) {
        throw new Error(`Line item not found: ${item.lineItemId || item.sku}`);
      }

      return {
        lineItemId: fulfillmentLineItem.node.id,
        quantity: item.quantity || fulfillmentLineItem.node.remainingQuantity
      };
    });
  } else {
    // If no line items specified, fulfill ALL items with ALL remaining quantities
    fulfillmentLineItems = fulfillmentOrder.lineItems.edges
      .filter(edge => edge.node.remainingQuantity > 0) // Only include items with remaining quantity
      .map(edge => ({
        lineItemId: edge.node.id,
        quantity: edge.node.remainingQuantity // Use full remaining quantity
      }));

    // Check if there are any items to fulfill
    if (fulfillmentLineItems.length === 0) {
      throw new Error('No items available to fulfill. All items may already be fulfilled.');
    }
  }

  // Create the fulfillment
  const fulfillment = await createFulfillment({
    shopDomain,
    accessToken,
    apiVersion,
    fulfillmentOrderId,
    lineItems: fulfillmentLineItems,
    trackingInfo
  });

  return {
    success: true,
    message: 'Order fulfilled successfully',
    fulfillment,
    order: {
      id: orderFulfillmentData.id,
      name: orderFulfillmentData.name
    }
  };
};

const fulfillShopifyOrder = async (req, res) => {
  try {
    let accessToken = req.body?.access_token || req.headers['x-shopify-access-token'];
    const authHeader = req.headers?.authorization || req.headers?.Authorization;

    if (!accessToken && authHeader && authHeader.startsWith('Bearer ')) {
      accessToken = authHeader.slice(7).trim();
    }

    // Detect if request body is an array or single object
    const isArrayRequest = Array.isArray(req.body);
    const ordersToProcess = isArrayRequest ? req.body : [req.body];

    const apiVersion = process.env.SHOPIFY_API_VERSION || '2025-10';

    // For single order requests, validate required parameters upfront
    if (!isArrayRequest) {
      const storeName = req.body?.storeName || req.body?.shop || req.body?.store || req.query?.storeName || req.query?.shop;

      if (!accessToken || !storeName) {
        return res.status(400).json({
          success: false,
          message: 'Missing required parameters: accessToken and storeName'
        });
      }

      const shopDomain = normalizeShopDomain(storeName);
      if (!shopDomain || !shopDomain.match(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid storeName. Expected shopname or shopname.myshopify.com'
        });
      }
    }

    // Process all orders
    const results = [];
    let hasErrors = false;

    for (let i = 0; i < ordersToProcess.length; i++) {
      const orderData = ordersToProcess[i];

      // For array requests, each order can have its own storeName and accessToken
      // If not provided, use the common ones from headers/query
      const orderAccessToken = orderData?.access_token || accessToken;
      const orderStoreName = orderData?.storeName || orderData?.shop || orderData?.store || req.query?.storeName || req.query?.shop;

      // Validate required parameters for this order
      if (!orderAccessToken) {
        results.push({
          success: false,
          error: 'Missing required parameter: accessToken',
          order: orderData?.orderName || orderData?.orderId || `Order at index ${i}`
        });
        hasErrors = true;
        continue;
      }

      if (!orderStoreName) {
        results.push({
          success: false,
          error: 'Missing required parameter: storeName',
          order: orderData?.orderName || orderData?.orderId || `Order at index ${i}`
        });
        hasErrors = true;
        continue;
      }

      const orderShopDomain = normalizeShopDomain(orderStoreName);

      if (!orderShopDomain || !orderShopDomain.match(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/)) {
        results.push({
          success: false,
          error: 'Invalid storeName for this order',
          order: orderData?.orderName || orderData?.orderId || `Order at index ${i}`
        });
        hasErrors = true;
        continue;
      }

      try {
        const result = await processSingleOrderFulfillment({
          orderData: {
            ...orderData,
            access_token: orderAccessToken
          },
          shopDomain: orderShopDomain,
          accessToken: orderAccessToken,
          apiVersion
        });
        results.push(result);
      } catch (err) {
        hasErrors = true;
        results.push({
          success: false,
          error: err.message || 'Unknown error',
          order: orderData?.orderName || orderData?.orderId || `Order at index ${i}`
        });
      }
    }

    // Return appropriate response format
    if (isArrayRequest) {
      // For array requests, always return array of results
      const statusCode = hasErrors ? (results.some(r => r.success) ? 207 : 400) : 200; // 207 Multi-Status if mixed results
      return res.status(statusCode).json({
        success: !hasErrors,
        message: hasErrors
          ? 'Some orders failed to fulfill'
          : 'All orders fulfilled successfully',
        results,
        total: ordersToProcess.length,
        succeeded: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length
      });
    } else {
      // For single order requests, maintain backward compatibility with original response format
      const result = results[0];
      if (result.success) {
        return res.status(200).json(result);
      } else {
        return res.status(400).json({
          success: false,
          message: 'Failed to fulfill order',
          error: result.error || 'Unknown error'
        });
      }
    }
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      success: false,
      message: 'Failed to fulfill order',
      error: err.message || 'Unknown error'
    });
  }
};

// Build GraphQL mutation for setting order metafield
const buildMetafieldSetMutation = (orderId, namespace, key, value) => {
  // Escape special characters in GraphQL string values
  const escapeGraphQLString = (str) => {
    return String(str)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  };

  return `
    mutation {
      metafieldsSet(metafields: [{
        ownerId: "${orderId}",
        namespace: "${escapeGraphQLString(namespace)}",
        key: "${escapeGraphQLString(key)}",
        value: "${escapeGraphQLString(value)}",
        type: "single_line_text_field"
      }]) {
        metafields {
          id
          namespace
          key
          value
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
};

// Build GraphQL mutation for adding a tag to an order
const buildOrderTagsAddMutation = (orderId, tag) => {
  const escapeGraphQLString = (str) => {
    return String(str)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  };

  const escapedTag = escapeGraphQLString(tag);

  return `
    mutation {
      tagsAdd(id: "${orderId}", tags: ["${escapedTag}"]) {
        node {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
};

// Build GraphQL mutation for removing tags from an order
const buildOrderTagsRemoveMutation = (orderId, tags) => {
  const escapeGraphQLString = (str) => {
    return String(str)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  };

  const escapedTags = tags.map(t => `"${escapeGraphQLString(t)}"`).join(', ');

  return `
    mutation {
      tagsRemove(id: "${orderId}", tags: [${escapedTags}]) {
        node {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
};

// Helper function to update a single order's metafield
const updateOrderMetafield = async ({ shopDomain, accessToken, apiVersion, orderId, referenceNumber, namespace = 'custom', key = 'reference_number' }) => {
  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  const headers = {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json'
  };

  // Normalize order ID to GID format
  const normalizedOrderId = normalizeOrderId(orderId);

  const mutation = buildMetafieldSetMutation(normalizedOrderId, namespace, key, referenceNumber);

  try {
    const resp = await axios.post(endpoint, { query: mutation, variables: {} }, { headers });

    if (resp.data.errors) {
      const message = Array.isArray(resp.data.errors)
        ? resp.data.errors.map(e => e.message).join('; ')
        : 'Unknown GraphQL error';
      const error = new Error(message);
      error.status = 502;
      throw error;
    }

    const metafieldData = resp.data.data?.metafieldsSet;

    if (metafieldData?.userErrors && metafieldData.userErrors.length > 0) {
      const errorMessages = metafieldData.userErrors.map(e => `${e.field}: ${e.message}`).join('; ');
      const error = new Error(errorMessages);
      error.status = 400;
      throw error;
    }

    return {
      success: true,
      orderId: normalizedOrderId,
      metafield: metafieldData?.metafields?.[0] || null
    };
  } catch (err) {
    const status = err?.response?.status || err.status || 500;
    const message = (err?.response?.data && (err.response.data.errors || err.response.data.error))
      || err.message || 'Request failed';
    const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = status;
    throw error;
  }
};

// Helper function to replace a single "status" tag on an order
// It first removes old status tags, then adds the new tag.
const updateOrderTags = async ({ shopDomain, accessToken, apiVersion, orderId, tag, removeTags = [] }) => {
  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  const headers = {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json'
  };

  const normalizedOrderId = normalizeOrderId(orderId);

  try {
    // 1) Remove old status tags if any
    if (removeTags && removeTags.length > 0) {
      const mutationRemove = buildOrderTagsRemoveMutation(normalizedOrderId, removeTags);
      const respRemove = await axios.post(endpoint, { query: mutationRemove, variables: {} }, { headers });

      if (respRemove.data.errors) {
        const message = Array.isArray(respRemove.data.errors)
          ? respRemove.data.errors.map(e => e.message).join('; ')
          : 'Unknown GraphQL error';
        const error = new Error(message);
        error.status = 502;
        throw error;
      }

      const removeData = respRemove.data.data?.tagsRemove;
      if (removeData?.userErrors && removeData.userErrors.length > 0) {
        const errorMessages = removeData.userErrors.map(e => `${e.field}: ${e.message}`).join('; ');
        const error = new Error(errorMessages);
        error.status = 400;
        throw error;
      }
    }

    // 2) Add the new tag
    const mutationAdd = buildOrderTagsAddMutation(normalizedOrderId, tag);
    const respAdd = await axios.post(endpoint, { query: mutationAdd, variables: {} }, { headers });

    if (respAdd.data.errors) {
      const message = Array.isArray(respAdd.data.errors)
        ? respAdd.data.errors.map(e => e.message).join('; ')
        : 'Unknown GraphQL error';
      const error = new Error(message);
      error.status = 502;
      throw error;
    }

    const tagsData = respAdd.data.data?.tagsAdd;
    if (tagsData?.userErrors && tagsData.userErrors.length > 0) {
      const errorMessages = tagsData.userErrors.map(e => `${e.field}: ${e.message}`).join('; ');
      const error = new Error(errorMessages);
      error.status = 400;
      throw error;
    }

    return {
      success: true,
      orderId: normalizedOrderId,
      tag,
      removed: removeTags
    };
  } catch (err) {
    const status = err?.response?.status || err.status || 500;
    const message = (err?.response?.data && (err.response.data.errors || err.response.data.error))
      || err.message || 'Request failed';
    const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = status;
    throw error;
  }
};

// Endpoint to update order metafields with reference numbers
const updateOrderReferenceNumbers = async (req, res) => {
  try {
    let accessToken = req.body?.access_token || req.headers['x-shopify-access-token'];
    const authHeader = req.headers?.authorization || req.headers?.Authorization;

    if (!accessToken && authHeader && authHeader.startsWith('Bearer ')) {
      accessToken = authHeader.slice(7).trim();
    }

    // Validate request body is an array
    if (!Array.isArray(req.body.orders)) {
      return res.status(400).json({
        success: false,
        message: 'Request body must contain an "orders" array'
      });
    }

    const orders = req.body.orders;
    const storeName = req.body?.storeName || req.body?.shop || req.body?.store || req.query?.storeName || req.query?.shop;
    const namespace = req.body?.namespace || 'custom';
    const metafieldKey = req.body?.metafieldKey || 'reference_number';
    const apiVersion = process.env.SHOPIFY_API_VERSION || '2025-10';

    if (!accessToken || !storeName) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters: accessToken and storeName'
      });
    }

    if (orders.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Orders array cannot be empty'
      });
    }

    const shopDomain = normalizeShopDomain(storeName);
    if (!shopDomain || !shopDomain.match(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid storeName. Expected shopname or shopname.myshopify.com'
      });
    }

    // Process all orders
    const results = [];
    let hasErrors = false;

    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      let orderId = order?.orderId || order?.order_id || order?.id;
      const orderName = order?.orderName || order?.order_name || order?.name;
      const referenceNumber = order?.referenceNumber || order?.reference_number || order?.reference;

      // Validate required fields for each order
      if (!orderId && !orderName) {
        results.push({
          success: false,
          error: 'Missing required parameter: orderId or orderName',
          orderIndex: i,
          order: `Order at index ${i}`
        });
        hasErrors = true;
        continue;
      }

      if (!referenceNumber) {
        results.push({
          success: false,
          error: 'Missing required parameter: referenceNumber',
          orderIndex: i,
          order: orderName || orderId || `Order at index ${i}`
        });
        hasErrors = true;
        continue;
      }

      // Allow per-order access token and store name override
      const orderAccessToken = order?.access_token || accessToken;
      const orderStoreName = order?.storeName || order?.shop || order?.store || storeName;
      const orderShopDomain = normalizeShopDomain(orderStoreName);

      if (!orderShopDomain || !orderShopDomain.match(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/)) {
        results.push({
          success: false,
          error: 'Invalid storeName for this order',
          orderIndex: i,
          order: orderName || orderId || `Order at index ${i}`
        });
        hasErrors = true;
        continue;
      }

      try {
        // If orderName is provided but not orderId, fetch the order first
        if (orderName && !orderId) {
          const fetchedOrder = await fetchOrderByName({
            shopDomain: orderShopDomain,
            accessToken: orderAccessToken,
            apiVersion,
            orderName
          });
          if (!fetchedOrder) {
            throw new Error('Order not found');
          }
          orderId = fetchedOrder.id;
        }

        const result = await updateOrderMetafield({
          shopDomain: orderShopDomain,
          accessToken: orderAccessToken,
          apiVersion,
          orderId,
          referenceNumber: String(referenceNumber),
          namespace: order?.namespace || namespace,
          key: order?.metafieldKey || order?.metafield_key || metafieldKey
        });

        results.push({
          ...result,
          orderIndex: i,
          order: orderName || orderId,
          referenceNumber: String(referenceNumber)
        });
      } catch (err) {
        hasErrors = true;
        results.push({
          success: false,
          error: err.message || 'Unknown error',
          orderIndex: i,
          order: orderName || orderId || `Order at index ${i}`,
          referenceNumber: referenceNumber ? String(referenceNumber) : null
        });
      }
    }

    // Return results
    const statusCode = hasErrors ? (results.some(r => r.success) ? 207 : 400) : 200; // 207 Multi-Status if mixed results
    return res.status(statusCode).json({
      success: !hasErrors,
      message: hasErrors
        ? 'Some orders failed to update'
        : 'All orders updated successfully',
      results,
      total: orders.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      success: false,
      message: 'Failed to update order reference numbers',
      error: err.message || 'Unknown error'
    });
  }
};

// Endpoint to update a single order's fulfillment status via metafield.
// Accepts: storeName, access_token, orderNumber/orderName, status
// Uses Shopify GraphQL Admin API under the hood to set a metafield on the Order.
const updateOrderFulfillmentStatus = async (req, res) => {
  try {
    let accessToken = req.body?.access_token || req.headers['x-shopify-access-token'];
    const authHeader = req.headers?.authorization || req.headers?.Authorization;

    if (!accessToken && authHeader && authHeader.startsWith('Bearer ')) {
      accessToken = authHeader.slice(7).trim();
    }

    const storeName =
      req.body?.storeName ||
      req.body?.shop ||
      req.body?.store ||
      req.query?.storeName ||
      req.query?.shop;

    const orderNumber =
      req.body?.orderNumber ||
      req.body?.orderName ||
      req.body?.name ||
      req.query?.orderNumber ||
      req.query?.orderName ||
      req.query?.name;

    // Allow status and access token via query params as well (for webhook-style usage)
    if (!accessToken) {
      accessToken = req.query?.access_token || req.query?.token;
    }
    const selectOrderId = {
      "order_ids": [
        orderNumber
      ],
      "account_key": req.query?.account_key
    }
    console.log("selectOrderId=================>>>>>>>>>>>", selectOrderId);
    const orderStatusData = await finerworksService.GET_ORDER_STATUS(
      selectOrderId
    );
    console.log("orderStatusData=================>>>>>>>>>>>", orderStatusData);

    const statusValue = req.body?.status || req.query?.status || orderStatusData.orders[0].order_status_label;
    console.log("statusValue========", statusValue);
    const namespace = req.body?.namespace || 'custom';
    const metafieldKey = req.body?.metafieldKey || 'fulfillment_status';
    const apiVersion = process.env.SHOPIFY_API_VERSION || '2025-10';

    // Map incoming status to the status we want to store/display
    const rawStatus = String(statusValue).trim();
    const rawStatusLower = rawStatus.toLowerCase();
    let effectiveStatus = rawStatus;

    // Custom mappings for metafield:
    // - "in progress"  -> "In progress"
    // - "shipped"      -> "Fulfilled"
    if (rawStatusLower === 'in progress' || rawStatusLower === 'in_progress') {
      effectiveStatus = 'In progress';
    } else if (rawStatusLower === 'shipped') {
      effectiveStatus = 'Fulfilled';
    }

    if (!accessToken || !storeName || !orderNumber || !statusValue) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters: accessToken, storeName, orderNumber, status'
      });
    }

    const shopDomain = normalizeShopDomain(storeName);
    if (!shopDomain || !shopDomain.match(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid storeName. Expected shopname or shopname.myshopify.com'
      });
    }

    // Fetch order by name/number to get the GID
    const order = await fetchOrderByName({
      shopDomain,
      accessToken,
      apiVersion,
      orderName: orderStatusData.orders[0].order_po.replace(/\D/g, '')
      // orderName: '1015'
    });
    console.log("order=======>>>>", order);

    if (!order || !order.id) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    const result = await updateOrderMetafield({
      shopDomain,
      accessToken,
      apiVersion,
      orderId: order.id,
      referenceNumber: String(effectiveStatus),
      namespace,
      key: metafieldKey
    });

    // Update Shopify order tags so they show in the orders listing dashboard.
    // Tag value rules:
    // - "in progress" -> "In progress"
    // - "shipped"     -> "shipped"
    // - everything else -> same as effectiveStatus
    let tagValue = effectiveStatus;
    if (rawStatusLower === 'shipped') {
      tagValue = 'shipped';
    }

    const statusTagsToRemove = [
      'In progress',
      'in progress',
      'In Progress',
      'shipped',
      'Fulfilled',
      'fulfilled'
    ].filter(t => t.toLowerCase() !== String(tagValue).toLowerCase());

    const tagUpdateResult = await updateOrderTags({
      shopDomain,
      accessToken,
      apiVersion,
      orderId: order.id,
      tag: String(tagValue),
      removeTags: statusTagsToRemove
    });

    // Optionally trigger a real Shopify fulfillment so that the native
    // fulfillment status in the Shopify admin UI/order list is updated.
    let fulfillmentResult = null;
    const statusStr = rawStatusLower;
    const shouldFulfill =
      statusStr === 'shipped' ||
      statusStr === 'fulfilled' ||
      statusStr === 'complete' ||
      statusStr === 'completed';

    if (shouldFulfill) {
      try {
        fulfillmentResult = await processSingleOrderFulfillment({
          orderData: {
            orderName: order.name || orderNumber
          },
          shopDomain,
          accessToken,
          apiVersion
        });
      } catch (fulfillErr) {
        // If there are no remaining items to fulfill, treat as non-fatal
        const msg = fulfillErr?.message || '';
        if (!msg.includes('No items available to fulfill')) {
          throw fulfillErr;
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Order fulfillment status updated successfully',
      orderId: result.orderId,
      status: String(effectiveStatus),
      metafield: result.metafield,
      tag: tagUpdateResult,
      fulfillment: fulfillmentResult
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      success: false,
      message: 'Failed to update order fulfillment status',
      error: err.message || 'Unknown error'
    });
  }
};

// Helper to build Shopify variant option values (e.g., Type, Media, Style) from
// the FinerWorks payload labels. This is used so that multiple variants on the
// same product are properly differentiated in Shopify.
const buildVariantOptionValuesFromLabels = (product) => {
  if (!product || !Array.isArray(product.labels)) return [];

  const allowedKeys = new Set(['type', 'media', 'style']);
  const optionValues = [];

  for (const label of product.labels) {
    if (!label || !label.key || !allowedKeys.has(label.key)) continue;
    if (!label.value) continue;

    const optionName =
      label.key.charAt(0).toUpperCase() + label.key.slice(1);

    optionValues.push({
      optionName,
      name: String(label.value)
    });
  }

  return optionValues;
};

// Endpoint to create/sync products in Shopify using GraphQL Admin API.
// Expects payload:
// {
//   "account_key": "...",          // currently unused here
//   "productsList": [ { ... } ],   // array of products (see example in request)
//   "storeName": "shop.myshopify.com",
//   "access_token": "shpat_..."
// }
const syncShopifyProducts = async (req, res) => {
  try {
    let accessToken = req.body?.access_token || req.headers['x-shopify-access-token'];
    const authHeader = req.headers?.authorization || req.headers?.Authorization;

    if (!accessToken && authHeader && authHeader.startsWith('Bearer ')) {
      accessToken = authHeader.slice(7).trim();
    }

    const storeName =
      req.body?.storeName ||
      req.body?.shop ||
      req.body?.store ||
      req.query?.storeName ||
      req.query?.shop;

    const rawProducts = Array.isArray(req.body?.productsList) ? req.body.productsList : [];
    const apiVersion = process.env.SHOPIFY_API_VERSION || '2025-10';

    if (!accessToken || !storeName) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters: accessToken and storeName'
      });
    }

    if (!rawProducts.length) {
      return res.status(400).json({
        success: false,
        message: 'productsList must be a non-empty array'
      });
    }

    const shopDomain = normalizeShopDomain(storeName);
    if (!shopDomain || !shopDomain.match(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid storeName. Expected shopname or shopname.myshopify.com'
      });
    }

    // Group products by image_guid to determine primary items and their variants.
    // - If multiple items share the same image_guid, they are considered variants.
    //   Among them, the one with primaryItem === true (when present) is the primary item,
    //   and the remaining items are attached under it as variants.
    // - If image_guid is unique or missing, the item is treated as an individual product.
    const products = [];
    const imageGuidMap = new Map();

    for (const item of rawProducts) {
      const guid = item && item.image_guid;
      if (!guid) {
        // No image_guid: treat as standalone product.
        products.push(item);
        continue;
      }

      if (!imageGuidMap.has(guid)) {
        imageGuidMap.set(guid, []);
      }
      imageGuidMap.get(guid).push(item);
    }

    for (const items of imageGuidMap.values()) {
      if (!Array.isArray(items) || !items.length) {
        continue;
      }

      if (items.length === 1) {
        // Only one product for this image_guid; treat as individual product.
        products.push(items[0]);
        continue;
      }

      // More than one product with the same image_guid -> variants.
      // Choose the primary item when marked, otherwise default to the first.
      let primary = items.find(p => p && p.primaryItem === true);
      if (!primary) {
        primary = items[0];
      }

      const variants = items.filter(p => p !== primary);
      if (variants.length) {
        primary.variants = variants;

        // Build Shopify product options from all items in this group so that
        // variants can be differentiated (e.g., by Type, Media, Style).
        const allItems = [primary, ...variants];

        const collectValues = (key) => {
          const values = [];
          for (const item of allItems) {
            if (!item || !Array.isArray(item.labels)) continue;
            for (const label of item.labels) {
              if (!label || !label.key || !label.value) continue;
              if (String(label.key).toLowerCase() !== String(key).toLowerCase()) {
                continue;
              }
              const val = String(label.value);
              if (!values.includes(val)) {
                values.push(val);
              }
            }
          }
          return values;
        };

        const typeValues = collectValues('type');
        const mediaValues = collectValues('media');
        const styleValues = collectValues('style');

        const productOptions = [];
        if (typeValues.length) {
          productOptions.push({
            name: 'Type',
            values: typeValues.map(v => ({ name: v }))
          });
        }
        if (mediaValues.length) {
          productOptions.push({
            name: 'Media',
            values: mediaValues.map(v => ({ name: v }))
          });
        }
        if (styleValues.length) {
          productOptions.push({
            name: 'Style',
            values: styleValues.map(v => ({ name: v }))
          });
        }

        if (productOptions.length) {
          primary.productOptions = productOptions;
        }
      }

      products.push(primary);
    }

    // Fetch primary location once for all inventory updates
    let primaryLocationId = null;
    try {
      primaryLocationId = await fetchPrimaryLocation({ shopDomain, accessToken, apiVersion });
    } catch (locErr) {
      return res.status(locErr.status || 500).json({
        success: false,
        message: 'Failed to fetch Shopify locations for inventory',
        error: locErr.message || 'Unknown error'
      });
    }

    if (!primaryLocationId) {
      return res.status(400).json({
        success: false,
        message: 'No Shopify locations found; cannot set inventory quantity'
      });
    }

    // Fetch the "FinerWorks Shipping" delivery profile once so we can associate created variants with it.
    let finerWorksShippingProfileGid = null;
    try {
      finerWorksShippingProfileGid = await fetchDeliveryProfileGidByName({
        shopDomain,
        accessToken,
        apiVersion,
        profileName: 'FinerWorks Shipping'
      });
      console.log("finerWorksShippingProfileGid========",finerWorksShippingProfileGid);
      if (!finerWorksShippingProfileGid) {
        console.warn(
          `Shopify shipping profile "FinerWorks Shipping" not found for shop ${shopDomain}; products will be created without a custom shipping profile.`
        );
      }
    } catch (profileErr) {
      // Do not block product creation if shipping profiles cannot be fetched; just log the issue.
      console.error(
        `Failed to fetch Shopify shipping profiles for shop ${shopDomain}:`,
        profileErr.message || profileErr
      );
    }

    const results = [];
    let hasErrors = false;

    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      try {
        const created = await createShopifyProduct({
          shopDomain,
          accessToken,
          apiVersion,
          product
        });

        const resultEntry = {
          success: true,
          index: i,
          sku: product?.sku || null,
          product_guid: product?.product_guid || null,
          shopifyProduct: created
        };

        // Ensure product is published to the primary sales channel (e.g., Online Store)
        try {
          const published = await publishProductToPrimaryChannel({
            shopDomain,
            accessToken,
            apiVersion,
            productId: created.id
          });
          resultEntry.published = published;
        } catch (publishErr) {
          hasErrors = true;
          resultEntry.publishError = publishErr.message || 'Unknown publish error';
        }

        // Build a list of source products for variants:
        // - The primary (grouped) item.
        // - Any additional variants attached via the `variants` array.
        const variantSourceProducts = [
          product,
          ...(Array.isArray(product?.variants) ? product.variants : [])
        ];

        // Create/replace Shopify variants for each source product in a single bulk call.
        // The first entry corresponds to the primary item; the rest are its variants.
        const createdVariants = [];
        let createdVariant = null;
        try {
          const variantPayloads = [];

          for (const src of variantSourceProducts) {
            if (!src) continue;

            const variantPrice =
              src?.price_details?.product_price ??
              src?.per_item_price ??
              src?.asking_price ??
              src?.total_price ??
              null;

            const optionValues = buildVariantOptionValuesFromLabels(src);

            variantPayloads.push({
              sku: src?.sku,
              price: variantPrice,
              optionValues
            });
          }

          const variantsCreated = await createOrReplaceVariantFromPayload({
            shopDomain,
            accessToken,
            apiVersion,
            productId: created.id,
            variants: variantPayloads
          });

          if (Array.isArray(variantsCreated) && variantsCreated.length > 0) {
            createdVariants.push(...variantsCreated);
            createdVariant = createdVariants[0];
            resultEntry.createdVariant = createdVariant;
            if (createdVariants.length > 1) {
              resultEntry.additionalVariants = createdVariants.slice(1);
            }
          }
        } catch (variantErr) {
          hasErrors = true;
          resultEntry.variantUpdateError = variantErr.message || 'Unknown variant update error';
        }

        // Set inventory for each created variant, mapping back to its source product.
        if (createdVariants.length && primaryLocationId) {
          for (let vIndex = 0; vIndex < createdVariants.length; vIndex++) {
            const variant = createdVariants[vIndex];
            const src = variantSourceProducts[vIndex] || product;
            const inventoryItemId = variant?.inventoryItem?.id;

            // Use quantity_in_stock (or quantity) from the matching source payload when provided,
            // otherwise default to 10.
            const quantityInStock = typeof src?.quantity_in_stock === 'number'
              ? src.quantity_in_stock
              : typeof src?.quantity === 'number'
                ? src.quantity
                : 10;

            if (!inventoryItemId) continue;

            try {
              // First ensure this inventory item is stocked at the primary location
              await ensureInventoryItemStockedAtLocation({
                shopDomain,
                accessToken,
                apiVersion,
                inventoryItemId,
                locationId: primaryLocationId
              });

              // Then set its available quantity
              const adjustResult = await setInventoryQuantity({
                shopDomain,
                accessToken,
                apiVersion,
                inventoryItemId,
                locationId: primaryLocationId,
                quantity: quantityInStock
              });

              if (vIndex === 0) {
                resultEntry.inventoryAdjustmentGroup = adjustResult;
              } else {
                if (!resultEntry.additionalInventoryAdjustments) {
                  resultEntry.additionalInventoryAdjustments = [];
                }
                resultEntry.additionalInventoryAdjustments.push({
                  index: vIndex,
                  sku: src?.sku || null,
                  result: adjustResult
                });
              }
            } catch (invErr) {
              hasErrors = true;
              if (vIndex === 0) {
                resultEntry.inventoryError = invErr.message || 'Unknown inventory error';
              } else {
                if (!resultEntry.additionalInventoryErrors) {
                  resultEntry.additionalInventoryErrors = [];
                }
                resultEntry.additionalInventoryErrors.push({
                  index: vIndex,
                  sku: src?.sku || null,
                  error: invErr.message || 'Unknown inventory error'
                });
              }
            }
          }
        }

        // After successfully creating the product/variants and adjusting inventory,
        // associate all created variants with the "FinerWorks Shipping" delivery profile when available.
        if (finerWorksShippingProfileGid && createdVariants.length) {
          const variantGids = createdVariants
            .map(v => v && v.id)
            .filter(Boolean);

          if (variantGids.length) {
            try {
              const deliveryProfile = await assignVariantsToShippingProfile({
                shopDomain,
                accessToken,
                apiVersion,
                deliveryProfileGid: finerWorksShippingProfileGid,
                variantGids
              });
              resultEntry.shippingProfileAssignment = {
                deliveryProfileId: deliveryProfile?.id || finerWorksShippingProfileGid,
                variantGids
              };
            } catch (shippingErr) {
              hasErrors = true;
              resultEntry.shippingProfileError =
                shippingErr.message || 'Unknown shipping profile assignment error';
            }
          }
        }

        // After successfully creating the product/variant, updating inventory, and attempting
        // update the FinerWorks virtual inventory with the new Shopify IDs.
        try {
          const accountKey =
            req.body?.account_key ||
            req.body?.accountKey ||
            req.body?.accountkey ||
            null;

          // Extract numeric IDs from Shopify GIDs when possible, fallback to the raw GID.
          const shopifyProductGid = created?.id || null;
          const shopifyProductNumericId = shopifyProductGid
            ? shopifyProductGid.split('/').pop()
            : null;

          const shopifyVariantGid = createdVariant?.id || null;
          const shopifyVariantNumericId = shopifyVariantGid
            ? shopifyVariantGid.split('/').pop()
            : null;

          const finalPayload = {
            virtual_inventory: [
              {
                sku: product?.sku,
                asking_price:
                  product?.asking_price ??
                  product?.per_item_price ??
                  product?.price_details?.product_price ??
                  product?.total_price ??
                  0,
                name: product?.name || 'Untitled',
                description:
                  product?.description_long ||
                  product?.description_short ||
                  '',
                quantity_in_stock:
                  typeof product?.quantity_in_stock === 'number'
                    ? product.quantity_in_stock
                    : typeof product?.quantity === 'number'
                      ? product.quantity
                      : 0,
                track_inventory: true,
                third_party_integrations: {
                  ...(product?.third_party_integrations || {}),
                  // shopify_product_id:
                  //   shopifyProductNumericId || shopifyProductGid || null,
                  shopify_graphql_product_id:
                    shopifyVariantNumericId || shopifyVariantGid || null
                }
              }
            ],
            account_key: accountKey
          };
          console.log("finalPayload==============", finalPayload);

          const virtualInventoryUpdate =
            await finerworksService.UPDATE_VIRTUAL_INVENTORY(finalPayload);

          resultEntry.virtualInventoryUpdate = virtualInventoryUpdate;
          resultEntry.virtualInventoryPayload = finalPayload;
        } catch (fwErr) {
          hasErrors = true;
          resultEntry.virtualInventoryUpdateError =
            fwErr.message || 'Unknown virtual inventory update error';
        }

        results.push(resultEntry);
      } catch (err) {
        hasErrors = true;
        results.push({
          success: false,
          index: i,
          sku: product?.sku || null,
          product_guid: product?.product_guid || null,
          error: err.message || 'Unknown error'
        });
      }
    }

    const statusCode = hasErrors
      ? (results.some(r => r.success) ? 207 : 400)
      : 200;

    return res.status(statusCode).json({
      success: !hasErrors,
      total: products.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      success: false,
      message: 'Failed to sync Shopify products',
      error: err.message || 'Unknown error'
    });
  }
};

/**
 * Create a Shopify Carrier Service for real-time shipping rates.
 *
 * Expects payload:
 * {
 *   "storeName": "shop-name.myshopify.com",   // or "shop-name"
 *   "access_token": "shpat_...",
 *   "carrier_service": {
 *     "name": "My Custom Carrier",
 *     "callback_url": "https://yourapp.com/shopify/carrier-rates",
 *     "service_discovery": true,
 *     "active": true,
 *     "format": "json" // optional, defaults to json
 *   }
 * }
 */
const createShopifyCarrierService = async (req, res) => {
  try {
    let accessToken = req.body?.access_token || req.headers['x-shopify-access-token'];
    const authHeader = req.headers?.authorization || req.headers?.Authorization;

    if (!accessToken && authHeader && authHeader.startsWith('Bearer ')) {
      accessToken = authHeader.slice(7).trim();
    }

    const storeName =
      req.body?.storeName ||
      req.body?.shop ||
      req.body?.store ||
      req.query?.storeName ||
      req.query?.shop;

    const carrierService =
      req.body?.carrier_service ||
      req.body?.carrierService ||
      null;

    if (!accessToken || !storeName || !carrierService) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters: accessToken, storeName, carrier_service'
      });
    }

    const shopDomain = normalizeShopDomain(storeName);
    if (!shopDomain || !shopDomain.match(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid storeName. Expected shopname or shopname.myshopify.com'
      });
    }

    // Per Shopify REST Admin API 2024-01:
    // POST https://{shop_domain}/admin/api/2024-01/carrier_services.json
    const endpoint = `https://${shopDomain}/admin/api/2024-01/carrier_services.json`;
    const headers = {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };

    // We wrap whatever client sends in the required top-level key.
    const payload = {
      carrier_service: carrierService
    };

    const resp = await axios.post(endpoint, payload, { headers });

    return res.status(200).json({
      success: true,
      carrier_service: resp.data?.carrier_service || null,
      shopDomain,
      // Echo the exact payload we sent to Shopify so callers can inspect it.
      requestPayload: payload,
      raw: resp.data
    });
  } catch (err) {
    const status = err?.response?.status || err.status || 500;
    const message =
      (err?.response?.data && (err.response.data.errors || err.response.data.error)) ||
      err.message ||
      'Request failed';
    return res.status(status).json({
      success: false,
      message: 'Failed to create Shopify carrier service',
      error: typeof message === 'string' ? message : JSON.stringify(message)
    });
  }
};

/**
 * List all Shopify carrier services for a store.
 *
 * Accepts:
 * - storeName / shop / store (body or query)
 * - access_token (body, header `x-shopify-access-token`, or Bearer)
 */
const listShopifyCarrierServices = async (req, res) => {
  try {
    let accessToken = req.body?.access_token || req.query?.access_token || req.headers['x-shopify-access-token'];
    const authHeader = req.headers?.authorization || req.headers?.Authorization;

    if (!accessToken && authHeader && authHeader.startsWith('Bearer ')) {
      accessToken = authHeader.slice(7).trim();
    }

    const storeName =
      req.body?.storeName ||
      req.body?.shop ||
      req.body?.store ||
      req.query?.storeName ||
      req.query?.shop;

    if (!accessToken || !storeName) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters: accessToken, storeName'
      });
    }

    const shopDomain = normalizeShopDomain(storeName);
    if (!shopDomain || !shopDomain.match(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid storeName. Expected shopname or shopname.myshopify.com'
      });
    }

    const endpoint = `https://${shopDomain}/admin/api/2024-01/carrier_services.json`;
    const headers = {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };

    const resp = await axios.get(endpoint, { headers });

    return res.status(200).json({
      success: true,
      shopDomain,
      carrier_services: resp.data?.carrier_services || [],
      raw: resp.data
    });
  } catch (err) {
    const status = err?.response?.status || err.status || 500;
    const message =
      (err?.response?.data && (err.response.data.errors || err.response.data.error)) ||
      err.message ||
      'Request failed';
    return res.status(status).json({
      success: false,
      message: 'Failed to list Shopify carrier services',
      error: typeof message === 'string' ? message : JSON.stringify(message)
    });
  }
};

/**
 * Delete a Shopify carrier service by ID.
 *
 * Accepts:
 * - storeName / shop / store (body or query)
 * - access_token (body, header `x-shopify-access-token`, or Bearer)
 * - carrier_service_id / id (body or query)
 */
const deleteShopifyCarrierService = async (req, res) => {
  try {
    let accessToken = req.body?.access_token || req.headers['x-shopify-access-token'];
    const authHeader = req.headers?.authorization || req.headers?.Authorization;

    if (!accessToken && authHeader && authHeader.startsWith('Bearer ')) {
      accessToken = authHeader.slice(7).trim();
    }

    const storeName =
      req.body?.storeName ||
      req.body?.shop ||
      req.body?.store ||
      req.query?.storeName ||
      req.query?.shop;

    const carrierServiceId =
      req.body?.carrier_service_id ||
      req.body?.id ||
      req.query?.carrier_service_id ||
      req.query?.id;

    if (!accessToken || !storeName || !carrierServiceId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters: accessToken, storeName, carrier_service_id'
      });
    }

    const shopDomain = normalizeShopDomain(storeName);
    if (!shopDomain || !shopDomain.match(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid storeName. Expected shopname or shopname.myshopify.com'
      });
    }

    const endpoint = `https://${shopDomain}/admin/api/2024-01/carrier_services/${carrierServiceId}.json`;
    const headers = {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };

    await axios.delete(endpoint, { headers });

    return res.status(200).json({
      success: true,
      shopDomain,
      carrier_service_id: carrierServiceId,
      message: 'Carrier service deleted successfully'
    });
  } catch (err) {
    const status = err?.response?.status || err.status || 500;
    const message =
      (err?.response?.data && (err.response.data.errors || err.response.data.error)) ||
      err.message ||
      'Request failed';
    return res.status(status).json({
      success: false,
      message: 'Failed to delete Shopify carrier service',
      error: typeof message === 'string' ? message : JSON.stringify(message)
    });
  }
};

/**
 * Shopify Carrier Service callback endpoint.
 *
 * This is the callback URL Shopify calls to retrieve live shipping rates.
 * It converts the Shopify request into a FinerWorks SHIPPING_OPTIONS_MULTIPLE
 * request and returns rates in Shopify's expected format.
 *
 * Expected incoming Shopify payload (simplified):
 * {
 *   "rate": {
 *     "origin": { ... },
 *     "destination": { ... },
 *     "items": [ ... ],
 *     "currency": "USD",
 *     "locale": "en"
 *   }
 * }
 *
 * Additionally, we support:
 * - account_key in query or body so we can call FinerWorks.
 */
// const shopifyCarrierServiceCallback = async (req, res) => {
//   try {
//     const rate = req.body?.rate;

//     if (!rate) {
//       return res.status(400).json({
//         error: 'Missing required rate object in request body'
//       });
//     }

//     // const accountKey = req.query?.account_key || req.body?.account_key || null;
//     // if (!accountKey) {
//     //   return res.status(400).json({
//     //     error: 'Missing required parameter: account_key'
//     //   });
//     // }

//     const currency = rate.currency || 'USD';

//     // Build FinerWorks SHIPPING_OPTIONS_MULTIPLE payload in the expected structure
//     const orderPo =
//       rate.id ||
//       rate.reference ||
//       `PO_${Date.now()}`;

//     const dest = rate.destination || {};

//     // Derive first/last name from destination name if possible
//     let firstName = null;
//     let lastName = null;
//     if (typeof dest.name === 'string' && dest.name.trim().length > 0) {
//       const parts = dest.name.trim().split(/\s+/);
//       firstName = parts[0];
//       lastName = parts.slice(1).join(' ') || null;
//     }

//     const recipient = {
//       first_name: firstName,
//       last_name: lastName,
//       company_name: dest.company || dest.company_name || null,
//       address_1: dest.address1 || dest.address_1 || null,
//       address_2: dest.address2 || dest.address_2 || null,
//       address_3: dest.address3 || dest.address_3 || null,
//       city: dest.city || null,
//       state_code: (dest.province_code || dest.province || '').toString().slice(0, 2).toUpperCase() || null,
//       province: '',
//       zip_postal_code: (dest.zip || dest.postal_code || '').toString() || null,
//       country_code: (dest.country_code || dest.country || '').toString().toLowerCase() || null,
//       phone: dest.phone || null,
//       email: dest.email || null,
//       address_order_po: orderPo
//     };

//     const items = Array.isArray(rate.items) ? rate.items : [];
//     const orderItems = items.map((item) => {
//       const title = item.name || item.title || null;
//       const sku = item.sku || item.variant_id || null;
//       return {
//         // product_order_po: orderPo,
//         product_qty: item.quantity || 1,
//         product_sku: sku,
//         product_image: {
//           product_url_file: "https://via.placeholder.com/150",
//           product_url_thumbnail: "https://via.placeholder.com/150"
//         },
//         product_title: title,
//         template: null,
//         product_guid: "1c9f4263-035a-437e-9975-ba81b18f5d94",
//         custom_data_1: null,
//         custom_data_2: null,
//         custom_data_3: null
//       };
//     });

//     const orderPayload = {
//       order_po: orderPo,
//       order_key: null,
//       recipient,
//       order_items: orderItems,
//       // Default shipping code; adjust if you need a different FinerWorks method
//       shipping_code: 'SD',
//       ship_by_date: null,
//       customs_tax_info: null,
//       gift_message: null,
//       test_mode: false,
//       webhook_order_status_url: null,
//       document_url: null,
//       acct_number_ups: null,
//       acct_number_fedex: null,
//       custom_data_1: null,
//       custom_data_2: null,
//       custom_data_3: null,
//       source: null
//     };

//     const fwPayload = {
//       orders: [orderPayload],
//       account_key: "04129d94-10b5-4d85-b584-584d936c8e73"
//     };
//     // console.log("fwPayload======>>>>>", fwPayload);
//     return res.status(200).json( fwPayload );

//     const fwResponse = await finerworksService.SHIPPING_OPTIONS_MULTIPLE(
//       fwPayload
//     );

//     const firstOrder =
//       fwResponse?.orders && Array.isArray(fwResponse.orders)
//         ? fwResponse.orders[0]
//         : null;

//     // FinerWorks returns shipping options under `options` for each order.
//     const shippingOptions = firstOrder?.options || [];

//     const rates = Array.isArray(shippingOptions)
//       ? shippingOptions.map((opt) => {
//           const methodName = opt.shipping_method || opt.name || 'Shipping';
//           const code =
//             opt.shipping_code ||
//             opt.shipping_class_code ||
//             opt.id ||
//             methodName.toLowerCase().replace(/\s+/g, '_');

//           // `rate` is the shipping charge in major currency units (e.g., dollars)
//           const price = opt.rate || 0;
//           // const totalPriceMinor = Math.round(Number(price));
//                     const totalPriceMinor = price


//           const description =
//             opt.transit_time && opt.carrier
//               ? `${opt.shipping_method} - ${opt.carrier} (${opt.transit_time})`
//               : opt.shipping_method || methodName;

//           return {
//             service_name: methodName,
//             service_code: String(code),
//             total_price: String(
//               Number.isFinite(totalPriceMinor) ? totalPriceMinor : 0
//             ),
//             currency,
//             description
//           };
//         })
//       : [];

//     // Final response to Shopify / frontend
//     return res.status(200).json({ rates });
//   } catch (err) {
//     console.error('Error in Shopify carrier service callback:', err);
//     return res.status(500).json({
//       error: 'Internal Server Error'
//     });
//   }
// };

const shopifyCarrierServiceCallback = async (req, res) => {
  try {
    const rate = req.body?.rate;

    if (!rate) {
      return res.status(400).json({
        error: 'Missing required rate object in request body'
      });
    }

    // const accountKey = req.query?.account_key || req.body?.account_key || null;
    // if (!accountKey) {
    //   return res.status(400).json({
    //     error: 'Missing required parameter: account_key'
    //   });
    // }

    const currency = rate.currency || 'USD';

    // Build FinerWorks SHIPPING_OPTIONS_MULTIPLE payload in the expected structure
    const orderPo =
      rate.id ||
      rate.reference ||
      `PO_${Date.now()}`;

    const dest = rate.destination || {};

    // Derive first/last name from destination name if possible
    let firstName = null;
    let lastName = null;
    if (typeof dest.name === 'string' && dest.name.trim().length > 0) {
      const parts = dest.name.trim().split(/\s+/);
      firstName = parts[0];
      lastName = parts.slice(1).join(' ') || null;
    }

    const recipient = {
      first_name: firstName,
      last_name: lastName,
      company_name: dest.company || dest.company_name || null,
      address_1: dest.address1 || dest.address_1 || null,
      address_2: dest.address2 || dest.address_2 || null,
      address_3: dest.address3 || dest.address_3 || null,
      city: dest.city || null,
      state_code: (dest.province_code || dest.province || '').toString().slice(0, 2).toUpperCase() || null,
      province: '',
      zip_postal_code: (dest.zip || dest.postal_code || '').toString() || null,
      country_code: (dest.country_code || dest.country || '').toString().toLowerCase() || null,
      phone: dest.phone || null,
      email: dest.email || null,
      address_order_po: orderPo
    };

    const items = Array.isArray(rate.items) ? rate.items : [];
    const orderItemsPromises = items.map(async(item) => {
      try {
        const title = item.name || item.title || null;
        const sku = item.sku || item.variant_id || null;
        const virtualInventoryPayload = {
          sku_filter: [sku],
          account_key: '04129d94-10b5-4d85-b584-584d936c8e73'
        };
        const virtualInventoryResponse = await finerworksService.LIST_VIRTUAL_INVENTORY(virtualInventoryPayload);
        console.log("virtualInventoryResponse=====",virtualInventoryResponse);
        
        // Extract product_guid from API response
        const productGuid = virtualInventoryResponse?.products?.[0]?.product_guid || "1c9f4263-035a-437e-9975-ba81b18f5d94";
        
        // Only return the item if API call succeeded
        return {
          // product_order_po: orderPo,
          product_qty: item.quantity || 1,
          product_sku: sku,
          product_image: {
            product_url_file: "https://via.placeholder.com/150",
            product_url_thumbnail: "https://via.placeholder.com/150"
          },
          product_title: title,
          template: null,
          product_guid: productGuid,
          custom_data_1: null,
          custom_data_2: null,
          custom_data_3: null
        };
      } catch (error) {
        // If API call fails, log error and return null to skip this item
        console.error(`Failed to fetch virtual inventory for SKU ${item.sku || item.variant_id}:`, error.message);
        return null;
      }
    });
    
    // Wait for all promises and filter out null values (failed API calls)
    const orderItems = (await Promise.all(orderItemsPromises)).filter(item => item !== null);

    // Call LIST_VIRTUAL_INVENTORY API

    const orderPayload = {
      order_po: orderPo,
      order_key: null,
      recipient,
      order_items: orderItems,
      // Default shipping code; adjust if you need a different FinerWorks method
      shipping_code: 'SD',
      ship_by_date: null,
      customs_tax_info: null,
      gift_message: null,
      test_mode: false,
      webhook_order_status_url: null,
      document_url: null,
      acct_number_ups: null,
      acct_number_fedex: null,
      custom_data_1: null,
      custom_data_2: null,
      custom_data_3: null,
      source: null
    };

    const fwPayload = {
      orders: [orderPayload],
      account_key: "04129d94-10b5-4d85-b584-584d936c8e73"
    };
    // console.log("fwPayload======>>>>>", fwPayload);
    // return res.status(200).json( fwPayload );

    const fwResponse = await finerworksService.SHIPPING_OPTIONS_MULTIPLE(
      fwPayload
    );

    const firstOrder =
      fwResponse?.orders && Array.isArray(fwResponse.orders)
        ? fwResponse.orders[0]
        : null;

    // FinerWorks returns shipping options under `options` for each order.
    const shippingOptions = firstOrder?.options || [];

    const rates = Array.isArray(shippingOptions)
      ? shippingOptions.map((opt) => {
          const methodName = opt.shipping_method || opt.name || 'Shipping';
          const code =
            opt.shipping_code ||
            opt.shipping_class_code ||
            opt.id ||
            methodName.toLowerCase().replace(/\s+/g, '_');

          // `rate` is the shipping charge in major currency units (e.g., dollars)
          const price = opt.rate || 0;
          // const totalPriceMinor = Math.round(Number(price));
                    const totalPriceMinor = price


          const description =
            opt.transit_time && opt.carrier
              ? `${opt.shipping_method} - ${opt.carrier} (${opt.transit_time})`
              : opt.shipping_method || methodName;

          return {
            service_name: methodName,
            service_code: String(code),
            total_price: String(
              Number.isFinite(totalPriceMinor) ? totalPriceMinor : 0
            ),
            currency,
            description
          };
        })
      : [];

    // Final response to Shopify / frontend
    return res.status(200).json({ rates });
  } catch (err) {
    console.error('Error in Shopify carrier service callback:', err);
    return res.status(500).json({
      error: 'Internal Server Error'
    });
  }
};

module.exports = {
  getShopifyOrders,
  getShopifyOrderByName,
  fulfillShopifyOrder,
  updateOrderReferenceNumbers,
  updateOrderFulfillmentStatus,
  syncShopifyProducts,
  createShopifyCarrierService,
  listShopifyCarrierServices,
  deleteShopifyCarrierService,
  shopifyCarrierServiceCallback
};