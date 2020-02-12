const cookies = require('cookies');
const ws = require('ws');

exports.createApp = async function createApp(config, server, store) {
  
  const wss = new ws.Server({ server });
  
  wss.on('connection', async (conn, req) => {
    try {
      let jar = new cookies(req, null, { keys: [ config.web_secret ]});
      let cookie = jar.get('asterism', { signed: true });
      let session = JSON.parse(Buffer.from(cookie, 'base64').toString('utf8'));
      req.user = session.passport.user;
    } catch (e) {
      return conn.close();
    }
    if ( ! req.user) {
      return conn.close();
    }
    
    let [ course, section, exercise, file ] = req.url.split('/').slice(1);
    store.on([ course, section, exercise ], change => {
      if (change.file === file) {
        conn.send(JSON.stringify(change));
      }
    });
    
    let current = await store.read(course, section, exercise, file);
    for (let [ username, content ] of current.entries()) {
      conn.send(JSON.stringify({ username, content }));
    }
  });
};
