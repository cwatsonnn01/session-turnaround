// Runs sheet-script.gs against an in-memory spreadsheet with fake Slack and GHL.
// node sheet-script.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SESSIONS_HEADERS = ['Client', 'Studio', 'Producer', 'Session', 'Brainstorm complete', 'Recorded', 'Sent to client',
  'Client responded', 'Client decision', 'Rework returned', 'Approved', 'Scheduled in Planable', 'Stage',
  'Internal days (recorded to sent)', 'Client wait days', 'Rework overdue', 'Days recorded to approval',
  'Past 5-day promise (recorded to sent)', 'Flag', 'Notes', 'Nudge requested', 'Last updated by', 'Chaser ID',
  'Chaser status', 'Status updated', 'Changes requested (latest)', 'Rework rounds', 'Business days since update',
  'Stuck', 'Alerts sent'];

function makeWorld(opts = {}) {
  const tabs = {
    Sessions: [SESSIONS_HEADERS.slice()],
    Events: [['Received', 'Chaser ID', 'Chaser status', 'Client', 'Session', 'Studio', 'CP email', 'Result']],
    Clients: [['Client', 'Studio', 'Contacts', 'Approver email'],
      ['Zuar', 'Studio 5', 'Whitney', 'whitney@zuar.com'],
      ['Kairos Blueprint', 'Studio 3', 'Keith', 'keith@kairos.com'],
      ['Kairos Blueprint', 'Studio 5', 'Keith', 'keith@kairos.com'],
      ['OTR Solutions', 'Studio 1', 'Two', 'a@otr.com, b@otr.com']],
    Team: [['Name', 'Google email', 'Role', 'Slack'],
      ['Dave Johnson', 'dave@demandii.com', 'Producer', ''],
      ['Tamika', 'tamika@demandii.com', 'CP Trainer', ''],
      ['Tina Moffatt', 'christina@demandii.com', 'Ops', 'U_TINA']],
    Settings: [['Setting', 'Value'], ['promise', 5], ['red', 5], ['amber', 4], ['client', 2], ['rework', 0], ['stuck', 3],
      ['summary hour', 9], ['alerts', opts.alerts || 'Yes'], ['nudge', opts.nudge || 'No']],
    Holidays: [['Date'], ['2026-12-25']],
  };
  for (let i = 0; i < 20; i++) tabs.Sessions.push(SESSIONS_HEADERS.map(() => ''));
  const props = Object.assign({ SHARED_SECRET: 's3cret', SLACK_BOT_TOKEN: 'xoxb', DASHBOARD_URL: 'https://x.test',
    CHASER_API_KEY: 'test-key', GHL_REVIEW_WEBHOOK: 'https://ghl.test/review', GHL_NUDGE_WEBHOOK: 'https://ghl.test/nudge', OPS_ALERT_EMAIL: 'christina@demandii.com' }, opts.props || {});
  const slack = []; const ghl = []; const chaser = { pages: [[]], calls: 0, fail: null };
  const sheet = (name) => ({
    getName: () => name,
    getDataRange: () => ({ getValues: () => tabs[name].map((r) => r.slice()) }),
    getRange: (r, c) => ({
      setValue: (v) => {
        while (tabs[name].length < r) tabs[name].push(tabs[name][0].map(() => ''));
        // Like Sheets: a leading apostrophe stores plain text.
        tabs[name][r - 1][c - 1] = typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v;
      },
      getValue: () => (tabs[name][r - 1] || [])[c - 1] ?? '',
    }),
    appendRow: (row) => tabs[name].push(row),
  });
  const ctx = {
    SpreadsheetApp: { getActive: () => ({ getSheetByName: (n) => sheet(n) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: (k) => { delete props[k]; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock() { return true; }, releaseLock() {} }) },
    ContentService: { createTextOutput: (t) => ({ setMimeType: () => ({ text: t }) }), MimeType: { JSON: 'json' } },
    UrlFetchApp: {
      fetch: (url, o = {}) => {
        if (url.includes('lookupByEmail')) {
          const email = decodeURIComponent(url.split('email=')[1]);
          const ok = !email.includes('nobody');
          return { getContentText: () => JSON.stringify(ok ? { ok: true, user: { id: 'U_' + email.split('@')[0].toUpperCase() } } : { ok: false, error: 'users_not_found' }) };
        }
        if (url.includes('chat.postMessage')) { slack.push(JSON.parse(o.payload)); return { getContentText: () => '{"ok":true}' }; }
        if (url.includes('tasks.list')) {
          chaser.calls++;
          assert.strictEqual(o.headers.Authorization, 'Bearer test-key');
          if (chaser.fail) return { getResponseCode: () => 401, getContentText: () => JSON.stringify({ ok: false, error: chaser.fail }) };
          const m = /cursor=(\d+)/.exec(url); const i = m ? Number(m[1]) : 0;
          const next = i + 1 < chaser.pages.length ? String(i + 1) : '';
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, tasks: chaser.pages[i], response_metadata: { next_cursor: next } }) };
        }
        ghl.push({ url, body: JSON.parse(o.payload) });
        return { getResponseCode: () => 200, getContentText: () => '{}' };
      },
    },
    Utilities: {
      formatDate: (d, tz, fmt) => {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(d).map((x) => [x.type, x.value]));
        const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday];
        if (fmt === 'yyyy-MM-dd') return `${p.year}-${p.month}-${p.day}`;
        if (fmt === 'H') return String(Number(p.hour));
        if (fmt === 'u') return String(wd);
        if (fmt === 'MMdd') return p.month + p.day;
        if (fmt === 'EEE MMM d') return d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '');
        throw new Error('fmt ' + fmt);
      },
      getUuid: () => 'uuid',
    },
    Logger: { log: () => {} },
    Date, JSON, Number, String, Math, encodeURIComponent, isNaN,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'sheet-script.gs'), 'utf8'), ctx);
  const col = (n) => SESSIONS_HEADERS.indexOf(n);
  const row = (r) => Object.fromEntries(SESSIONS_HEADERS.map((h, i) => [h, tabs.Sessions[r - 1][i]]));
  const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(Object.assign({ token: 's3cret' }, body)) } }).text);
  return { tabs, ctx, slack, ghl, props, row, col, post, chaser };
}

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };

