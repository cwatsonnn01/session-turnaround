/**
 * Session Turnaround: Chaser intake and Slack alerts.
 *
 * Lives inside the Session Turnaround Tracker sheet (Extensions > Apps Script).
 *  - pollChaser: every 10 minutes, reads Chaser's tasks.list API and compares
 *    each session task's status with the sheet. A task that appears at
 *    "Session wrapped" gets a new Sessions row; later moves fill in dates.
 *  - doPost (optional): the same intake for anything that can POST updates.
 *  - checkAlerts: runs every hour. DMs the CP and the CP Trainer when a
 *    session turns AMBER, RED or stuck, sends the CP Trainer a morning
 *    summary, and (optionally) asks GHL to nudge late clients.
 *
 * Script properties (Project Settings > Script properties):
 *   CHASER_API_KEY       Chaser API key (Bearer token). Never put it in the code.
 *   SHARED_SECRET        made by setup(); only needed if something POSTs to doPost.
 *   SLACK_BOT_TOKEN      xoxb-... token of the Demandii Slack app.
 *   DASHBOARD_URL        https://session-turnaround.onrender.com
 *   GHL_REVIEW_WEBHOOK   GHL inbound webhook: "content ready" email to the client.
 *   GHL_NUDGE_WEBHOOK    GHL inbound webhook: approval reminder to the client.
 *   OPS_ALERT_EMAIL      Team-tab email of the person who fixes data problems
 *                        (unknown client, missing studio). Optional.
 *
 * Run setup() once after pasting this file.
 */

var TZ = 'America/Toronto';

// Chaser status (lower case) -> what it means for the session.
var STATUS = {
  'session wrapped': 'wrapped',
  'content ready': 'ready',
  'requested changes': 'changes',
  'changes sent back': 'returned',
  'client approved': 'approved',
  'scheduled': 'scheduled'
};

var COL = {
  client: 'Client', studio: 'Studio', producer: 'Producer', session: 'Session',
  recorded: 'Recorded', sent: 'Sent to client', responded: 'Client responded',
  decision: 'Client decision', returned: 'Rework returned', approved: 'Approved',
  scheduled: 'Scheduled in Planable', flag: 'Flag', notes: 'Notes', nudge: 'Nudge requested',
  updatedBy: 'Last updated by', chaserId: 'Chaser ID', chaserStatus: 'Chaser status',
  statusUpdated: 'Status updated', changesAt: 'Changes requested (latest)',
  rounds: 'Rework rounds', sinceUpdate: 'Business days since update', stuck: 'Stuck',
  alerts: 'Alerts sent', internalDays: 'Internal days (recorded to sent)',
  clientWait: 'Client wait days', reworkOverdue: 'Rework overdue'
};
var LAST_ROW = 300; // formula columns are filled down to here

