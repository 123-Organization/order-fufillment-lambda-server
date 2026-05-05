const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand
} = require('@aws-sdk/lib-dynamodb');

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Table `squarespace-accounts` must use `account_key` as the partition key (string).
 * Items should include at least: account_key, refresh_token (and optionally redirect_uri, scope).
 */
const tableName = () => process.env.SQUARESPACE_ACCOUNTS_TABLE_NAME;

const putSquarespaceAccount = async (item) => {
  const TableName = tableName();
  if (!TableName) {
    console.warn('SQUARESPACE_ACCOUNTS_TABLE_NAME not set; skip DynamoDB put');
    return;
  }
  await dynamodb.send(
    new PutCommand({
      TableName,
      Item: {
        ...item,
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
