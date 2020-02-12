const crypto = require('crypto');
const events = require('events');
const fs = require('fs').promises;
const util = require('util');

const bodyparser = require('body-parser');
const express = require('express');
const openidclient = require('openid-client');
const { Passport } = require('passport');
const pug = require('pug');
const session = require('cookie-session');
const zipstream = require('zip-stream');

exports.createApp = async function createApp(config, store) {
  
  const passport = new Passport();
  const openidissuer = await openidclient.Issuer.discover(config.oidc.server);
  passport.use('openid', new openidclient.Strategy({
    client: new openidissuer.Client(config.oidc.client),
    params: { scope: 'openid email profile' },
  }, (tokenset, userinfo, done) => {
    done(null, userinfo.email.replace(`@${config.oidc.email_domain}`, ''));
  }));
  const returnUsername = (username, done) => done(null, username);
  passport.serializeUser(returnUsername);
  passport.deserializeUser(returnUsername);
  
  const app = express();
  
  app.set('view engine', 'pug');
  app.set('views', `${__dirname}/views`);
  app.set('x-powered-by', false);
  
  app.use('/static', express.static(`${__dirname}/static`));
  
  app.param('course', (req, res, next, course) => {
    if ( ! /^\w+\.\w+$/.test(course)) { return next('route'); }
    res.locals.course = course;
    next();
  });
  app.param('section', (req, res, next, section) => {
    if ( ! /^[\w-]+$/.test(section)) { return next('route'); }
    res.locals.section = section;
    next();
  });
  app.param('exercise', (req, res, next, exercise) => {
    if ( ! /^[\w-]+$/.test(exercise)) { return next('route'); }
    res.locals.exercise = exercise;
    next();
  });
  app.param('file', (req, res, next, file) => {
    if ( ! /^[\w.-]+$/.test(file)) { return next('route'); }
    res.locals.file = file;
    next();
  });
  app.param('signature', (req, res, next, signature) => {
    if ( ! /^\w{16}$/.test(signature)) { return next('route'); }
    next();
  });
  app.param('uuid', (req, res, next, uuid) => {
    if ( ! /^[\w-]+$/.test(uuid)) { return next('route'); }
    next();
  });
  app.param('token', (req, res, next, token) => {
    if ( ! /^\w+:\d+:\w{32}$/.test(token)) { return next('route'); }
    next();
  });
  
  app.use(session({
    name: 'asterism', secret: config.web_secret,
    secure: true, httpOnly: true, sameSite: 'lax', signed: true, overwrite: true,
  }));
  
  app.use(passport.initialize());
  app.use(passport.session());
  app.get('/auth', passport.authenticate('openid', {
    successReturnToOrRedirect: '/',
    failWithError: true,
  }), (req, res, next) => {
    res.status(401).render('401', { error: 'Authentication failed' });
  });
  
  function authenticateUser(req, res, next) {
    if ( ! req.user) {
      if (req.method === 'POST') {
        return res.status(401).end('Unauthenticated POST request');
      }
      req.session.returnTo = req.originalUrl;
      return res.redirect('/auth');
    }
    res.locals.authusername = req.user;
    next();
  }
  
  async function staffOnly(req, res, next) {
    try {
      let staff = await fs.readFile(`${__dirname}/courses/${req.params.course}/staff.json`, 'utf8');
      if (JSON.parse(staff).includes(res.locals.authusername)) {
        return next();
      }
    } catch (err) {
      return next(err);
    }
    return res.status(403).end();
  }
  
  const linkEvents = new events.EventEmitter();
  const links = new Map();
  
  function now() { return Math.floor((new Date()-new Date(2020,0))/1000/60/60); }
  
  function signedUsername(u, ts) {
    let hmac = crypto.createHmac('sha256', config.web_secret);
    return `${u}:${ts}:${hmac.update(u).update(`${ts}`).digest('hex').substring(0, 32)}`;
  }
  
  function authenticateScript(req, res, next) {
    let [ u, ts ] = req.params.token.split(':');
    if (req.params.token !== signedUsername(u, ts)) {
      return res.status(403).end();
    }
    if (now() - ts > 12) {
      return res.status(403).end();
    }
    res.locals.authusername = u;
    next();
  }
  
  function signedExercise() {
    let hmac = crypto.createHmac('sha256', config.web_secret);
    return hmac.update(JSON.stringify(arguments)).digest('hex').substring(0, 16)
  }
  
  app.get('/', (req, res, next) => {
    res.render('root');
  });
  
  app.get('/:signature/:course/:section/:exercise.zip', async (req, res, next) => {
    let { course, section, exercise } = req.params;
    if (req.params.signature !== signedExercise(course, section, exercise)) {
      return res.status(403).end();
    }
    (await exerciseZip(config.hosturl, course, section, exercise)).pipe(res);
  });
  
  app.get('/:signature/:course/:section/:exercise', authenticateUser, async (req, res, next) => {
    let { course, section, exercise } = req.params;
    if (req.params.signature !== signedExercise(course, section, exercise)) {
      return res.status(403).end();
    }
    res.render('instructions', {
      files: await exerciseFiles(course, section, exercise),
      zip: `${req.path}.zip`,
    });
  });
  
  app.get('/:course/:section/:exercise/start/:uuid', authenticateUser, (req, res, next) => {
    links.set(req.params.uuid, res.locals.authusername);
    linkEvents.emit(req.params.uuid, res.locals.authusername);
    res.render('start');
  });
  
  app.get('/:course/:section/:exercise/await/:uuid', async (req, res, next) => {
    let user = links.get(req.params.uuid);
    if ( ! user) {
      // wait for a few minutes
      setTimeout(() => linkEvents.emit(req.params.uuid), 1000 * 60 * 10);
      [ user ] = await events.once(linkEvents, req.params.uuid);
    }
    if ( ! user) {
      return res.status(408).end();
    }
    links.delete(req.params.uuid);
    res.end(signedUsername(user, now()));
  });
  
  app.post('/:course/:section/:exercise/push/:file/:token', authenticateScript, bodyparser.urlencoded({
    extended: false,
  }), async (req, res, next) => {
    let { course, section, exercise, file } = req.params;
    await store.save(course, section, exercise, file, res.locals.authusername, req.body.content);
    res.end();
  });
  
  app.get('/:course/:section/:exercise/pull/:token', authenticateScript, async (req, res, next) => {
    console.log('pull', res.locals.authusername, req.params);
  });
  
  app.get('/:course/:section/*', authenticateUser, staffOnly);
  
  app.get('/:course/:section/:exercise', async (req, res, next) => {
    let { course, section, exercise } = req.params;
    res.render('exercise', {
      files: await exerciseFiles(course, section, exercise),
      student: `/${signedExercise(course, section, exercise)}/${course}/${section}/${exercise}`,
    });
  });
  
  app.get('/:course/:section/:exercise/:file', async (req, res, next) => {
    let { course, section, exercise, file } = req.params;
    let starting = (await exerciseFiles(course, section, exercise)).find(f => f.name == file);
    res.render('watch', {
      starting: magic(starting.content, file, config.hosturl, course, section, exercise),
    });
  });
  
  return app;
}