test('bad token is refused and nothing is written', () => {
  const w = makeWorld();
  const res = JSON.parse(w.ctx.doPost({ postData: { contents: JSON.stringify({ token: 'wrong', chaser_id: 'A' }) } }).text);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(w.tabs.Events.length, 1);
});

test('Session wrapped creates the row, starts the clock and DMs the CP', () => {
  const w = makeWorld();
  const res = w.post({ chaser_id: '123', status: 'Session wrapped', client: 'zuar', session: 'Session 9', cp_email: 'Dave@demandii.com', at: '2026-11-02T15:00:00Z' });
  assert.ok(res.ok, JSON.stringify(res));
  const r = w.row(res.row);
  assert.strictEqual(res.row, 2);
  assert.strictEqual(r.Client, 'Zuar'); // name taken from the Clients tab
  assert.strictEqual(r.Studio, 'Studio 5'); // only studio for this client
  assert.strictEqual(r.Producer, 'Dave Johnson');
  assert.strictEqual(r.Recorded, '2026-11-02');
  assert.strictEqual(r['Chaser ID'], '123');
  assert.strictEqual(r.Notes, '');
  assert.strictEqual(w.slack.length, 1);
  assert.strictEqual(w.slack[0].channel, 'U_DAVE');
  assert.ok(/Countdown started/.test(w.slack[0].text) && /Mon Nov 9/.test(w.slack[0].text), w.slack[0].text);
  assert.strictEqual(w.tabs.Team[1][3], 'U_DAVE'); // Slack ID saved for next time
});

test('a repeated Session wrapped (Zapier retry) does not duplicate or re-alert', () => {
  const w = makeWorld();
  w.post({ chaser_id: '123', status: 'Session wrapped', client: 'Zuar', session: 'S', cp_email: 'dave@demandii.com', at: '2026-11-02T15:00:00Z' });
  w.post({ chaser_id: '123', status: 'Session wrapped', client: 'Zuar', session: 'S', cp_email: 'dave@demandii.com', at: '2026-11-03T15:00:00Z' });
  assert.strictEqual(w.row(3).Client, '');
  assert.strictEqual(w.row(2).Recorded, '2026-11-02');
  assert.strictEqual(w.slack.length, 1);
});