// ---------------------------------------------------------------- web hook

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Body is not JSON' });
  }
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('SHARED_SECRET');
  if (!secret || String(body.token || '') !== secret) {
    return json_({ ok: false, error: 'Bad token' });
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var result = handleChaserEvent_(body);
    return json_(result);
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Applies one Chaser status change to the Sessions tab. Returns {ok, row, result}. */
function handleChaserEvent_(ev) {
  var ss = SpreadsheetApp.getActive();
  var chaserId = clean_(ev.chaser_id);
  var statusText = clean_(ev.status);
  var kind = STATUS[statusText.toLowerCase()];
  var client = clean_(ev.client);
  var session = clean_(ev.session);
  var studio = clean_(ev.studio);
  var cpEmail = clean_(ev.cp_email).toLowerCase();
  var day = eventDay_(ev.at);

  var log = function (result) {
    ss.getSheetByName('Events').appendRow([new Date(), chaserId, statusText, client, session, studio, cpEmail, result]);
  };

  if (!chaserId) { log('Ignored: no Chaser ID'); return { ok: false, error: 'chaser_id is required' }; }
  if (!kind) { log('Ignored: status not tracked'); return { ok: true, result: 'Status not tracked' }; }

  var t = table_(ss.getSheetByName('Sessions'));
  var r = t.find(COL.chaserId, chaserId);
  var created = false;
  var problems = [];

  var team = teamByEmail_(ss);
  var cp = team[cpEmail];

  // Studio: the checklist's field, else the client's only studio.
  var clientStudios = clientStudios_(ss)[client.toLowerCase()];
  if (!clientStudios) problems.push('client not on Clients tab');
  if (!studio && clientStudios && clientStudios.studios.length === 1) studio = clientStudios.studios[0];
  if (studio && clientStudios && clientStudios.studios.indexOf(studio) < 0) problems.push(studio + ' not set up for this client');
  if (!studio) problems.push('no studio');
  if (cpEmail && !cp) problems.push('CP email not on Team tab');

  if (r < 0) {
    r = t.firstEmpty(COL.client);
    if (r < 0 || r > LAST_ROW) { log('Error: Sessions tab is full'); return { ok: false, error: 'Sessions tab is full' }; }
    created = true;
    t.set(r, COL.chaserId, "'" + chaserId);
    t.set(r, COL.client, safe_(clientStudios ? clientStudios.name : client || '(no client)'));
    t.set(r, COL.session, safe_(session || '(untitled)'));
    if (studio) t.set(r, COL.studio, safe_(studio));
    t.set(r, COL.producer, safe_(cp ? cp.name : cpEmail));
    if (kind !== 'wrapped') problems.push('first update was "' + statusText + '", so Session wrapped was skipped');
  } else {
    // Keep names current if they changed in Chaser.
    if (session) t.set(r, COL.session, safe_(session));
    if (cp) t.set(r, COL.producer, cp.name);
    if (studio && !t.get(r, COL.studio)) t.set(r, COL.studio, safe_(studio));
  }

  var setOnce = function (col) { if (!t.get(r, col)) { t.set(r, col, day); return true; } return false; };
  var startedClock = false;

  // A checklist that skips "Content ready" in Chaser would leave the clock running
  // forever. Assume it was sent today, note it, and don't email the client.
  if (kind !== 'wrapped' && kind !== 'ready' && !t.get(r, COL.sent)) {
    t.set(r, COL.sent, day);
    problems.push('Content ready was skipped in Chaser, so its date was set to ' + day + ' (no client email sent)');
  }

  switch (kind) {
    case 'wrapped':
      startedClock = setOnce(COL.recorded);
      break;
    case 'ready':
      // Email the client only the first time, even if the card is moved back and forth.
      if (setOnce(COL.sent)) sendReviewEmail_(ss, r, t);
      break;
    case 'changes':
      // Each round of changes restarts the same-day rework clock.
      setOnce(COL.responded);
      t.set(r, COL.decision, 'Rework');
      t.set(r, COL.changesAt, day);
      t.set(r, COL.returned, '');
      t.set(r, COL.rounds, (Number(t.get(r, COL.rounds)) || 0) + 1);
      break;
    case 'returned':
      t.set(r, COL.returned, day);
      break;
    case 'approved':
      if (!t.get(r, COL.responded)) { t.set(r, COL.responded, day); t.set(r, COL.decision, 'Approved'); }
      setOnce(COL.approved);
      break;
    case 'scheduled':
      setOnce(COL.scheduled);
      break;
  }
  t.set(r, COL.chaserStatus, safe_(statusText));
  t.set(r, COL.statusUpdated, day);
  t.set(r, COL.updatedBy, 'Chaser (' + (cp ? cp.name : cpEmail || 'unknown CP') + '), ' + day);
  if (problems.length) t.set(r, COL.notes, safe_('Check: ' + problems.join('; ')));
  t.flush();

  if (startedClock && cp) {
    var due = addBusinessDays_(day, setting_(ss, 2, 5), holidays_(ss));
    dm_(ss, cp, 'Countdown started: get that content going. *' + t.get(r, COL.client) + ' · ' + t.get(r, COL.session) +
      '*' + (studio ? ' (' + studio + ')' : '') + '. Content ready email due by *' + pretty_(due) + '*.' + link_());
  }
  if (problems.length) notifyOps_(ss, 'Chaser update needs a look: ' + client + ' · ' + session + ' (' + statusText + '): ' + problems.join('; '));

  var result = (created ? 'Created row ' : 'Updated row ') + r + ': ' + kind + (problems.length ? ' (' + problems.join('; ') + ')' : '');
  log(result);
  return { ok: true, row: r, result: result };
}

// ---------------------------------------------------------------- alerts

/** Hourly. Sends each alert once per session, tracked in "Alerts sent". */
function checkAlerts() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    runAlerts_(new Date());
  } finally {
    lock.releaseLock();
  }
}

