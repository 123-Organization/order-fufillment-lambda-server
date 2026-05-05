const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand
} = require('@aws-sdk/lib-dynamodb');

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Table primary key must include partition key `id` (per your DynamoDB schema).
 * We set `id` to `item.id` when provided, otherwise to `account_key` so one row per tenant.
 * Also keeps `account_key` for FinerWorks lookups and the renewal job.
 */
const tableName = () => process.env.SQUARESPACE_ACCOUNTS_TABLE_NAME;

const putSquarespaceAccount = async (item) => {
  const TableName = tableName();
  if (!TableName) {
    console.warn('SQUARESPACE_ACCOUNTS_TABLE_NAME not set; skip DynamoDB put');
    return;
  }

  const id = item.id != null && String(item.id).length ? item.id : item.account_key;
  if (id == null || String(id).length === 0) {
    throw new Error('putSquarespaceAccount: item must include id or account_key');
  }

  const account_key = item.account_key != null ? item.account_key : id;

  await dynamodb.send(
    new PutCommand({
      TableName,
      Item: {
        ...item,
        id,
        account_key,
        updated_at: new Date().toISOString()
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
