'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const { OAuth2Client } = require('google-auth-library');
const sheet = require('./sheet');
const { buildModel, allowedActions, ACTIONS } = require('./model');
const { buildAnalytics } = require('./analytics');

const {
  PORT = 3000,
  NODE_ENV,
  BASE_URL = `http://localhost:${PORT}`,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  SESSION_SECRET,
  ALLOWED_DOMAIN = 'demandii.com',
  MOCK_DATA,
} = process.env;

const isProd = NODE_ENV === 'production';
const mockMode = !!MOCK_DATA && !isProd;

if (isProd) {
  const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET', 'SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON']
    .filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(cookieSession({
  name: 'st_session',
  secret: SESSION_SECRET || 'dev-only-secret',
  maxAge: 12 * 60 * 60 * 1000,
  sameSite: 'lax',
  secure: isProd,
  httpOnly: true,
}));

app.get('/healthz', (req, res) => res.send('ok'));

// ---------- Google sign-in, limited to one Workspace domain ----------
const oauth = GOOGLE_CLIENT_ID
  ? new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, `${BASE_URL}/auth/callback`)
  : null;

app.get('/auth/google', (req, res) => {
  if (!oauth) return res.status(500).send('Google sign-in is not configured.');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  res.redirect(oauth.generateAuthUrl({
    scope: ['openid', 'email', 'profile'],
    hd: ALLOWED_DOMAIN,
    prompt: 'select_account',
    state,
  }));
});

app.get('/auth/callback', async (req, res) => {
  try {
    if (!req.query.state || req.query.state !== req.session.oauthState) {
      return res.status(400).send('Sign-in expired. Go back and try again.');
    }
    req.session.oauthState = null;
    const { tokens } = await oauth.getToken(String(req.query.code || ''));
    const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    // `hd` is only set for Workspace accounts, so this rejects personal Gmail too.
    if (!p.email_verified || p.hd !== ALLOWED_DOMAIN) {
      return res.status(403).send(page403(p.email));
    }
    req.session.user = { email: p.email, name: p.name || p.email, picture: p.picture || '' };
    res.redirect('/');
  } catch (err) {
    console.error('Auth callback failed:', err.message);
    res.status(500).send('Sign-in failed. Go back and try again.');
  }
});

