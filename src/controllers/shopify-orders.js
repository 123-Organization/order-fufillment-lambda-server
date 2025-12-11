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

    const statusValue = req.body?.status;
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
      orderName: orderNumber
    });

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

module.exports = { getShopifyOrders, getShopifyOrderByName, fulfillShopifyOrder, updateOrderReferenceNumbers, updateOrderFulfillmentStatus };