test('full journey writes each date and emails the client once through GHL', () => {
  const w = makeWorld();
  const base = { chaser_id: '77', client: 'OTR Solutions', session: 'S1', cp_email: 'dave@demandii.com' };
  w.post({ ...base, status: 'Session wrapped', at: '2026-10-13T15:00:00Z' });
  w.post({ ...base, status: 'Content ready', at: '2026-10-16T15:00:00Z' });
  w.post({ ...base, status: 'Content ready', at: '2026-10-16T16:00:00Z' }); // moved again by mistake
  w.post({ ...base, status: 'requested changes', at: '2026-10-19T15:00:00Z' });
  w.post({ ...base, status: 'changes sent back', at: '2026-10-19T20:00:00Z' });
  w.post({ ...base, status: 'requested changes', at: '2026-10-20T15:00:00Z' });
  let r = w.row(2);
  assert.strictEqual(r['Rework rounds'], 2);
  assert.strictEqual(r['Rework returned'], ''); // round 2 is open
  assert.strictEqual(r['Changes requested (latest)'], '2026-10-20');
  assert.strictEqual(r['Client responded'], '2026-10-19'); // first reply kept
  w.post({ ...base, status: 'changes sent back', at: '2026-10-20T18:00:00Z' });
  w.post({ ...base, status: 'Client approved', at: '2026-10-21T15:00:00Z' });
  w.post({ ...base, status: 'Scheduled', at: '2026-10-22T15:00:00Z' });
  r = w.row(2);
  assert.strictEqual(r.Recorded, '2026-10-13');
  assert.strictEqual(r['Sent to client'], '2026-10-16');
  assert.strictEqual(r['Client decision'], 'Rework');
  assert.strictEqual(r['Rework returned'], '2026-10-20');
  assert.strictEqual(r.Approved, '2026-10-21');
  assert.strictEqual(r['Scheduled in Planable'], '2026-10-22');
  assert.strictEqual(r['Chaser status'], 'Scheduled');
  assert.strictEqual(r['Status updated'], '2026-10-22');
  const review = w.ghl.filter((g) => g.url.endsWith('/review'));
  assert.deepStrictEqual(review.map((g) => g.body.email), ['a@otr.com', 'b@otr.com']); // both approvers, once each
  assert.strictEqual(review[0].body.producer, 'Dave Johnson');
});

test('client approved straight away records the reply as an approval', () => {
  const w = makeWorld();
  const base = { chaser_id: '5', client: 'Zuar', session: 'S', cp_email: 'dave@demandii.com' };
  w.post({ ...base, status: 'Session wrapped', at: '2026-10-26T15:00:00Z' });
  w.post({ ...base, status: 'Content ready', at: '2026-10-28T15:00:00Z' });
  w.post({ ...base, status: 'client approved', at: '2026-10-29T15:00:00Z' });
  assert.strictEqual(w.row(2)['Client responded'], '2026-10-29');
  assert.strictEqual(w.row(2)['Client decision'], 'Approved');
});

test('two-studio client uses the checklist studio; missing studio is flagged', () => {
  const w = makeWorld();
  w.post({ chaser_id: 'k1', status: 'Session wrapped', client: 'Kairos Blueprint', studio: 'Studio 3', session: 'S', cp_email: 'dave@demandii.com' });
  assert.strictEqual(w.row(2).Studio, 'Studio 3');
  assert.strictEqual(w.row(2).Notes, '');
  w.post({ chaser_id: 'k2', status: 'Session wrapped', client: 'Kairos Blueprint', session: 'S', cp_email: 'dave@demandii.com' });
  assert.strictEqual(w.row(3).Studio, '');
  assert.ok(/no studio/.test(w.row(3).Notes));
  assert.ok(w.slack.some((m) => m.channel === 'U_TINA' && /no studio/.test(m.text)), 'Ops told');
});

test('unknown client and skipped first status are flagged but still recorded', () => {
  const w = makeWorld();
  const res = w.post({ chaser_id: 'x', status: 'Content ready', client: 'Brand New Co', studio: 'Studio 2', session: 'S', cp_email: 'dave@demandii.com' });
  assert.ok(res.ok);
  const r = w.row(2);
  assert.strictEqual(r.Client, 'Brand New Co');
  assert.strictEqual(r.Recorded, '');
  assert.ok(/client not on Clients tab/.test(r.Notes) && /Session wrapped was skipped/.test(r.Notes), r.Notes);
});

test('a timestamp in the future falls back to today', () => {
  const w = makeWorld();
  w.post({ chaser_id: 'fut', status: 'Session wrapped', client: 'Zuar', session: 'S', cp_email: 'dave@demandii.com', at: '2030-01-01T00:00:00Z' });
  assert.strictEqual(w.row(2).Recorded, w.ctx.today_());
});

