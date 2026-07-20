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
const log = debug('app:squarespace-accounts-dynamo');

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

const accountKeyGsiName = () => process.env.SQUARESPACE_ACCOUNTS_ACCOUNT_KEY_GSI || 'account-key';

/** All items matching `account_key` on the account-key GSI (paginated Query). */
const queryAllItemsByAccountKey = async (TableName, account_key) => {
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
  log('collected account-key', JSON.stringify(collected));
  return collected;
};

const findFirstItemByAccountKey = async (TableName, account_key) => {
  const collected = await queryAllItemsByAccountKey(TableName, account_key);
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
      updated_at,
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
        ExpressionAttributeValues: values,
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
        updated_at,
      },
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
        ExclusiveStartKey,
      })
    );
    acc.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return acc;
};

/**
 * Remove all DynamoDB rows for this tenant via GSI `account_key` → table partition key `id`.
 * Deletes every item returned by the Query (handles rare duplicate-account_key rows).
 */
const deleteSquarespaceAccountsByAccountKey = async (account_key) => {
  const TableName = tableName();
  if (!TableName) {
    console.warn('SQUARESPACE_ACCOUNTS_TABLE_NAME not set; skip DynamoDB delete');
    return;
  }
  if (account_key == null || String(account_key).trim() === '') {
    throw new Error('deleteSquarespaceAccountsByAccountKey: account_key is required');
  }
  const ak = String(account_key).trim();
  const items = await queryAllItemsByAccountKey(TableName, ak);
  for (const item of items) {
    const id = item?.id;
    if (id == null || String(id).trim() === '') {
      console.warn('squarespace-accounts: skip delete for item without id (partition key)', ak);
      continue;
    }
    await dynamodb.send(new DeleteCommand({ TableName, Key: { id } }));
  }
};

module.exports = {
  putSquarespaceAccount,
  scanAllSquarespaceAccounts,
  deleteSquarespaceAccountsByAccountKey,
};