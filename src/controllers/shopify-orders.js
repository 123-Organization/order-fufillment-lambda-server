const axios = require('axios');

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

const buildOrdersQuery = (startDate, endDate, first = 10, after = null) => `
{
  orders(first: ${first}, ${after ? `after: "${after}"` : ''}) {
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
        currencyCode
        displayFinancialStatus
        displayFulfillmentStatus
        customer {
          id
          firstName
          lastName
          email
        }
        lineItems(first: 100) {
          edges {
            node {
              id
              title
              quantity
              originalUnitPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              variant {
                id
                title
                sku
                image {
                  url
                  altText
                }
                product {
                  id
                  title
                   featuredImage {
                    url
                    altText
                  }
                }
              }
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

    const query = req.body?.query; // optional override for custom queries
    const orders = await fetchAllOrders({ shopDomain, accessToken, apiVersion, query, startDate, endDate    });
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

module.exports = { getShopifyOrders };