test('untracked status is logged and ignored', () => {
  const w = makeWorld();
  const res = w.post({ chaser_id: 'y', status: 'Archived', client: 'Zuar' });
  assert.strictEqual(res.result, 'Status not tracked');
  assert.strictEqual(w.row(2).Client, '');
});

test('formula-looking names are stored as text', () => {
  const w = makeWorld();
  w.post({ chaser_id: 'f', status: 'Session wrapped', client: 'Zuar', session: '=IMPORTXML("x")', cp_email: 'dave@demandii.com' });
  assert.strictEqual(w.row(2).Session, '=IMPORTXML("x")'); // stored literally (apostrophe stripped like Sheets does)
});

// ---- alerts: the sheet's formulas fill Flag/Stuck; here we set them by hand.
function seed(w, r, values) { Object.entries(values).forEach(([k, v]) => { w.tabs.Sessions[r - 1][w.col(k)] = v; }); }
const MON_10AM = new Date('2026-11-02T15:00:00Z'); // 10:00 Toronto
const MON_8AM = new Date('2026-11-02T13:00:00Z'); // 08:00 Toronto, before the summary hour
const SAT = new Date('2026-11-07T15:00:00Z');

test('RED alerts the CP and Tamika once', () => {
  const w = makeWorld();
  seed(w, 2, { Client: 'Zuar', Session: 'S4', Producer: 'Dave Johnson', Flag: 'RED', 'Internal days (recorded to sent)': 5, Stuck: 'No' });
  w.props.LAST_SUMMARY = '2026-11-02';
  w.ctx.runAlerts_(MON_10AM);
  w.ctx.runAlerts_(MON_10AM);
  const to = w.slack.map((m) => m.channel).sort();
  assert.deepStrictEqual(to, ['U_DAVE', 'U_TAMIKA']);
  assert.strictEqual(w.row(2)['Alerts sent'], 'red');
});

test('rework overdue alerts again on a second round', () => {
  const w = makeWorld();
  w.props.LAST_SUMMARY = '2026-11-02';
  seed(w, 2, { Client: 'Zuar', Session: 'S', Producer: 'Dave Johnson', Flag: 'RED', 'Rework overdue': 'Yes', 'Rework rounds': 1, 'Alerts sent': '' });
  w.ctx.runAlerts_(MON_10AM);
  seed(w, 2, { 'Rework rounds': 2 });
  w.ctx.runAlerts_(MON_10AM);
  assert.strictEqual(w.row(2)['Alerts sent'], 'rework1,rework2');
  assert.strictEqual(w.slack.length, 4);
});

test('AMBER DMs only the CP; stuck DMs both; nothing at weekends', () => {
  const w = makeWorld();
  w.props.LAST_SUMMARY = '2026-11-02';
  seed(w, 2, { Client: 'Zuar', Session: 'A', Producer: 'Dave Johnson', Flag: 'AMBER', Stuck: 'No' });
  seed(w, 3, { Client: 'Zuar', Session: 'B', Producer: 'Dave Johnson', Flag: 'GREEN', Stuck: 'Yes', 'Status updated': new Date('2026-10-27T12:00:00Z'), 'Business days since update': 4, 'Chaser status': 'Session wrapped' });
  w.ctx.runAlerts_(SAT);
  assert.strictEqual(w.slack.length, 0);
  w.ctx.runAlerts_(MON_10AM);
  assert.deepStrictEqual(w.slack.map((m) => m.channel), ['U_DAVE', 'U_DAVE', 'U_TAMIKA']);
  assert.ok(/Stuck/.test(w.slack[2].text) && /4 business days/.test(w.slack[2].text));
});

test('morning summary goes to Tamika once a day, after the set hour', () => {
  const w = makeWorld();
  seed(w, 2, { Client: 'Zuar', Session: 'R', Producer: 'Dave Johnson', Flag: 'RED', 'Alerts sent': 'red' });
  w.ctx.runAlerts_(MON_8AM);
  assert.strictEqual(w.slack.length, 0);
  w.ctx.runAlerts_(MON_10AM);
  w.ctx.runAlerts_(MON_10AM);
  assert.strictEqual(w.slack.length, 1);
  assert.strictEqual(w.slack[0].channel, 'U_TAMIKA');
  assert.ok(/1 active · 1 RED/.test(w.slack[0].text) && /Zuar · R/.test(w.slack[0].text), w.slack[0].text);
});

