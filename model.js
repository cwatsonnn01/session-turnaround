'use strict';

// Turns the raw sheet values into what the dashboard shows. Flags, day counts and
// stages come from the sheet's own formula columns; nothing here re-derives them.

const FLAG_ORDER = ['RED', 'AMBER', 'CLIENT LATE', 'GREEN', 'NOT RECORDED', 'DONE'];

const STEPS = [
  ['Brainstorm', 'Brainstorm complete'],
  ['Recorded', 'Recorded'],
  ['Sent', 'Sent to client'],
  ['Client replied', 'Client responded'],
  ['Approved', 'Approved'],
  ['Scheduled', 'Scheduled in Planable'],
];

// Each action writes today's date (and sometimes a decision) into the session's row.
const ACTIONS = {
  brainstorm: { label: 'Brainstorm done', writes: (s, d) => ({ 'Brainstorm complete': d }) },
  recorded: { label: 'Mark recorded', writes: (s, d) => ({ Recorded: d }) },
  sent: { label: 'Mark sent', primary: true, writes: (s, d) => ({ 'Sent to client': d }) },
  approved: {
    label: 'Client approved',
    writes: (s, d) => (s.raw['Client responded']
      ? { Approved: d }
      : { 'Client responded': d, 'Client decision': 'Approved', Approved: d }),
  },
  rework: { label: 'Client wants rework', writes: (s, d) => ({ 'Client responded': d, 'Client decision': 'Rework' }) },
  reworkReturned: { label: 'Rework returned', primary: true, writes: (s, d) => ({ 'Rework returned': d }) },
  scheduled: { label: 'Mark scheduled', writes: (s, d) => ({ 'Scheduled in Planable': d }) },
  nudge: { label: 'Nudge client', primary: true, writes: (s, d) => ({ 'Nudge requested': d }) },
};

function allowedActions(s) {
  const v = s.raw;
  if (!v['Brainstorm complete'] && !v.Recorded) return ['brainstorm', 'recorded'];
  if (!v.Recorded) return ['recorded'];
  if (!v['Sent to client']) return ['sent'];
  if (!v['Client responded']) {
    const a = ['approved', 'rework'];
    if (s.flag === 'CLIENT LATE' && !v['Nudge requested']) a.unshift('nudge');
    return a;
  }
  if (v['Client decision'] === 'Rework' && !v['Rework returned']) return ['reworkReturned'];
  if (!v.Approved) return ['approved'];
  if (!v['Scheduled in Planable']) return ['scheduled'];
  return [];
}

const num = (x) => (x === '' || x == null || isNaN(Number(x)) ? null : Number(x));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function describe(s, settings) {
  const v = s.raw;
  const N = num(v['Internal days (recorded to sent)']);
  const O = num(v['Client wait days']);
  if (!v.Recorded) {
    return { clock: 'Not recorded', note: v['Brainstorm complete'] ? `Brainstorm done ${v['Brainstorm complete']}` : 'In planning' };
  }
  if (!v['Sent to client']) {
    return { clock: `Day ${N} of ${settings.promise}`, note: `Recorded ${v.Recorded}` };
  }
  if (!v['Client responded']) {
    const nudge = v['Nudge requested'] ? ` · nudged ${v['Nudge requested']}` : '';
    return { clock: `Client: ${plural(O, 'day')}`, note: `Sent ${v['Sent to client']}${nudge}` };
  }
  if (v['Client decision'] === 'Rework' && !v['Rework returned']) {
    return { clock: s.reworkOverdue ? 'Rework overdue' : 'Rework due today', note: `Feedback ${v['Client responded']}` };
  }
  if (!v.Approved) {
    return { clock: 'Awaiting sign-off', note: `Rework back ${v['Rework returned']}` };
  }
  return {
    clock: `Sent in ${plural(N, 'day')}`,
    note: v['Scheduled in Planable'] ? `Scheduled ${v['Scheduled in Planable']}` : 'Not yet in Planable',
  };
}