function runAlerts_(now) {
  var ss = SpreadsheetApp.getActive();
  if (!isBusinessHour_(now, holidays_(ss))) return;
  var t = table_(ss.getSheetByName('Sessions'));
  var team = teamByName_(ss);
  var trainers = Object.keys(team).map(function (k) { return team[k]; }).filter(function (p) { return p.role === 'CP Trainer'; });
  var nudgeOn = setting_(ss, 10, 'No') === 'Yes';

  for (var r = 2; r <= t.lastRow(); r++) {
    var client = t.get(r, COL.client);
    var flag = t.get(r, COL.flag);
    if (!client || !flag || flag === 'DONE' || flag === 'NOT RECORDED') continue;
    var before = String(t.get(r, COL.alerts) || '');
    var sent = before.split(',').filter(String);
    var cp = team[t.get(r, COL.producer)];
    var name = client + ' · ' + t.get(r, COL.session);
    var label = '*' + name + '*' + (cp ? ' (' + cp.name + ')' : '');
    var add = function (key) { sent.push(key); };
    var once = function (key) { return sent.indexOf(key) < 0; };

    if (flag === 'AMBER' && once('amber')) {
      if (cp) dm_(ss, cp, 'Heads up: *' + name + '* is on day ' + t.get(r, COL.internalDays) + '. The content ready email is due tomorrow.' + link_());
      add('amber');
    }
    if (flag === 'RED') {
      var rework = t.get(r, COL.reworkOverdue) === 'Yes';
      var key = rework ? 'rework' + (t.get(r, COL.rounds) || 1) : 'red';
      if (once(key)) {
        var why = rework ? 'requested changes have not been sent back the same day' : 'day ' + t.get(r, COL.internalDays) + ' and the content ready email has not gone out';
        if (cp) dm_(ss, cp, 'RED: *' + name + '*: ' + why + '. Tamika has been told.' + link_());
        trainers.forEach(function (tr) { dm_(ss, tr, 'RED: ' + label + ': ' + why + '.' + link_()); });
        add(key);
      }
    }
    if (t.get(r, COL.stuck) === 'Yes') {
      var since = t.get(r, COL.statusUpdated);
      var skey = 'stuck' + (since instanceof Date ? Utilities.formatDate(since, TZ, 'MMdd') : '');
      if (once(skey)) {
        var msg = 'Stuck: ' + label + ' has had no Chaser update for ' + t.get(r, COL.sinceUpdate) +
          ' business days (status: ' + (t.get(r, COL.chaserStatus) || 'unknown') + ').';
        if (cp) dm_(ss, cp, msg + ' Move it in Chaser if it has progressed.' + link_());
        trainers.forEach(function (tr) { dm_(ss, tr, msg + link_()); });
        add(skey);
      }
    }
    if (flag === 'CLIENT LATE' && nudgeOn && !t.get(r, COL.nudge)) {
      if (sendNudge_(ss, r, t)) t.set(r, COL.nudge, today_());
    }
    if (sent.join(',') !== before) t.set(r, COL.alerts, sent.join(','));
  }
  t.flush();
  maybeDailySummary_(ss, t, trainers, now);
}

function maybeDailySummary_(ss, t, trainers, now) {
  var hour = Number(Utilities.formatDate(now, TZ, 'H'));
  var today = today_();
  var props = PropertiesService.getScriptProperties();
  if (hour < setting_(ss, 8, 9) || props.getProperty('LAST_SUMMARY') === today) return;
  var red = [], stuck = [], late = [], amber = 0, active = 0;
  for (var r = 2; r <= t.lastRow(); r++) {
    var flag = t.get(r, COL.flag);
    if (!t.get(r, COL.client) || !flag || flag === 'DONE' || flag === 'NOT RECORDED') continue;
    active++;
    var line = '• ' + t.get(r, COL.client) + ' · ' + t.get(r, COL.session) + ' (' + (t.get(r, COL.producer) || 'no CP') + ')';
    if (flag === 'RED') red.push(line);
    if (flag === 'AMBER') amber++;
    if (flag === 'CLIENT LATE') late.push(line);
    if (t.get(r, COL.stuck) === 'Yes') stuck.push(line + ', ' + t.get(r, COL.sinceUpdate) + ' days');
  }
  var text = '*Session turnaround, ' + pretty_(today) + '*\n' + active + ' active · ' + red.length + ' RED · ' + amber +
    ' AMBER · ' + stuck.length + ' stuck · ' + late.length + ' waiting on clients' +
    (red.length ? '\n\n*RED*\n' + red.join('\n') : '') +
    (stuck.length ? '\n\n*Stuck*\n' + stuck.join('\n') : '') +
    (late.length ? '\n\n*Waiting on clients*\n' + late.join('\n') : '') +
    (!red.length && !stuck.length ? '\n\nNothing needs you this morning.' : '') + link_();
  trainers.forEach(function (tr) { dm_(ss, tr, text); });
  props.setProperty('LAST_SUMMARY', today);
}