test('auto-nudge posts to GHL once, only when switched on', () => {
  const off = makeWorld();
  off.props.LAST_SUMMARY = '2026-11-02';
  seed(off, 2, { Client: 'Zuar', Studio: 'Studio 5', Session: 'L', Producer: 'Dave Johnson', Flag: 'CLIENT LATE' });
  off.ctx.runAlerts_(MON_10AM);
  assert.strictEqual(off.ghl.length, 0);
  const on = makeWorld({ nudge: 'Yes' });
  on.props.LAST_SUMMARY = '2026-11-02';
  seed(on, 2, { Client: 'Zuar', Studio: 'Studio 5', Session: 'L', Producer: 'Dave Johnson', Flag: 'CLIENT LATE' });
  on.ctx.runAlerts_(MON_10AM);
  on.ctx.runAlerts_(MON_10AM);
  assert.strictEqual(on.ghl.length, 1);
  assert.strictEqual(on.ghl[0].body.email, 'whitney@zuar.com');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(on.row(2)['Nudge requested']));
});

test('with alerts off nothing goes to Slack, but each alert is logged once', () => {
  const w = makeWorld({ alerts: 'No' });
  w.props.LAST_SUMMARY = '2026-11-02';
  seed(w, 2, { Client: 'Zuar', Session: 'S', Producer: 'Dave Johnson', Flag: 'RED' });
  w.ctx.runAlerts_(MON_10AM);
  w.ctx.runAlerts_(MON_10AM);
  assert.strictEqual(w.slack.length, 0);
  assert.strictEqual(w.tabs.Events.filter((e) => /alerts off/.test(e[7])).length, 2); // CP + Tamika, once
});

test('business days skip weekends and holidays', () => {
  const w = makeWorld();
  assert.strictEqual(w.ctx.addBusinessDays_('2026-12-21', 5, ['2026-12-25']), '2026-12-29');
  assert.strictEqual(w.ctx.addBusinessDays_('2026-11-06', 1, []), '2026-11-09');
});

// ---- Chaser polling, using the task shape from the existing churn Zap.
const task = (o) => Object.assign({
  id: 'T1', summary: 'Session 9', raw_summary: 'Session 9', custom_status_label: 'Session wrapped', status_label: 'Open',
  tags: ['Zuar', 'Studio 5'], channel: { name: 'client-zuar' }, link: 'https://chaser/T1', created_at: '2026-11-02T15:00:00Z',
  assignees: [{ email: 'dave@demandii.com' }], creator: { email: 'christina@demandii.com', display_name: 'Tina' }
}, o);
const T0 = Date.parse('2026-11-02T14:00:00Z');

test('first poll only sets the baseline', () => {
  const w = makeWorld();
  w.chaser.pages = [[task({ created_at: '2026-10-30T15:00:00Z' })]];
  const res = w.ctx.runPoll_(T0);
  assert.strictEqual(res.baseline, true);
  assert.strictEqual(w.props.CHASER_BASELINE_AT, String(T0));
  assert.strictEqual(w.row(2).Client, '');
});

test('a new task at Session wrapped becomes a row; old and non-session tasks are ignored', () => {
  const w = makeWorld();
  w.props.CHASER_BASELINE_AT = String(T0);
  w.chaser.pages = [[
    task({}),
    task({ id: 'OLD', created_at: '2026-10-20T15:00:00Z' }),                       // made before go-live
    task({ id: 'DESIGN', custom_status_label: 'In review', tags: ['Zuar'] }),      // not a session status
    task({ id: 'SKIP', custom_status_label: 'Content ready' }),                    // first seen past Session wrapped
  ]];
  const res = w.ctx.runPoll_(T0 + 3600e3);
  assert.strictEqual(res.applied, 1);
  const r = w.row(2);
  assert.strictEqual(r['Chaser ID'], 'T1');
  assert.strictEqual(r.Client, 'Zuar');
  assert.strictEqual(r.Studio, 'Studio 5');
  assert.strictEqual(r.Producer, 'Dave Johnson');
  assert.strictEqual(r.Session, 'Session 9');
  assert.ok(r.Recorded);
  assert.strictEqual(w.row(3).Client, '');
  assert.ok(w.slack.some((m) => /Countdown started/.test(m.text)));
});

