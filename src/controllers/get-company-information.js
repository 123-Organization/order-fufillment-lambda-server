const AWS = require("aws-sdk");
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
            res.status(200).json({
                statusCode: 200,
                status: true,
                data: getInformation?.user_account
            });
        }
    } catch (error) {
        res.status(400).json({
            statusCode: 400,
            status: false,
            message: error.response.data,
        });
    }
};