// Sheet dates arrive formatted as "Mon Oct 19" (no year). Take the most recent
// such date that is not more than a month in the future.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function parseSheetDate(text, today = new Date()) {
  if (!text) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
  const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})/.exec(text.replace(/^\w{3},?\s+(?=[A-Za-z]{3})/, ''));
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1].toLowerCase());
  if (mon < 0) return null;
  let y = today.getUTCFullYear();
  let t = Date.UTC(y, mon, +m[2]);
  if (t > today.getTime() + 31 * 864e5) t = Date.UTC(y - 1, mon, +m[2]);
  return t;
}

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function buildModel(raw) {
  const H = raw.headers;
  const settingsRow = (i, dflt) => num((raw.settings[i] || [])[1]) ?? dflt;
  const settings = {
    promise: settingsRow(0, 5),
    red: settingsRow(1, 5),
    amber: settingsRow(2, 4),
    clientTarget: settingsRow(3, 2),
    reworkDays: settingsRow(4, 0),
  };

  // Studios tab: Studio. Producers are not tied to a studio; each session names its own.
  const studioOrder = (raw.studios || []).map((r) => (r[0] || '').trim()).filter(Boolean);

  // Team tab: Name | Google email | Role (Producer, CP Trainer, Ops) | Home studio
  const team = (raw.team || [])
    .map((r) => ({
      name: (r[0] || '').trim(),
      email: (r[1] || '').trim().toLowerCase(),
      role: (r[2] || 'Producer').trim(),
      studio: (r[3] || '').trim(),
    }))
    .filter((t) => t.name);

  // Clients tab: Client | Studio | Contacts | Approver email. A client can have
  // one row per studio it works with, so each session carries its own studio.
  const clientStudios = {};
  for (const r of raw.clients) {
    const name = (r[0] || '').trim();
    if (!name) continue;
    const list = clientStudios[name] || (clientStudios[name] = []);
    const studio = (r[1] || '').trim();
    if (studio && !list.includes(studio)) list.push(studio);
  }

  const index = {};
  const sessions = [];
  raw.rows.forEach((r, i) => {
    const v = {};
    H.forEach((h, j) => { v[h] = (r[j] ?? '').toString().trim(); });
    if (!v.Client) return;
    const s = {
      row: i + 2,
      client: v.Client,
      session: v.Session,
      studio: v.Studio || 'No studio picked',
      producer: v.Producer || '',
      stage: v.Stage,
      flag: v.Flag || 'GREEN',
      reworkOverdue: v['Rework overdue'] === 'Yes',
      pastPromise: v['Past 5-day promise (recorded to sent)'] === 'Yes',
      internalDays: num(v['Internal days (recorded to sent)']),
      notes: v.Notes,
      recordedAt: parseSheetDate(v.Recorded),
      raw: v,
    };
    let done = 0;
    while (done < STEPS.length && v[STEPS[done][1]]) done++;
    s.stepsDone = done;
    s.steps = STEPS.map(([label, col]) => ({ label, date: v[col] || '' }));
    Object.assign(s, describe(s, settings));
    s.actions = allowedActions(s).map((k) => ({ key: k, label: ACTIONS[k].label, primary: !!ACTIONS[k].primary }));
    index[s.row] = s;
    sessions.push(s);
  });

  const extra = [...new Set(sessions.map((s) => s.studio))].filter((n) => !studioOrder.includes(n)).sort(naturalSort);
  const studios = [...studioOrder, ...extra].map((name) => {
    const mine = sessions.filter((s) => s.studio === name);
    const byClient = {};
    for (const s of mine) (byClient[s.client] = byClient[s.client] || []).push(s);
    const clients = Object.keys(byClient).sort(naturalSort).map((c) => ({
      name: c,
      sessions: byClient[c]
        .slice()
        .sort((a, b) => FLAG_ORDER.indexOf(a.flag) - FLAG_ORDER.indexOf(b.flag))
        .map(publicSession),
    }));
    const count = (f) => mine.filter((s) => s.flag === f).length;
    return {
      name,
      producers: [...new Set(mine.filter((s) => s.flag !== 'DONE' && s.producer).map((s) => s.producer))].sort(naturalSort),
      active: mine.filter((s) => s.flag !== 'DONE').length,
      red: count('RED'),
      amber: count('AMBER'),
      clientLate: count('CLIENT LATE'),
      clients,
    };
  });

  const active = sessions.filter((s) => s.flag !== 'DONE');
  const sent = sessions.filter((s) => s.raw['Sent to client'] && s.internalDays != null);
  const avg = sent.length ? (sent.reduce((t, s) => t + s.internalDays, 0) / sent.length).toFixed(1) : '–';

  const kpis = {
    active: active.length,
    studios: studios.length,
    red: sessions.filter((s) => s.flag === 'RED').length,
    amber: sessions.filter((s) => s.flag === 'AMBER').length,
    clientLate: sessions.filter((s) => s.flag === 'CLIENT LATE').length,
    pastPromise: active.filter((s) => s.pastPromise).length,
    avgInternal: avg,
  };

  const escalations = sessions.filter((s) => s.flag === 'RED').map((s) => ({
    row: s.row,
    title: `${s.client} · ${s.session}`,
    reason: s.reworkOverdue
      ? `Rework requested ${s.raw['Client responded']}, not returned.`
      : `Day ${s.internalDays} since recording, nothing sent to client.`,
    meta: [s.studio, s.producer, s.notes].filter(Boolean).join(' · '),
  }));

  const clientLate = sessions.filter((s) => s.flag === 'CLIENT LATE').map((s) => ({
    row: s.row,
    title: `${s.client} · ${s.session}`,
    reason: `Sent ${s.raw['Sent to client']}, no reply after ${plural(num(s.raw['Client wait days']), 'business day')}.`,
    meta: s.raw['Nudge requested'] ? `Nudged ${s.raw['Nudge requested']}` : 'Not nudged yet',
  }));

  return {
    asOf: raw.asOf,
    settings,
    kpis,
    studios,
    escalations,
    clientLate,
    clientNames: Object.keys(clientStudios).sort(naturalSort),
    clientStudios,
    team,
    producers: team.filter((t) => t.role === 'Producer').map((t) => t.name),
    studioNames: studioOrder,
    index,
    sessions,
  };
}

function publicSession(s) {
  const { raw, ...rest } = s;
  return rest;
}

module.exports = { buildModel, allowedActions, ACTIONS, parseSheetDate, naturalSort };
