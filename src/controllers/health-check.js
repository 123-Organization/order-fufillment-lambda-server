const debug = require('debug');
const log = debug('app:health-check');

// Health check controller used by /api/health-check
module.exports = (req, res) => {
  const meta = {
    time: new Date().toISOString(),
    userAgent: req.headers['user-agent'] || null,
    sourceIp: req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0] || null,
    path: req.originalUrl || req.url,
  };

  console.log('[HealthCheck] Route invoked', meta);
  log('HealthCheck route invoked', meta);

  return res.json(meta);
};