// ---------------------------------------------------------------- GHL

function approverInfo_(ss, r, t) {
  var key = String(t.get(r, COL.client)).toLowerCase();
  var studio = t.get(r, COL.studio);
  var rows = ss.getSheetByName('Clients').getDataRange().getValues().slice(1)
    .filter(function (c) { return String(c[0]).trim().toLowerCase() === key; });
  // Prefer the approvers listed for this studio; fall back to any row for the client.
  var same = rows.filter(function (c) { return String(c[1]).trim() === studio && String(c[3] || '').trim(); });
  var emails = [];
  (same.length ? same : rows).forEach(function (c) {
    String(c[3] || '').split(/[,;\s]+/).filter(String).forEach(function (e) { if (emails.indexOf(e) < 0) emails.push(e); });
  });
  return { client: t.get(r, COL.client), session: t.get(r, COL.session), producer: t.get(r, COL.producer), studio: studio, emails: emails };
}

function postGhl_(ss, prop, info, what) {
  var url = PropertiesService.getScriptProperties().getProperty(prop);
  if (!url) return false;
  if (!info.emails.length) { notifyOps_(ss, 'No approver email for ' + info.client + ', so the ' + what + ' was not sent.'); return false; }
  var ok = true;
  info.emails.forEach(function (email) {
    var res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ email: email, client: info.client, session: info.session, producer: info.producer, studio: info.studio })
    });
    if (res.getResponseCode() >= 300) { ok = false; notifyOps_(ss, 'GHL ' + what + ' failed for ' + email + ' (' + res.getResponseCode() + ').'); }
  });
  return ok;
}

function sendReviewEmail_(ss, r, t) { return postGhl_(ss, 'GHL_REVIEW_WEBHOOK', approverInfo_(ss, r, t), 'content ready email'); }
function sendNudge_(ss, r, t) { return postGhl_(ss, 'GHL_NUDGE_WEBHOOK', approverInfo_(ss, r, t), 'approval reminder'); }

// ---------------------------------------------------------------- Slack

function dm_(ss, person, text) {
  var token = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
  var on = setting_(ss, 9, 'No') === 'Yes';
  if (!on || !token) {
    ss.getSheetByName('Events').appendRow([new Date(), '', '', '', '', '', person.email || person.name, 'Alert not sent (alerts off): ' + text.slice(0, 200)]);
    return;
  }
  var id = slackId_(ss, person, token);
  if (!id) return;
  var res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post', contentType: 'application/json; charset=utf-8', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ channel: id, text: text, unfurl_links: false })
  });
  var out = JSON.parse(res.getContentText() || '{}');
  if (!out.ok) ss.getSheetByName('Events').appendRow([new Date(), '', '', '', '', '', person.email, 'Slack error: ' + out.error]);
}

/** Slack member ID from the Team tab, looked up by email the first time and saved. */
function slackId_(ss, person, token) {
  if (person.slackId) return person.slackId;
  if (!person.email) return '';
  var res = UrlFetchApp.fetch('https://slack.com/api/users.lookupByEmail?email=' + encodeURIComponent(person.email), {
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
  });
  var out = JSON.parse(res.getContentText() || '{}');
  if (!out.ok) {
    ss.getSheetByName('Events').appendRow([new Date(), '', '', '', '', '', person.email, 'Slack lookup failed: ' + out.error]);
    return '';
  }
  person.slackId = out.user.id;
  ss.getSheetByName('Team').getRange(person.row, 4).setValue(out.user.id);
  return out.user.id;
}

