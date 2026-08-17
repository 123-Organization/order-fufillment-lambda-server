const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
    DynamoDBDocumentClient,
    PutCommand,
    UpdateCommand,
    QueryCommand,
    ScanCommand,
} = require('@aws-sdk/lib-dynamodb');
const debug = require('debug');
const log = debug('app:wix-accounts-dynamo');

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Reverse index: Wix site_id -> account_key. Mirrors square-accounts-dynamo.js exactly (same
 * shape, same upsert-via-GSI convention) because Wix has the same problem Square does — the
 * Product Deleted webhook (wix-webhooks.js) carries only `metadata.accountInfo.siteId`, and Wix
 * app webhooks are registered once for all installs (one shared URL, not one per account), so
 * there is no way to route the event back to a tenant without this table.
 *
 * Table partition key: `id` (the account's Wix access_token, matching how wix-auth.js's
 * upsertWixConnection already keys per-account data). Items store `id`, `account_key`, `site_id`.
 *
 * Env: `WIX_ACCOUNTS_TABLE_NAME`, `WIX_ACCOUNTS_ACCOUNT_KEY_GSI` (default `account-key`).
 * Requires the `wix-accounts` table + GSI to exist in AWS before this can resolve anything —
 * see the delete-webhook design note for the exact table/GSI shape to provision.
 */
const tableName = () => process.env.WIX_ACCOUNTS_TABLE_NAME;

const accountKeyGsiName = () => process.env.WIX_ACCOUNTS_ACCOUNT_KEY_GSI || 'account-key';

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
    return collected;
};

const findFirstItemByAccountKey = async (TableName, account_key) => {
    const collected = await queryAllItemsByAccountKey(TableName, account_key);
    if (collected.length === 0) return null;
    if (collected.length > 1) {
        console.warn('wix-accounts: multiple items share account_key; using first match', account_key);
    }
    return collected[0];
};

/**
 * Upsert keyed by account_key (via GSI query, same as square-accounts-dynamo's putSquareAccount)
 * so re-installs / token refreshes update the existing row instead of creating duplicates.
 */
const putWixAccount = async (item) => {
    const TableName = tableName();
    if (!TableName) {
        console.warn('WIX_ACCOUNTS_TABLE_NAME not set; skip DynamoDB put');
        return;
    }
    if (item?.id == null || String(item.id).trim() === '') {
        throw new Error('putWixAccount: id is required');
    }
    if (item?.account_key == null || String(item.account_key).trim() === '') {
        throw new Error('putWixAccount: account_key is required');
    }

    const id = item.id;
    const account_key = item.account_key;
    const updated_at = new Date().toISOString();

    const existing = await findFirstItemByAccountKey(TableName, account_key);

    if (existing) {
        const partitionId = existing.id;
        const merged = { ...existing, ...item, id: partitionId, account_key, updated_at };

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
        if (!setParts.length) return;

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
        new PutCommand({ TableName, Item: { ...item, id, account_key, updated_at } })
    );
};

const scanAllWixAccounts = async () => {
    const TableName = tableName();
    if (!TableName) {
        throw new Error('WIX_ACCOUNTS_TABLE_NAME is not configured');
    }
    const acc = [];
    let ExclusiveStartKey;
    do {
        const page = await dynamodb.send(new ScanCommand({ TableName, ExclusiveStartKey }));
        acc.push(...(page.Items || []));
        ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return acc;
};

/**
 * Resolves the OFA tenant for an inbound Wix product webhook: events carry only
 * metadata.accountInfo.siteId (app webhooks are registered once for every install, not per
 * account), and site_id is stored on each row by persistWixClientCredentialsConnection. Table
 * has no site_id index, so this scans — same tradeoff square-accounts-dynamo makes for
 * merchant_id, acceptable at this account scale.
 */
const findAccountKeyByWixSiteId = async (site_id) => {
    const TableName = tableName();
    if (!TableName) {
        console.warn('WIX_ACCOUNTS_TABLE_NAME not set; cannot resolve site_id');
        return null;
    }
    const sid = String(site_id || '').trim();
    if (!sid) return null;

    const rows = await scanAllWixAccounts();
    const match = rows.find((r) => String(r?.site_id || '').trim() === sid && r?.account_key);
    return match ? String(match.account_key).trim() : null;
};

module.exports = {
    putWixAccount,
    scanAllWixAccounts,
    findAccountKeyByWixSiteId,
};
