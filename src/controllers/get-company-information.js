
const debug = require('debug');
const log = debug('app:getCompanyInformation');
const finerworksService = require('../helpers/finerworks-service');
log('get company information api');
/**
 * Retrieves company information.
 *
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @returns {Promise<void>} - A promise that resolves when the company information is retrieved.
 */
exports.getCompanyInformation = async (req, res) => {
    try {
        const reqBody = JSON.parse(JSON.stringify(req.query));
        log('reqBody', JSON.stringify(reqBody));
        const getInformation = await finerworksService.GET_INFO(reqBody);
        if (getInformation) {
            const successLog = JSON.stringify({
              level: 'INFO',
              platform: 'finerworks',
              method: req.method,
              api: req.originalUrl || req.url,
              function: 'getCompanyInformation',
              operation: 'Company information fetched successfully',
              account_key: req.query?.account_key || 'unknown',
              result: { hasData: !!getInformation?.user_account },
              timestamp: new Date().toISOString()
            });
            console.log(successLog);
            log('Success in getCompanyInformation: %s', successLog);
            res.status(200).json({
                statusCode: 200,
                status: true,
                data: getInformation?.user_account
            });
        }
    } catch (error) {
        const isFinerworksError = error?.response?.config?.url?.includes('finerworks.com') || error?.config?.url?.includes('finerworks.com');
        const errorJson = JSON.stringify({
          level: 'ERROR',
          platform: 'finerworks',
          source: isFinerworksError ? 'finerworks_api' : 'lambda',
          function: 'getCompanyInformation',
          account_key: req.query?.account_key || 'unknown',
          httpStatus: error?.response?.status || null,
          message: `Failed to fetch company information: ${error?.message || 'Unknown error'}`,
          detail: error?.response?.data?.message || error?.response?.data?.error || null,
          timestamp: new Date().toISOString()
        });
        console.error(errorJson);
        log('Formatted error in getCompanyInformation: %s', errorJson);
        res.status(400).json({
            statusCode: 400,
            status: false,
            message: error.response.data,
        });
    }
};