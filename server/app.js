const fs = require('fs');
const https = require('https');

const web = require('./web');

async function createAppServer(config) {
  const server = https.createServer(await web.createApp(config));
  const certify = () => server.setSecureContext({
    key: fs.readFileSync('./config/tls/privkey.pem'),
    cert: fs.readFileSync('./config/tls/fullchain.pem'),
  });
  certify();
  setInterval(certify, 1000 * 60 * 60 * 24).unref();
  return server;
}

async function main() {
  const config = require('./config');
  const port = config.env === 'production' ? 443 : 4443;
  config.hosturl = `https://${config.hostname}${port === 443 ? '' : `:${port}`}`;
  const server = await createAppServer(config);
  server.listen(port, () => console.log({ address: server.address() }, 'listening'));
}

if (require.main === module) {
  main();
}
