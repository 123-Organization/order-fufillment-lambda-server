const braintree = require('braintree');
const debug = require('debug');
const log = debug('app:paymentInformation');
const finerworksService = require('../helpers/finerworks-service');
// const gateway = new braintree.BraintreeGateway({
//     environment: braintree.Environment.Sandbox,
//     merchantId: 'gz4pdd3wyb4m6534',
//     publicKey: 'cybd68b4cqvkkqv3',
//     privateKey: 'c0a5b9010c6c7f80f9aa1be4e18c7986'
// });
// Create a new instance of the BraintreeGateway with the provided credentials
const gateway = new braintree.BraintreeGateway({
    environment: braintree.Environment.Sandbox,
    merchantId: 'h5wcnvynttcdssyn',
    publicKey: 'zhj2v8cwpv3692ys',
    privateKey: 'f951c0861c75fff83f212c421924aa45'
});
exports.getClientToken = async (req, res) => {
    try {
        gateway.clientToken.generate({}, (err, response) => {
            if (err) {

                res.status(500).send(err);
            } else {
                res.status(200).json({
                    statusCode: 200,
                    status: true,
                    token: response.clientToken
                });
            }
        });
    } catch (error) {
        console.log("error is", error);
        res.status(400).json({
            statusCode: 400,
            status: false,
            message: JSON.stringify(error),
        });
    }
};

exports.createCustomer = async(req, res) => {
    try {
        const reqBody = JSON.parse(JSON.stringify(req.body));
        log('requestBody', reqBody);
        gateway.customer.create({
            firstName: reqBody.firstName,
            lastName: reqBody.lastName,
            email: reqBody.email,
            company: reqBody.companyName,
            phone: reqBody.phone
        }, async (err, result) => {
            if (err) {
                log('Error creating customer:', err);
                return;
            }
            if (result.success) {
                log('Customer created successfully:', result.customer.id);
                
                // get User Details
                const getInformation = await finerworksService.GET_INFO(reqBody);
                let payloadForCompanyInformation = {};
                payloadForCompanyInformation.account_key = reqBody.account_key;
                payloadForCompanyInformation = getInformation.user_account;
                payloadForCompanyInformation.payment_profile_id = result.customer.id;
                log('payloadForCompanyInformation', JSON.stringify(payloadForCompanyInformation));
                const updateData = await finerworksService.UPDATE_INFO(payloadForCompanyInformation);
                log('check if data updates', JSON.stringify(updateData));
                log('Customer Id update in the api:', JSON.stringify(payloadForCompanyInformation));
                res.status(200).json({
                    statusCode: 200,
                    status: true,
                    message: "Customer created successfully on brain tree",
                    customerId: result.customer.id
                });
            } else {
                log('Failed to create customer:', result.message);
            }
        });
    } catch (error) {
        log("error is", error);
        res.status(400).json({
            statusCode: 400,
            status: false,
            message: JSON.stringify(error),
        });
    }
};

exports.addPaymentCard = async (req, res) => {
    try {
        const reqBody = JSON.parse(JSON.stringify(req.body));
        log('requestBody', reqBody);
        gateway.paymentMethod.create({
            paymentMethodNonce: reqBody.nonceFromClient,
            customerId: reqBody.customerId
        }, (err, result) => {
            log('result is', result);
            if (err) {
                res.status(400).json({
                    statusCode: 400,
                    status: true,
                    message: err
                });
            } else if (result.success) {
                log('result success', JSON.stringify(result));
                res.status(200).json({
                    statusCode: 200,
                    status: true,
                    message: "card Added Successfully"
                });
            } else if(result.errors) {
                res.status(400).json({
                    statusCode: 400,
                    status: true,
                    message: result.message
                });
            }
        });
    } catch (error) {
        log("error is", error);
        res.status(400).json({
            statusCode: 400,
            status: false,
            message: JSON.stringify(error),
        });
    }
};

exports.getFullCustomerDetails = async (req, res) => {
    try {
        if(!req.query.customerId){
            res.status(400).json({
                statusCode: 400,
                status: false,
                message: "Please provide customer id"
            });
        }
        gateway.customer.find(req.query.customerId, (err, customer) => {
            if (err) {
                console.error('Error:', err);
                return;
            }
        
            if (customer) {
                res.status(200).json({
                    statusCode: 200,
                    status: true,
                    data: customer
                });
            } 
            else {
                res.status(400).json({
                    statusCode: 400,
                    status: false,
                    data: "Invalid customer id"
                });
            }
        });
    } catch (error) {
        log("error is", error);
        res.status(400).json({
            statusCode: 400,
            status: false,
            message: JSON.stringify(error),
        });
    }
};