function notifyOps_(ss, text) {
  ss.getSheetByName('Events').appendRow([new Date(), '', '', '', '', '', '', 'Ops: ' + text.slice(0, 300)]);
  var email = String(PropertiesService.getScriptProperties().getProperty('OPS_ALERT_EMAIL') || '').toLowerCase();
  var person = email && teamByEmail_(ss)[email];
  if (person) dm_(ss, person, text);
}

function link_() {
  var url = PropertiesService.getScriptProperties().getProperty('DASHBOARD_URL');
  return url ? '\n<' + url + '|Open the dashboard>' : '';
}

// ---------------------------------------------------------------- sheet helpers

/** Column-by-header access to a tab, with writes batched until flush(). */
function table_(sheet) {
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var pending = [];
  var idx = function (name) {
    var i = headers.indexOf(name);
    if (i < 0) throw new Error('Column "' + name + '" not found on ' + sheet.getName());
    return i;
  };
  return {
    lastRow: function () { return values.length; },
    get: function (r, name) { var row = values[r - 1]; return row ? row[idx(name)] : ''; },
    set: function (r, name, v) {
      while (values.length < r) values.push(headers.map(function () { return ''; }));
      values[r - 1][idx(name)] = v;
      pending.push([r, idx(name) + 1, v]);
    },
    find: function (name, v) {
      var i = idx(name);
      for (var r = 2; r <= values.length; r++) if (String(values[r - 1][i]).trim() === v) return r;
      return -1;
    },
    firstEmpty: function (name) {
      var i = idx(name);
      for (var r = 2; r <= values.length; r++) if (!String(values[r - 1][i]).trim()) return r;
      return values.length + 1;
    },
    flush: function () {
      pending.forEach(function (p) { sheet.getRange(p[0], p[1]).setValue(p[2]); });
      pending = [];
    }
  };
}

function teamRows_(ss) {
  return ss.getSheetByName('Team').getDataRange().getValues().slice(1).map(function (r, i) {
    return { name: String(r[0]).trim(), email: String(r[1]).trim().toLowerCase(), role: String(r[2]).trim(), slackId: String(r[3] || '').trim(), row: i + 2 };
  }).filter(function (p) { return p.name; });
}
function teamByEmail_(ss) { var m = {}; teamRows_(ss).forEach(function (p) { if (p.email) m[p.email] = p; }); return m; }
function teamByName_(ss) { var m = {}; teamRows_(ss).forEach(function (p) { m[p.name] = p; }); return m; }

function clientStudios_(ss) {
  var m = {};
  ss.getSheetByName('Clients').getDataRange().getValues().slice(1).forEach(function (r) {
    var name = String(r[0]).trim();
    if (!name) return;
    var k = name.toLowerCase();
    m[k] = m[k] || { name: name, studios: [] };
    var s = String(r[1]).trim();
    if (s && m[k].studios.indexOf(s) < 0) m[k].studios.push(s);
  });
  return m;
}

/** Settings tab, column B, by row number. */
function setting_(ss, row, fallback) {
  var v = ss.getSheetByName('Settings').getRange(row, 2).getValue();
  if (v === '' || v === null) return fallback;
  return typeof fallback === 'number' ? Number(v) : String(v).trim();
}

function holidays_(ss) {
  return ss.getSheetByName('Holidays').getDataRange().getValues().slice(1)
    .map(function (r) { return r[0] instanceof Date ? Utilities.formatDate(r[0], TZ, 'yyyy-MM-dd') : String(r[0]).trim(); })
    .filter(String);
}

// ---------------------------------------------------------------- dates

function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }

/** The Toronto calendar day of the event (ISO date string), defaulting to today. */
function eventDay_(at) {
  if (at) {
    var d = new Date(at);
    if (!isNaN(d.getTime()) && d.getTime() <= Date.now() + 864e5) return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
  }
  return today_();
}

function addBusinessDays_(iso, n, holidays) {
  var d = new Date(iso + 'T12:00:00Z');
  while (n > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    var s = d.toISOString().slice(0, 10);
    var wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6 && holidays.indexOf(s) < 0) n--;
  }
  return d.toISOString().slice(0, 10);
}

function isBusinessHour_(now, holidays) {
  var day = Utilities.formatDate(now, TZ, 'u'); // 1 = Monday ... 7 = Sunday
  var hour = Number(Utilities.formatDate(now, TZ, 'H'));
  return day < 6 && hour >= 8 && hour < 18 && holidays.indexOf(Utilities.formatDate(now, TZ, 'yyyy-MM-dd')) < 0;
}

