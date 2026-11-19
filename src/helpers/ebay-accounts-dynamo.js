const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
  DeleteCommand,
} = require('@aws-sdk/lib-dynamodb');
const debug = require('debug');
const log = debug('app:ebay-accounts-dynamo');

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * eBay seller <-> OFA account registry (same table shape as square-accounts).
 *
 * Why it exists: eBay notifications (order events, marketplace account deletion) are delivered
 * to one app-level endpoint and identify the *eBay user*, not our account_key; the scheduled
 * order poll also needs the list of accounts with order sync on. Tokens are NOT stored here —
 * they stay in the account's FinerWorks connection like every other platform.
 *
 * Row: { id (partition key), account_key (GSI `account-key`), ebay_user_id, ebay_username,
 *        order_sync, notification_subscription_id, updated_at }
 *
 * Env: EBAY_ACCOUNTS_TABLE_NAME, EBAY_ACCOUNTS_ACCOUNT_KEY_GSI (default `account-key`).
 * Every function is a safe no-op (or returns empty) when the table name isn't configured, so
 * local development works without DynamoDB.
 */
const tableName = () => process.env.EBAY_ACCOUNTS_TABLE_NAME;
const accountKeyGsiName = () => process.env.EBAY_ACCOUNTS_ACCOUNT_KEY_GSI || 'account-key';

async function queryAllItemsByAccountKey(TableName, account_key) {
  const collected = [];
  let ExclusiveStartKey;
  do {
    const page = await dynamodb.send(
      new QueryCommand({
        TableName,
        IndexName: accountKeyGsiName(),
        KeyConditionExpression: 'account_key = :ak',
        ExpressionAttributeValues: { ':ak': account_key },
        ExclusiveStartKey,
      })
    );
    collected.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return collected;
}

/** Upsert by account_key: merges into the existing row, or creates one with `item.id`. */
async function putEbayAccount(item) {
  const TableName = tableName();
  if (!TableName) {
    log('EBAY_ACCOUNTS_TABLE_NAME not set; skip DynamoDB put');
    return;
  }
  if (!item?.id || !String(item.id).trim()) throw new Error('putEbayAccount: id is required');
  if (!item?.account_key || !String(item.account_key).trim()) throw new Error('putEbayAccount: account_key is required');

  const account_key = String(item.account_key).trim();
  const updated_at = new Date().toISOString();
  const existing = (await queryAllItemsByAccountKey(TableName, account_key))[0] || null;

  if (existing?.id) {
    const merged = { ...existing, ...item, id: existing.id, account_key, updated_at };
    const names = {};
    const values = {};
    const setParts = [];
    let i = 0;
    for (const [attr, val] of Object.entries(merged)) {
      if (attr === 'id' || val === undefined) continue;
      names[`#a${i}`] = attr;
      values[`:v${i}`] = val;
      setParts.push(`#a${i} = :v${i}`);
      i += 1;
    }
    if (!setParts.length) return;
    await dynamodb.send(
      new UpdateCommand({
        TableName,
        Key: { id: existing.id },
        UpdateExpression: `SET ${setParts.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
    return;
  }

  await dynamodb.send(new PutCommand({ TableName, Item: { ...item, account_key, updated_at } }));
}

/** Partial update of the row(s) for an account_key (no-op if the account has no row yet). */
async function updateEbayAccountByAccountKey(account_key, patch) {
  const TableName = tableName();
  if (!TableName) return;
  const ak = String(account_key || '').trim();
  if (!ak) return;
  const rows = await queryAllItemsByAccountKey(TableName, ak);
  for (const row of rows) {
    if (!row?.id) continue;
    await putEbayAccount({ ...row, ...patch, id: row.id, account_key: ak });
  }
}

async function scanAllEbayAccounts() {
  const TableName = tableName();
  if (!TableName) return [];
  const acc = [];
  let ExclusiveStartKey;
  do {
    const page = await dynamodb.send(new ScanCommand({ TableName, ExclusiveStartKey }));
    acc.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return acc;
}

async function deleteEbayAccountsByAccountKey(account_key) {
  const TableName = tableName();
  if (!TableName) return;
  const ak = String(account_key || '').trim();
  if (!ak) return;
  const rows = await queryAllItemsByAccountKey(TableName, ak);
  for (const row of rows) {
    if (row?.id) await dynamodb.send(new DeleteCommand({ TableName, Key: { id: row.id } }));
  }
}

/**
 * account_keys linked to an eBay seller, matched on eBay userId and/or username (notification
 * payloads carry one or the other depending on topic). Scans — the table is small (one row per
 * connected account) and this only runs on inbound notifications.
 */
async function findAccountKeysByEbayUser({ userId, username } = {}) {
  const uid = String(userId || '').trim();
  const uname = String(username || '').trim().toLowerCase();
  if (!uid && !uname) return [];
  const rows = await scanAllEbayAccounts();
  return [
    ...new Set(
      rows
        .filter(
          (r) =>
            r?.account_key &&
            ((uid && String(r.ebay_user_id || '').trim() === uid) ||
              (uname && String(r.ebay_username || '').trim().toLowerCase() === uname))
        )
        .map((r) => String(r.account_key).trim())
    ),
  ];
}

module.exports = {
  putEbayAccount,
  updateEbayAccountByAccountKey,
  scanAllEbayAccounts,
  deleteEbayAccountsByAccountKey,
  findAccountKeysByEbayUser,
};
