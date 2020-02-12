const events = require('events');
const fs = (fs => Object.assign(fs.promises, { cb: fs }))(require('fs'));
const https = require('https');
const path = require('path');

const web = require('./web');
const websocket = require('./websocket');

function createStore() {
  const store = new events.EventEmitter();
  store.save = async function(course, section, exercise, file, username, content) {
    let directory = path.join(__dirname, 'courses', course, 'section-'+section, exercise, username);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(`${directory}/${file}`, content);
    store.emit([ course, section, exercise], { file, username, content });
  };
  store.read = async function(course, section, exercise, file) {
    let directory = path.join(__dirname, 'courses', course, 'section-'+section, exercise);
    let userdirs = await fs.readdir(directory, {
      withFileTypes: true,
    });
    let entries = await Promise.all(userdirs.filter(d => d.isDirectory()).map(async d => {
      return Promise.all([
        d.name,
        fs.readFile(path.join(directory, d.name, file), 'utf8').catch(e => null),
      ]);
    }));
    return new Map(entries.filter(([ _, content ]) => content));
  };
  return store;
}

async function createAppServer(config) {
  const store = createStore();
  const server = https.createServer(await web.createApp(config, store));
  websocket.createApp(config, server, store);
  const certify = () => server.setSecureContext({
    key: fs.cb.readFileSync('./config/tls/privkey.pem'),
    cert: fs.cb.readFileSync('./config/tls/fullchain.pem'),
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