function pretty_(iso) {
  return Utilities.formatDate(new Date(iso + 'T12:00:00Z'), 'UTC', 'EEE MMM d');
}

function clean_(v) { return String(v == null ? '' : v).trim(); }
/** Text that starts like a formula is stored as plain text. */
function safe_(v) { return /^[=+\-@]/.test(String(v)) ? "'" + v : v; }

// ---------------------------------------------------------------- setup

/** Run once from the editor: turns on the Chaser check (every 10 min) and the hourly alerts. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SHARED_SECRET')) props.setProperty('SHARED_SECRET', Utilities.getUuid());
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'checkAlerts' || tr.getHandlerFunction() === 'pollChaser') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('checkAlerts').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('pollChaser').timeBased().everyMinutes(10).create();
  Logger.log(props.getProperty('CHASER_API_KEY') ? 'Chaser check (every 10 min) and hourly alerts are on.'
    : 'Alerts are on, but CHASER_API_KEY is missing: add it in Project Settings > Script properties.');
}

/** Run from the editor to try the intake without Zapier. Writes a TEST row. */
function testChaserEvent() {
  var res = handleChaserEvent_({
    chaser_id: 'TEST-1', status: 'Session wrapped', client: 'Zuar', session: 'TEST session',
    studio: 'Studio 5', cp_email: 'dave@demandii.com'
  });
  Logger.log(JSON.stringify(res));
}

// ---------------------------------------------------------------- Chaser polling

var BASELINE_PROP = 'CHASER_BASELINE_AT';

/** Every 10 minutes. Reads all Chaser tasks and applies any session status changes. */
function pollChaser() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(60000)) return; // the previous run is still going
  try {
    return runPoll_(Date.now());
  } finally {
    lock.releaseLock();
  }
}

function runPoll_(now) {
  var ss = SpreadsheetApp.getActive();
  var props = PropertiesService.getScriptProperties();
  var tasks;
  try {
    tasks = fetchChaserTasks_();
  } catch (err) {
    apiProblem_(ss, String(err.message || err), now);
    return { ok: false, error: String(err.message || err) };
  }
  props.deleteProperty('LAST_API_ERROR_AT');

  // First run: only sessions created from now on are tracked.
  var baseline = Number(props.getProperty(BASELINE_PROP));
  if (!baseline) {
    props.setProperty(BASELINE_PROP, String(now));
    ss.getSheetByName('Events').appendRow([new Date(), '', '', '', '', '', '', 'Chaser connected: ' + tasks.length +
      ' tasks read. Sessions created from now on will be tracked.']);
    return { ok: true, baseline: true, tasks: tasks.length };
  }

  var t = table_(ss.getSheetByName('Sessions'));
  var tracked = {};
  for (var r = 2; r <= t.lastRow(); r++) {
    var id = String(t.get(r, COL.chaserId) || '').trim();
    if (id) tracked[id] = String(t.get(r, COL.chaserStatus) || '').trim().toLowerCase();
  }
  var ctx = matchContext_(ss);
  var applied = 0;
  tasks.forEach(function (task) {
    var label = clean_(task.custom_status_label || task.status_label);
    var kind = STATUS[label.toLowerCase()];
    if (!kind) return;
    var id = String(task.id);
    if (tracked.hasOwnProperty(id)) {
      if (tracked[id] === label.toLowerCase()) return; // no change
    } else {
      // New sessions start at "Session wrapped" on a task made after the baseline.
      var created = Date.parse(task.created_at) || 0;
      if (kind !== 'wrapped' || created < baseline - 5 * 60 * 1000) return;
    }
    handleChaserEvent_(chaserEvent_(task, label, ctx));
    applied++;
  });
  return { ok: true, tasks: tasks.length, applied: applied };
}

function fetchChaserTasks_() {
  var key = PropertiesService.getScriptProperties().getProperty('CHASER_API_KEY');
  if (!key) throw new Error('CHASER_API_KEY is not set in Script properties');
  var base = 'https://api.trychaser.com/v2/tasks.list';
  var tasks = [], cursor = null, pages = 0;
  do {
    var url = base + '?include_completed=true&limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    var res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + key }, muteHttpExceptions: true });
    var body = {};
    try { body = JSON.parse(res.getContentText() || '{}'); } catch (e) { body = {}; }
    if (res.getResponseCode() >= 300 || body.ok === false) {
      throw new Error('Chaser API ' + res.getResponseCode() + ': ' + String(body.error || res.getContentText()).slice(0, 200));
    }
    tasks = tasks.concat(body.tasks || []);
    cursor = (body.response_metadata && body.response_metadata.next_cursor) || null;
    pages++;
  } while (cursor && pages < 200);
  return tasks;
}

