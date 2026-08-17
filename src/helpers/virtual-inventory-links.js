const debug = require('debug');
const log = debug('app:virtualInventoryLinks');
const finerworksService = require('./finerworks-service');
const { ApiError } = require('./api-error');

// third_party_integrations fields owned by each source, scoped so clearing one platform's link
// never touches another platform's link. Etsy has no variant id in the schema, and Shopify's
// existing delete flow (shopify-orders.js clearShopifyGraphqlProductIdForSkus) owns
// shopify_graphql_product_id/shopify_graphql_variant_id separately — not duplicated here.
const SOURCE_ID_FIELDS = {
  squarespace: ['squarespace_product_id', 'squarespace_variant_id'],
  square: ['square_product_id', 'square_variant_id'],
  wix: ['wix_product_id', 'wix_variant_id', 'wix_inventory_id'],
  etsy: ['etsy_product_id'],
};

/**
 * Given a platform product/variant id (whatever value that platform's
 * third_party_connections_filter search matches on), finds every Virtual Inventory item still
 * linked to it and clears only the id fields owned by `source` — mirrors the Shopify
 * products/delete pattern (shopify-orders.js clearShopifyGraphqlProductIdForSkus /
 * LIST_VIRTUAL_INVENTORY third_party_connections_filter), generalized for reuse by other
 * platforms' delete webhooks.
 *
 * Batches every affected SKU into a single UPDATE_VIRTUAL_INVENTORY call instead of one call per
 * SKU, since the FinerWorks API already accepts an array.
 */
async function clearVirtualInventoryLinkByConnectionId({ source, connectionId, accountKey }) {
  const idFields = SOURCE_ID_FIELDS[source];
  if (!idFields) {
    throw new ApiError(400, `Unsupported source for link clearing: ${source}`, { platform: source });
  }
  if (!connectionId || !String(connectionId).trim()) {
    return { cleared: [], count: 0 };
  }

  const listResp = await finerworksService.LIST_VIRTUAL_INVENTORY({
    third_party_connections_filter: String(connectionId).trim(),
    account_key: accountKey,
  });
  const products = Array.isArray(listResp?.products) ? listResp.products : [];
  log('found %d VI item(s) linked to %s connectionId=%s', products.length, source, connectionId);

  const itemsToUpdate = [];
  const cleared = [];

  for (const product of products) {
    const integrations = product?.third_party_integrations || {};
    const fieldsToClear = idFields.filter(
      (field) => integrations[field] != null && integrations[field] !== ''
    );
    if (!fieldsToClear.length) continue;

    const clearedIntegrations = { ...integrations };
    for (const field of fieldsToClear) {
      clearedIntegrations[field] = null;
    }

    itemsToUpdate.push({
      sku: product.sku,
      asking_price: product.asking_price ?? 0,
      name: product.name ?? 'Untitled',
      description: product.description ?? '',
      quantity_in_stock: product.quantity_in_stock ?? 0,
      track_inventory: product.track_inventory ?? true,
      third_party_integrations: clearedIntegrations,
    });
    cleared.push({ sku: product.sku, fields: fieldsToClear });
  }

  if (!itemsToUpdate.length) {
    return { cleared: [], count: 0 };
  }

  const updateResp = await finerworksService.UPDATE_VIRTUAL_INVENTORY({
    virtual_inventory: itemsToUpdate,
    account_key: accountKey,
  });
  if (!updateResp?.status?.success) {
    throw new ApiError(502, 'Failed to clear virtual inventory link(s)', { platform: source });
  }

  return { cleared, count: cleared.length };
}

module.exports = {
  SOURCE_ID_FIELDS,
  clearVirtualInventoryLinkByConnectionId,
};
