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

module.exports = { getShopifyOrders, getShopifyOrderByName };