/** Logs every failure; tells Ops at most once every 2 hours. */
function apiProblem_(ss, message, now) {
  ss.getSheetByName('Events').appendRow([new Date(), '', '', '', '', '', '', 'Chaser check failed: ' + message]);
  var props = PropertiesService.getScriptProperties();
  var last = Number(props.getProperty('LAST_API_ERROR_AT')) || 0;
  if (now - last > 2 * 3600 * 1000) {
    props.setProperty('LAST_API_ERROR_AT', String(now));
    notifyOps_(ss, 'The Chaser check is failing, so sessions are not updating: ' + message);
  }
}

// --- working out client, studio and CP from a Chaser task

function norm_(s) { return ' ' + String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' '; }

function matchContext_(ss) {
  var clients = clientStudios_(ss);
  var names = Object.keys(clients).map(function (k) { return clients[k].name; })
    .sort(function (a, b) { return b.length - a.length; }); // longest first: "OTR Solutions" before "OTR"
  return { clients: clients, names: names, team: teamRows_(ss) };
}

/** Tags first, then the Slack channel, then the task title. */
function taskTexts_(task) {
  return [(task.tags || []).join(' | '), task.channel ? task.channel.name : '', task.raw_summary || task.summary || ''];
}

function findClient_(task, ctx) {
  var texts = taskTexts_(task);
  for (var i = 0; i < texts.length; i++) {
    var hay = norm_(texts[i]);
    for (var j = 0; j < ctx.names.length; j++) {
      var n = norm_(ctx.names[j]);
      if (n.trim() && hay.indexOf(n) >= 0) return ctx.names[j];
    }
  }
  return '';
}

function findStudio_(task) {
  var texts = taskTexts_(task);
  for (var i = 0; i < texts.length; i++) {
    var m = /studio\s*[-_#]?\s*(\d+)/i.exec(texts[i]);
    if (m) return 'Studio ' + Number(m[1]);
  }
  return '';
}

/** The assigned CP on the Team tab; otherwise any listed team member; otherwise the first assignee. */
function findCp_(task, ctx) {
  var emails = (task.assignees || []).map(function (a) { return String(a.email || '').toLowerCase(); }).filter(String);
  if (task.creator && task.creator.email) emails.push(String(task.creator.email).toLowerCase());
  var byEmail = {};
  ctx.team.forEach(function (p) { if (p.email) byEmail[p.email] = p; });
  var producer = emails.filter(function (e) { return byEmail[e] && byEmail[e].role === 'Producer'; })[0];
  return producer || emails.filter(function (e) { return byEmail[e]; })[0] || emails[0] || '';
}

function chaserEvent_(task, label, ctx) {
  var client = findClient_(task, ctx);
  return {
    chaser_id: String(task.id),
    status: label,
    client: client || (task.channel && task.channel.name) || '',
    session: clean_(task.raw_summary || task.summary).slice(0, 120),
    studio: findStudio_(task),
    cp_email: findCp_(task, ctx)
  };
}

/** Run from the editor: shows what the script would track, without changing anything. */
function previewChaser() {
  var ss = SpreadsheetApp.getActive();
  var tasks = fetchChaserTasks_();
  var ctx = matchContext_(ss);
  var lines = [];
  tasks.forEach(function (task) {
    var label = clean_(task.custom_status_label || task.status_label);
    if (!STATUS[label.toLowerCase()]) return;
    var ev = chaserEvent_(task, label, ctx);
    lines.push([label, ev.session, 'client: ' + (findClient_(task, ctx) || 'NOT FOUND (' + ev.client + ')'),
      'studio: ' + (ev.studio || 'NOT FOUND'), 'CP: ' + (ev.cp_email || 'NOT FOUND')].join(' | '));
  });
  Logger.log(tasks.length + ' Chaser tasks read, ' + lines.length + ' with a session status:\n' + lines.join('\n'));
}
