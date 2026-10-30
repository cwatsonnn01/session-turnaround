'use strict';

// Turnaround analytics by studio, by content producer and by client.
// Works from the same session list as the board; the window filters on the
// recording date. Open flags (RED, AMBER, CLIENT LATE) are always current.

const { naturalSort } = require('./model');

const num = (x) => (x === '' || x == null || isNaN(Number(x)) ? null : Number(x));
const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);

function stats(list, promise) {
  const sent = list.filter((s) => s.raw['Sent to client'] && s.internalDays != null);
  const days = sent.map((s) => s.internalDays);
  const onTime = sent.filter((s) => s.internalDays <= promise).length;
  const responded = list.filter((s) => s.raw['Client responded']);
  const waits = responded.map((s) => num(s.raw['Client wait days'])).filter((x) => x != null);
  const rework = responded.filter((s) => s.raw['Client decision'] === 'Rework').length;
  const flag = (f) => list.filter((s) => s.flag === f).length;
  return {
    recorded: list.filter((s) => s.raw.Recorded).length,
    sent: sent.length,
    onTimePct: pct(onTime, sent.length),
    late: sent.length - onTime,
    avgDays: round1(avg(days)),
    medianDays: round1(median(days)),
    slowestDays: days.length ? Math.max(...days) : null,
    red: flag('RED'),
    amber: flag('AMBER'),
    clientLate: flag('CLIENT LATE'),
    waitingOnClient: list.filter((s) => s.raw['Sent to client'] && !s.raw['Client responded']).length,
    avgClientWait: round1(avg(waits)),
    reworkPct: pct(rework, responded.length),
    clientsAffected: new Set(list.filter(isProblem).map((s) => s.client)).size,
  };
}

function isProblem(s) {
  return s.pastPromise || s.flag === 'RED' || s.flag === 'AMBER' || s.flag === 'CLIENT LATE';
}

function buildAnalytics(model, days, now = Date.now()) {
  const promise = model.settings.promise;
  const cutoff = days ? now - days * 864e5 : null;
  // Open sessions always count; finished ones only if recorded inside the window.
  const inWindow = model.sessions.filter((s) =>
    s.flag !== 'DONE' || !cutoff || (s.recordedAt != null && s.recordedAt >= cutoff));

  const studioNames = [...new Set([...model.studioNames, ...inWindow.map((s) => s.studio)])];
  const byStudio = studioNames.map((name) => {
    const list = inWindow.filter((s) => s.studio === name);
    return { name, producers: [...new Set(list.map((s) => s.producer).filter(Boolean))].sort(naturalSort), ...stats(list, promise) };
  });

  const teamProducers = model.team.filter((t) => t.role === 'Producer');
  const producerNames = [...new Set([...teamProducers.map((t) => t.name), ...inWindow.map((s) => s.producer).filter(Boolean)])];
  const byProducer = producerNames.map((name) => {
    const list = inWindow.filter((s) => s.producer === name);
    const t = teamProducers.find((x) => x.name === name);
    return { name, studio: (t && t.studio) || '', ...stats(list, promise) };
  }).sort((a, b) => (b.sent - a.sent) || naturalSort(a.name, b.name));

  const byClient = {};
  for (const s of inWindow.filter(isProblem)) {
    const c = byClient[s.client] || (byClient[s.client] = {
      name: s.client, studios: new Set(), producers: new Set(), late: 0, open: [], slowestDays: 0,
    });
    c.studios.add(s.studio);
    if (s.producer) c.producers.add(s.producer);
    if (s.pastPromise) c.late += 1;
    if (s.flag !== 'DONE' && s.flag !== 'GREEN') c.open.push({ session: s.session, flag: s.flag, clock: s.clock });
    if (s.internalDays != null) c.slowestDays = Math.max(c.slowestDays, s.internalDays);
  }
  const severity = (c) => c.open.filter((o) => o.flag === 'RED').length * 100 + c.late * 10 + c.open.length;
  const clients = Object.values(byClient)
    .map((c) => ({ ...c, studios: [...c.studios].sort(naturalSort), producers: [...c.producers].sort(naturalSort) }))
    .sort((a, b) => severity(b) - severity(a) || naturalSort(a.name, b.name));

  return {
    window: days ? `Last ${days} days` : 'All time',
    days: days || null,
    promise,
    overall: stats(inWindow, promise),
    byStudio,
    byProducer,
    clients,
  };
}

module.exports = { buildAnalytics };
