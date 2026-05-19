const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand
} = require('@aws-sdk/lib-dynamodb');
const debug = require("debug");
const log = debug("app:squarespace-accounts-dynamo");

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Table partition key: `id`. Items store both `id` and `account_key`.
 *
 * Upsert rules:
 * - `id` and `account_key` are required on every call (validation error if missing).
 * - Looks up an existing row via GSI `account-key` (partition: `account_key`) using Query.
 * - If found: UpdateItem on that row's `id` (merge attributes; partition key is not changed).
 * - If not found: PutItem using the payload `id` (create).
 *
 * Env: `SQUARESPACE_ACCOUNTS_ACCOUNT_KEY_GSI` (default `account-key`) — must match the DynamoDB GSI name.
 */
const tableName = () => process.env.SQUARESPACE_ACCOUNTS_TABLE_NAME;

const accountKeyGsiName = () =>
  process.env.SQUARESPACE_ACCOUNTS_ACCOUNT_KEY_GSI || 'account-key';

const findFirstItemByAccountKey = async (TableName, account_key) => {
  const collected = [];
  let ExclusiveStartKey;
  do {
    const page = await dynamodb.send(
      new QueryCommand({
        TableName,
        IndexName: accountKeyGsiName(),
        KeyConditionExpression: 'account_key = :ak',
        ExpressionAttributeValues: { ':ak': account_key },
        ExclusiveStartKey
      })
    );
    collected.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  log("collected account-key",JSON.stringify(collected));
  if (collected.length === 0) return null;
  if (collected.length > 1) {
    console.warn(
      'squarespace-accounts: multiple items share account_key; using first match',
      account_key
    );
  }
  return collected[0];
};

const putSquarespaceAccount = async (item) => {
  const TableName = tableName();
  if (!TableName) {
    console.warn('SQUARESPACE_ACCOUNTS_TABLE_NAME not set; skip DynamoDB put');
    return;
  }

  if (item?.id == null || String(item.id).trim() === '') {
    throw new Error('putSquarespaceAccount: id is required');
  }
  if (item?.account_key == null || String(item.account_key).trim() === '') {
    throw new Error('putSquarespaceAccount: account_key is required');
  }

  const id = item.id;
  const account_key = item.account_key;
  const updated_at = new Date().toISOString();

  const existing = await findFirstItemByAccountKey(TableName, account_key);

  if (existing) {
    const partitionId = existing.id;
    if (partitionId == null || String(partitionId).trim() === '') {
      throw new Error(
        'putSquarespaceAccount: existing item matched by account_key is missing id (partition key)'
      );
    }

    const merged = {
      ...existing,
      ...item,
      id: partitionId,
      account_key,
      updated_at
    };

    const names = {};
    const values = {};
    const setParts = [];
    let i = 0;

    for (const [attr, val] of Object.entries(merged)) {
      if (attr === 'id') continue;
      if (val === undefined) continue;
      const nameKey = `#a${i}`;
      const valueKey = `:v${i}`;
      names[nameKey] = attr;
      values[valueKey] = val;
      setParts.push(`${nameKey} = ${valueKey}`);
      i += 1;
    }

    if (setParts.length === 0) {
      return;
    }

    await dynamodb.send(
      new UpdateCommand({
        TableName,
        Key: { id: partitionId },
        UpdateExpression: `SET ${setParts.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values
      })
    );
    return;
  }

  await dynamodb.send(
    new PutCommand({
      TableName,
      Item: {
        ...item,
        id,
        account_key,
        updated_at
      }
    })
  );
};

const scanAllSquarespaceAccounts = async () => {
  const TableName = tableName();
  if (!TableName) {
    throw new Error('SQUARESPACE_ACCOUNTS_TABLE_NAME is not configured');
  }
  const acc = [];
  let ExclusiveStartKey;
  do {
    const page = await dynamodb.send(
      new ScanCommand({
        TableName,
        ExclusiveStartKey
      })
    );
    acc.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return acc;
};

module.exports = {
  putSquarespaceAccount,
  scanAllSquarespaceAccounts
};