test('pages are followed and unchanged tasks are not rewritten', () => {
  const w = makeWorld();
  w.props.CHASER_BASELINE_AT = String(T0);
  w.chaser.pages = [[task({ id: 'A' })], [task({ id: 'B', tags: ['OTR Solutions', 'Studio 1'] })]];
  assert.strictEqual(w.ctx.runPoll_(T0 + 1e6).applied, 2);
  assert.strictEqual(w.chaser.calls, 2);
  const events = w.tabs.Events.length;
  assert.strictEqual(w.ctx.runPoll_(T0 + 2e6).applied, 0);
  assert.strictEqual(w.tabs.Events.length, events);
});

test('moves through the statuses fill the dates and email the client once', () => {
  const w = makeWorld();
  w.props.CHASER_BASELINE_AT = String(T0);
  const step = (label) => { w.chaser.pages = [[task({ custom_status_label: label })]]; return w.ctx.runPoll_(T0 + 1e6); };
  step('Session wrapped');
  step('Content ready');
  step('Content ready');
  step('requested changes');
  step('changes sent back');
  step('client approved');
  step('scheduled');
  const r = w.row(2);
  ['Recorded', 'Sent to client', 'Client responded', 'Rework returned', 'Approved', 'Scheduled in Planable'].forEach((c) => assert.ok(r[c], c));
  assert.strictEqual(r['Rework rounds'], 1);
  assert.strictEqual(r['Chaser status'], 'scheduled');
  assert.strictEqual(w.ghl.filter((g) => g.url.endsWith('/review')).length, 1);
});

test('skipping Content ready still stops the clock, with a note and no client email', () => {
  const w = makeWorld();
  w.props.CHASER_BASELINE_AT = String(T0);
  w.chaser.pages = [[task({})]];
  w.ctx.runPoll_(T0 + 1e6);
  w.chaser.pages = [[task({ custom_status_label: 'client approved' })]];
  w.ctx.runPoll_(T0 + 2e6);
  const r = w.row(2);
  assert.ok(r['Sent to client']);
  assert.ok(/Content ready was skipped/.test(r.Notes), r.Notes);
  assert.strictEqual(w.ghl.length, 0);
});

test('client from the channel or title; studio from the title; unknown client is flagged', () => {
  const w = makeWorld();
  w.props.CHASER_BASELINE_AT = String(T0);
  w.chaser.pages = [[
    task({ id: 'C1', tags: [], channel: { name: 'kairos-blueprint' }, summary: 'Studio-3 session', raw_summary: 'Studio-3 session' }),
    task({ id: 'C2', tags: [], channel: { name: 'general' }, summary: 'OTR Solutions podcast', raw_summary: 'OTR Solutions podcast' }),
    task({ id: 'C3', tags: [], channel: { name: 'acme-corp' }, summary: 'Session 1', raw_summary: 'Session 1' }),
  ]];
  w.ctx.runPoll_(T0 + 1e6);
  assert.strictEqual(w.row(2).Client, 'Kairos Blueprint');
  assert.strictEqual(w.row(2).Studio, 'Studio 3');
  assert.strictEqual(w.row(3).Client, 'OTR Solutions');
  assert.strictEqual(w.row(3).Studio, 'Studio 1'); // its only studio
  assert.strictEqual(w.row(4).Client, 'acme-corp');
  assert.ok(/client not on Clients tab/.test(w.row(4).Notes));
});

test('API failure is logged every time but Ops is told once', () => {
  const w = makeWorld();
  w.props.CHASER_BASELINE_AT = String(T0);
  w.chaser.fail = 'invalid_auth';
  w.ctx.runPoll_(T0 + 1e6);
  w.ctx.runPoll_(T0 + 2e6);
  assert.strictEqual(w.tabs.Events.filter((e) => /Chaser check failed/.test(e[7])).length, 2);
  assert.strictEqual(w.slack.filter((m) => /Chaser check is failing/.test(m.text)).length, 1);
  w.chaser.fail = null; w.chaser.pages = [[]];
  w.ctx.runPoll_(T0 + 3e6);
  assert.strictEqual(w.props.LAST_API_ERROR_AT, undefined);
});

test('no API key: clear message, nothing written', () => {
  const w = makeWorld({ props: { CHASER_API_KEY: '' } });
  const res = w.ctx.runPoll_(T0);
  assert.strictEqual(res.ok, false);
  assert.ok(/CHASER_API_KEY/.test(res.error));
});

console.log(`\n${n} tests passed`);