async function exerciseFiles(course, section, exercise) {
  let directory = `${__dirname}/courses/${course}/exercises/${exercise}`;
  let entries = await fs.readdir(directory, {
    withFileTypes: true,
  });
  return Promise.all(entries.filter(f => {
    return f.isFile() && ! f.name.startsWith('.');
  }).map(async f => {
    let filename = `${directory}/${f.name}`;
    let stat = await fs.stat(filename);
    let content = await fs.readFile(filename, 'utf8');
    return {
      name: f.name,
      content: content,
      executable: stat.mode & fs.cb.constants.S_IXUSR,
      magic_mode: PROTO_TELESCOPE.test(content) ? 'push' : undefined,
    };
  }));
}

async function exerciseZip(hosturl, course, section, exercise) {
  let files = await exerciseFiles(course, section, exercise);
  let zip = new zipstream();
  let entry = util.promisify(zip.entry).bind(zip);
  for (let { name, content, executable } of files) {
    await entry(magic(content, name, hosturl, course, section, exercise), {
      name, mode: executable ? 0o755 : 0o644,
    });
  }
  await entry(await asterismPy(hosturl, course, section, exercise), {
    name: 'asterism.py', mode: 0o755,
  });
  zip.finish();
  return zip;
}

const PROTO_TELESCOPE = /(.{0,5} +)(Asterism +\*\*\* +)student( +-> +)server( +\*\*\*)/;

function magic(content, name, hosturl, course, section, exercise) {
  return content.replace(PROTO_TELESCOPE, (m, comment, pre, direction, post) => {
    return `${comment}Do not edit the following magic line, it shares your work on this file during class:\n` +
           `${comment}${pre}${name}${direction}${hosturl}/${course}/${section}/${exercise}${post}\n` +
           `${comment}While \`asterism.py\` is running, when you save this file, your changes are recorded.`;
  });
}

async function asterismPy(hosturl, course, section, exercise) {
  let directory = `${__dirname}/../client`;
  let lib = await fs.readFile(`${directory}/asterism_lib.py`, 'utf8');
  let main = await fs.readFile(`${directory}/asterism_main.py`, 'utf8');
  return `${lib}\n` +
         `URL='${hosturl}/${course}/${section}/${exercise}'\nEXTENSION='.py'\n` +
         `${main}`;
}
