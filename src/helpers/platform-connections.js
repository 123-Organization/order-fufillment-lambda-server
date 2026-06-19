const PLATFORM_TO_CONNECTION_NAME = {
  squarespace: 'Squarespace',
  wix: 'Wix',
  shopify: 'Shopify',
  shippo: 'Shippo',
};

function normalizePlatform(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function connectionNameFromPlatform(platform) {
  return PLATFORM_TO_CONNECTION_NAME[normalizePlatform(platform)] || null;
}

function parseConnectionData(conn) {
  if (!conn) return {};
  const raw = conn.data;
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return {};
    }
  }
  if (typeof raw === 'object') return { ...raw };
  return {};
}

function cloneConnections(connections) {
  return Array.isArray(connections) ? JSON.parse(JSON.stringify(connections)) : [];
}

function findConnectionIndex(connections, connectionName) {
  if (!Array.isArray(connections)) return -1;
  return connections.findIndex((c) => c && c.name === connectionName);
}

/** Reads `order_sync` from stringified connection.data (legacy root flag supported). */
function isOrderSyncEnabled(conn, connectionName = null) {
  if (!conn) return false;
  if (connectionName && conn.name !== connectionName) return false;
  const data = parseConnectionData(conn);
  if (data.order_sync === true) return true;
  if (data.order_sync === false) return false;
  return conn.order_sync === true;
}

module.exports = {
  PLATFORM_TO_CONNECTION_NAME,
  normalizePlatform,
  connectionNameFromPlatform,
  parseConnectionData,
  cloneConnections,
  findConnectionIndex,
  isOrderSyncEnabled,
};
