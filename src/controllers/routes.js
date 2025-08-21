
const { Router } = require('express');
const { updateCompanyInformation } = require('./update-company-information');
const { getCompanyInformation } = require('./get-company-information');
const { getClientToken, addPaymentCard, createCustomer, getFullCustomerDetails, processVaultedPaymentToken,removePaymentCard } = require('./payment-information');
const { validateOrders, validateSubmitOrders, uploadOrdersToLocalDatabase, updateOrder,uploadOrdersToLocalDatabaseFromExcel } = require('./upload-orders'); 
const { listVirtualInventory,listVirtualInventoryV2, validateListVirtualInventory, validateUpdateVirtualInventory, updateVirtualInventory, validateSkus, deleteVirtualInventory, getProductBySku } = require('./virtual-inventory');
const { validateAddProduct, addProduct, getProductDetails,increaseProductQuantity,exportToWoocomercev1,productTrashed,productRestored,productSkuUpdated } = require('./products-management');
const { viewOrderDetails, viewAllOrders, updateOrderByProductSkuCode, createNewOrder, deleteOrder, orderSubmitStatus, getOrderPrice, submitOrders,submitOrdersV2,getOrderDetailsById,softDeleteOrders ,disconnectAndProcess,connectAndProcess,connectAndProcessOfa,disconnectProductsFromInventory,updateOrderByValidProductSkuCode,testAccountKey,checkDomain,sendOrderDetails} = require('./orders');
const { listShippingOptions } = require('./shipping-options');
const { getUserPaymentToken,getCompanyInfo } = require('./payment-token');
const {updateUserInformation}=require('./userInformation')
const app = Router();
app.put('/update-company-information',updateCompanyInformation);
app.get('/get-info', getCompanyInformation);
app.get('/get-user-details', getCompanyInformation);
app.get('/get-client-token', getClientToken);
app.post('/create-customer', createCustomer);
app.post('/add-payment-card', addPaymentCard);
app.get('/get-customer-details', getFullCustomerDetails);
app.post('/validate-orders', validateSubmitOrders, validateOrders);
app.post('/get-order-price', getOrderPrice);
app.post('/get-product-details', getProductDetails);
app.post('/shipping-options', listShippingOptions);
app.post('/list-virtual-inventory', validateListVirtualInventory, listVirtualInventory);
app.put('/update-virtual-inventory', validateUpdateVirtualInventory, updateVirtualInventory);
app.delete('/delete-virtual-inventory', validateSkus, deleteVirtualInventory);
app.post('/add-product', validateAddProduct, addProduct);
app.post('/upload-orders', uploadOrdersToLocalDatabase);
app.post('/view-all-orders', viewAllOrders);
app.put('/update-orders', updateOrder);
app.get('/get-product-by-sku/:sku', getProductBySku);
app.post('/view-order-details', viewOrderDetails);
app.post('/update-order-by-product', updateOrderByProductSkuCode);
app.post('/create-new-order', createNewOrder);
app.delete('/delete-order', deleteOrder);
app.delete('/submit-order', submitOrders);
app.post('/order-submit-status', orderSubmitStatus);
app.get('/get-user-payment-tokens', getUserPaymentToken);
app.post('/process-vaulted-payment', processVaultedPaymentToken);
app.post('/add-token-to-user', updateUserInformation);
app.post('/increase-product-quantity', increaseProductQuantity);
app.post('/export-to-woocommerce', exportToWoocomercev1);
app.post('/remove-card', removePaymentCard);
app.post('/get-order-details-by-id', getOrderDetailsById);
app.post('/soft-delete-after-payment', softDeleteOrders);
app.post('/disconnect', disconnectAndProcess);
app.post('/disconnect-products-virtualInventory', disconnectProductsFromInventory);
app.get('/get-company-info', getCompanyInfo);
app.post('/upload-orders-from-excel', uploadOrdersToLocalDatabaseFromExcel);
app.post('/update-order-by-valid-product-sku', updateOrderByValidProductSkuCode);
app.post('/submit-orders-v2', submitOrdersV2);
app.post('/connection-establishment', connectAndProcess);
app.post('/product-trashed', productTrashed);
app.post('/product-restored', productRestored);
app.post('/product-sku-updated', productSkuUpdated);
app.post('/test-account-key', testAccountKey);
app.post('/list-virtual-inventory-v2', validateListVirtualInventory, listVirtualInventoryV2);
app.post('/connection-establishment-Ofa', connectAndProcessOfa);
app.post('/check-domain', checkDomain);
app.post('/send-order-details', sendOrderDetails);




















module.exports = app;