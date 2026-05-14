const Joi = require('joi');
const debug = require('debug');
const log = debug('app:accountKeyValidator');

const schema = Joi.object({
  account_key: Joi.string().uuid({ version: ['uuidv4'] }).required().label('Account Key')
});

const validateAccountKey = (account_key) => {
  const { error } = schema.validate({ account_key }, { abortEarly: true });

  if (error) {
    log('Account key validation failed', error);
    return {
      valid: false,
      error: { message: error.details[0]?.message || 'Invalid account key' }
    };
  }
  return {
    valid: true,
    error: null
  };
};

module.exports = { validateAccountKey };
