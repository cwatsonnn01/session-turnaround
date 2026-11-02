'use strict';

// One compact record per session with business-day timings for each stage.
// The browser slices these by period, studio and CP, so filters are instant.

const { parseSheetDate } = require('./model');

const DAY = 864e5;

function isoOf(t) { return t == null ? null : new Date(t).toISOString().slice(0, 10); }

function makeBusinessDays(holidayTexts) {
  const holidays = new Set(holidayTexts.map((h) => isoOf(parseSheetDate(String(h)))).filter(Boolean));
  const isWorkday = (t) => {
    const d = new Date(t).getUTCDay();
    return d !== 0 && d !== 6 && !holidays.has(isoOf(t));
  };
  // Same as the sheet's NETWORKDAYS(start, end) - 1: business days elapsed after start.
  return (start, end) => {
    if (start == null || end == null) return null;
    if (end < start) return 0;
    let n = 0;
    for (let t = start; t <= end; t += DAY) if (isWorkday(t)) n++;
    return Math.max(0, n - 1);
  };
}

function buildAnalytics(model, holidayTexts, todayIso) {
  const bd = makeBusinessDays(holidayTexts);
  const today = parseSheetDate(todayIso);
  const promise = model.settings.promise;

  const records = model.sessions.filter((s) => s.raw.Recorded).map((s) => {
    const v = s.raw;
    const d = (col) => parseSheetDate(v[col]);
    const rec = d('Recorded');
    const sent = d('Sent to client');
    const responded = d('Client responded');
    const changes = d('Changes requested (latest)') || (v['Client decision'] === 'Rework' ? responded : null);
    const returned = d('Rework returned');
    const approved = d('Approved');
    const scheduled = d('Scheduled in Planable');
    const open = !scheduled;
    return {
      client: s.client,
      studio: s.studio,
      producer: s.producer || 'No CP',
      session: s.session,
      recorded: isoOf(rec),
      flag: s.flag,
      open,
      stuck: s.stuck,
      // Production: recording to the content ready email (the 5-day promise).
      production: bd(rec, sent || today),
      productionDone: !!sent,
      onTime: sent ? bd(rec, sent) <= promise : null,
      late: sent ? bd(rec, sent) > promise : bd(rec, today) > promise,
      // Client review: content ready to the client's first reply.
      review: sent ? bd(sent, responded || today) : null,
      reviewDone: !!responded,
      // Rework: changes requested to changes sent back (latest round).
      rework: changes ? bd(changes, returned || today) : null,
      reworkRounds: s.reworkRounds || 0,
      // Scheduling: approval to scheduled in Planable.
      scheduling: approved ? bd(approved, scheduled || today) : null,
    };
  });

  return {
    today: todayIso,
    promise,
    clientTarget: model.settings.clientTarget,
    studios: model.studioNames,
    producers: model.team.filter((t) => t.role === 'Producer').map((t) => t.name),
    records,
  };
}

module.exports = { buildAnalytics, makeBusinessDays };