app.post('/auth/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

function requireUser(req, res, next) {
  if (mockMode && !req.session.user) {
    req.session.user = { email: 'preview@demandii.com', name: 'Preview User', picture: '' };
  }
  if (req.session.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
  return res.redirect('/login');
}

// All files sit in one folder (easy to upload through GitHub's website), so only
// these two front-end files are served; nothing else in the folder is reachable.
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
const ASSETS = { 'app.js': 'application/javascript', 'styles.css': 'text/css' };
app.get('/assets/:file', (req, res) => {
  const type = ASSETS[req.params.file];
  if (!type) return res.status(404).end();
  res.type(type).set('Cache-Control', 'public, max-age=3600').sendFile(path.join(__dirname, req.params.file));
});

// ---------- Who is signed in ----------
// A Google email listed on the Team tab identifies the person automatically;
// otherwise they pick their name once per login. Producers also pick the studio
// they are working in. Anyone else at the domain can choose "just viewing".
const VIEWER = '__viewer';
const MANAGERS = ['CP Trainer', 'Ops'];

function identify(req, model) {
  const email = String(req.session.user.email || '').toLowerCase();
  let t = model.team.find((x) => x.email && x.email === email);
  const auto = !!t;
  if (!t) {
    if (req.session.as === VIEWER) return { name: null, role: 'Viewer', studio: null, auto: false, canWrite: false, canManageClients: false, canSeeAnalytics: true };
    t = req.session.as && model.team.find((x) => x.name === req.session.as);
  }
  if (!t) return null;
  const isProducer = t.role === 'Producer';
  const studio = isProducer && model.studioNames.includes(req.session.studio) ? req.session.studio : null;
  return {
    name: t.name,
    role: t.role,
    homeStudio: t.studio || null,
    studio,
    auto,
    needsStudio: isProducer && !studio,
    canWrite: isProducer ? !!studio : MANAGERS.includes(t.role),
    canManageClients: MANAGERS.includes(t.role),
    canSeeAnalytics: !isProducer,
  };
}

function stamp(req, me) {
  const who = me && me.name ? `${me.name} (${req.session.user.email})` : req.session.user.email;
  return `${who}, ${sheet.todayISO()}`;
}

app.post('/api/whoami', requireUser, async (req, res) => {
  const name = String((req.body || {}).name || '');
  const studio = String((req.body || {}).studio || '');
  try {
    const model = buildModel(await sheet.readAll());
    if (name === VIEWER) {
      req.session.as = VIEWER;
      req.session.studio = null;
      return res.json({ ok: true });
    }
    const t = model.team.find((x) => x.name === name);
    if (!t) return res.status(400).json({ error: 'That name is not on the Team tab.' });
    const byEmail = model.team.find((x) => x.email && x.email === String(req.session.user.email).toLowerCase());
    if (byEmail && byEmail.name !== name) {
      return res.status(403).json({ error: `Your Google account is set up as ${byEmail.name}.` });
    }
    if (t.role === 'Producer') {
      if (!model.studioNames.includes(studio)) return res.status(400).json({ error: 'Pick the studio you are working in.' });
      req.session.studio = studio;
    } else {
      req.session.studio = null;
    }
    req.session.as = name;
    res.json({ ok: true });
  } catch (err) {
    console.error('Whoami failed:', err.message);
    res.status(502).json({ error: 'Could not read the tracker sheet.' });
  }
});

// ---------- Data API ----------
app.get('/api/data', requireUser, async (req, res) => {
  try {
    const raw = await sheet.readAll();
    const { index, sessions, team, ...model } = buildModel(raw);
    const me = identify(req, { team, studioNames: model.studioNames });
    if (!me || !me.canWrite) {
      // View-only: no buttons.
      model.studios.forEach((st) => st.clients.forEach((c) => c.sessions.forEach((s) => { s.actions = []; })));
    }
    res.json({
      ...model,
      team: team.map((t) => ({ name: t.name, role: t.role, studio: t.studio })),
      me,
      user: req.session.user,
      mock: mockMode,
    });
  } catch (err) {
    console.error('Read failed:', err.message);
    res.status(502).json({ error: 'Could not read the tracker sheet. Check the service account has access.' });
  }
});

// Advance a session one step. The server re-reads the row and checks the action
// is valid for its current state, so a stale page can't write to the wrong row.
app.post('/api/action', requireUser, async (req, res) => {
  const { row, client, session, action, date } = req.body || {};
  if (!Number.isInteger(row) || row < 2 || !ACTIONS[action]) {
    return res.status(400).json({ error: 'Bad request' });
  }
  try {
    const raw = await sheet.readAll();
    const model = buildModel(raw);
    const me = identify(req, model);
    if (!me || !me.canWrite) return res.status(403).json({ error: 'You have view-only access.' });
    const s = model.index[row];
    if (!s || s.client !== client || s.session !== session) {
      return res.status(409).json({ error: 'This session changed in the sheet. Refresh and try again.' });
    }
    if (!allowedActions(s, model.settings).includes(action)) {
      return res.status(409).json({ error: 'That step is not available for this session right now. Refresh to see its current state.' });
    }
    // Only the recording date may be backdated; every other step records today.
    let when = sheet.todayISO();
    if (action === 'recorded' && date) {
      const bad = sheet.checkRecordedDate(String(date));
      if (bad) return res.status(400).json({ error: bad });
      when = String(date);
    }
    const writes = ACTIONS[action].writes(s, when);
    writes['Last updated by'] = stamp(req, me);
    await sheet.writeCells(raw.headers, row, writes);
    console.log(`${req.session.user.email} ${action} row ${row} (${client} / ${session})`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Write failed:', err.message);
    res.status(502).json({ error: 'Could not update the tracker sheet.' });
  }
});

app.post('/api/sessions', requireUser, async (req, res) => {
  const client = String((req.body || {}).client || '').trim();
  const session = String((req.body || {}).session || '').trim().slice(0, 80);
  let studio = String((req.body || {}).studio || '').trim();
  const producer = String((req.body || {}).producer || '').trim();
  const recorded = String((req.body || {}).recorded || '').trim();
  if (recorded) {
    const bad = sheet.checkRecordedDate(recorded);
    if (bad) return res.status(400).json({ error: bad });
  }
  if (!client || !session) return res.status(400).json({ error: 'Client and session name are required.' });
  try {
    const raw = await sheet.readAll();
    const model = buildModel(raw);
    const me = identify(req, model);
    if (!me || !me.canWrite) return res.status(403).json({ error: 'You have view-only access.' });
    const studios = model.clientStudios[client];
    if (!studios) {
      return res.status(400).json({ error: 'That client is not on the Clients tab yet.' });
    }
    if (studios.length === 1) studio = studios[0];
    if (!studios.includes(studio)) {
      return res.status(400).json({ error: `Pick which studio this session is for: ${studios.join(' or ')}.` });
    }
    if (producer && !model.producers.includes(producer)) {
      return res.status(400).json({ error: 'That producer is not on the Team tab.' });
    }
    const row = await sheet.appendSession(raw, client, studio, producer, session, stamp(req, me), recorded);
    console.log(`${req.session.user.email} added session row ${row} (${client} / ${session})`);
    res.json({ ok: true, row });
  } catch (err) {
    console.error('Add session failed:', err.message);
    res.status(502).json({ error: err.userMessage || 'Could not add the session to the tracker sheet.' });
  }
});

// Tamika and Ops can add a client (or an extra studio for an existing client).
app.post('/api/clients', requireUser, async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 100);
  const studio = String(b.studio || '').trim();
  const contacts = String(b.contacts || '').trim().slice(0, 300);
  const emails = String(b.emails || '').split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean);
  try {
    const raw = await sheet.readAll();
    const model = buildModel(raw);
    const me = identify(req, model);
    if (!me || !me.canManageClients) return res.status(403).json({ error: 'Only Ops and the CP Trainer can add clients.' });
    if (!name) return res.status(400).json({ error: 'Enter the client name.' });
    if (!model.studioNames.includes(studio)) return res.status(400).json({ error: 'Pick a studio.' });
    const bad = emails.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (bad.length) return res.status(400).json({ error: `Check these emails: ${bad.join(', ')}` });
    // Match existing clients ignoring case so "Acme" and "ACME" don't become two clients.
    const existing = model.clientNames.find((n) => n.toLowerCase() === name.toLowerCase());
    const finalName = existing || name;
    if (existing && model.clientStudios[existing].includes(studio)) {
      return res.status(409).json({ error: `${existing} is already set up in ${studio}.` });
    }
    const row = await sheet.appendClient(raw, [finalName, studio, contacts, emails.join(', ')]);
    console.log(`${req.session.user.email} added client "${finalName}" in ${studio} (row ${row})`);
    res.json({ ok: true, name: finalName, addedStudio: !!existing });
  } catch (err) {
    console.error('Add client failed:', err.message);
    res.status(502).json({ error: err.userMessage || 'Could not add the client to the tracker sheet.' });
  }
});

app.get('/api/analytics', requireUser, async (req, res) => {
  try {
    const model = buildModel(await sheet.readAll());
    const me = identify(req, model);
    if (!me || !me.canSeeAnalytics) return res.status(403).json({ error: 'Analytics are for Ops, the CP Trainer and viewers.' });
    const days = [30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : null;
    res.json(buildAnalytics(model, days));
  } catch (err) {
    console.error('Analytics failed:', err.message);
    res.status(502).json({ error: 'Could not read the tracker sheet.' });
  }
});

app.get('/', requireUser, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

function page403(email) {
  const safe = String(email || '').replace(/[<>&"]/g, '');
  return `<!doctype html><meta charset="utf-8"><title>No access</title>
<body style="font-family:system-ui;padding:48px;max-width:520px">
<h1>No access</h1><p>${safe} is not a ${ALLOWED_DOMAIN} Google account.</p>
<p><a href="/auth/google">Sign in with a different account</a></p></body>`;
}

app.listen(PORT, () => {
  console.log(`Session turnaround dashboard on ${BASE_URL}${mockMode ? ' (mock data, sign-in skipped)' : ''}`);
});
