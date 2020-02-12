const fs = require('fs');

const env = process.env.NODE_ENV || 'development';

module.exports = Object.assign(require(`./env-${env}`), { env });
