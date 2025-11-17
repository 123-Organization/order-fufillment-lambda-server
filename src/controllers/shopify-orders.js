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
    const orders = await fetchAllOrders({ shopDomain, accessToken, apiVersion, query, startDate, endDate });
    orders.forEach(order => {
      order.shippingLines.edges.forEach(edge => {
        if(edge.node.title === 'Standard') {
          shippingOptions.shipping_options.forEach(option => {
            if(option.shipping_method === 'Standard - Parcel') {
              edge.node.code=option.id;
            }
          });
        }
        if(edge.node.title === 'Economy') {
          shippingOptions.shipping_options.forEach(option => {
            if(option.shipping_method === 'Economy') {
              edge.node.code=option.id;
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
  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  const headers = {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json'
  };
  const query = buildOrderByNameQuery(orderName);
  let resp;
  try {
    resp = await axios.post(endpoint, { query, variables: {} }, { headers });
    var shippingOptions = await finerworksService.SHIPPING_OPTIONS_LIST();
    console.log("shippingOptions=====>>>>",shippingOptions);
    
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
  console.log("node=====",node.shippingLines);
  node.shippingLines.edges.forEach(edge => {
    console.log("edge=====",edge.node.title);
    if(edge.node.title === 'Standard') {
      shippingOptions.shipping_options.forEach(option => {
        if(option.shipping_method === 'Standard - Parcel') {
          edge.node.code=option.id;
        }
      });
    }else if(edge.node.title === 'Economy') {
      shippingOptions.shipping_options.forEach(option => {
        if(option.shipping_method === 'Economy') {
          edge.node.code=option.id;
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

const fulfillShopifyOrder = async (req, res) => {
  try {
    let accessToken = req.body?.access_token || req.headers['x-shopify-access-token'];
    const authHeader = req.headers?.authorization || req.headers?.Authorization;
    
    if (!accessToken && authHeader && authHeader.startsWith('Bearer ')) {
      accessToken = authHeader.slice(7).trim();
    }
    
    const storeName = req.body?.storeName || req.body?.shop || req.body?.store || req.query?.storeName || req.query?.shop;
    const orderId = req.body?.orderId || req.body?.order_id || req.body?.id;
    const orderName = req.body?.orderName || req.body?.order_name || req.body?.name;
    const lineItems = req.body?.lineItems || req.body?.line_items;
    const trackingInfo = req.body?.trackingInfo || req.body?.tracking_info;
    const apiVersion = process.env.SHOPIFY_API_VERSION || '2025-10';

    if (!accessToken || !storeName) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters: accessToken and storeName'
      });
    }

    if (!orderId && !orderName) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameter: orderId or orderName'
      });
    }

    const shopDomain = normalizeShopDomain(storeName);
    if (!shopDomain || !shopDomain.match(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid storeName. Expected shopname or shopname.myshopify.com'
      });
    }

    let shopifyOrderId = orderId;
    
    // If orderName is provided instead of orderId, fetch the order first
    if (orderName && !orderId) {
      const order = await fetchOrderByName({ shopDomain, accessToken, apiVersion, orderName });
      if (!order) {
        return res.status(404).json({
          success: false,
          message: 'Order not found'
        });
      }
      shopifyOrderId = order.id;
    }

    // Normalize order ID to GID format
    shopifyOrderId = normalizeOrderId(shopifyOrderId);

    // Get fulfillment orders for the order
    const orderData = await fetchFulfillmentOrders({ 
      shopDomain, 
      accessToken, 
      apiVersion, 
      orderId: shopifyOrderId 
    });

    if (!orderData || !orderData.fulfillmentOrders || orderData.fulfillmentOrders.edges.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No fulfillment orders found for this order'
      });
    }

    // Get the first fulfillment order (or you could iterate through all)
    const fulfillmentOrder = orderData.fulfillmentOrders.edges[0].node;
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
        return res.status(400).json({
          success: false,
          message: 'No items available to fulfill. All items may already be fulfilled.'
        });
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

    return res.status(200).json({
      success: true,
      message: 'Order fulfilled successfully',
      fulfillment,
      order: {
        id: orderData.id,
        name: orderData.name
      }
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      success: false,
      message: 'Failed to fulfill order',
      error: err.message || 'Unknown error'
    });
  }
};

module.exports = { getShopifyOrders, getShopifyOrderByName, fulfillShopifyOrder };


