(function () {
  'use strict';

  var state = {
    data: null, view: 'board', studio: 'All studios', flagged: false, showDone: false,
    busy: false, defaulted: false, period: '30', anStudio: 'all', anCp: 'all', analytics: null
  };
  var FLAGGED = { 'RED': 1, 'AMBER': 1, 'CLIENT LATE': 1 };

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function chipClass(flag) { return 'chip chip-' + String(flag).replace(/\s+/g, '-'); }
  function dash(v, suffix) { return v == null ? '–' : v + (suffix || ''); }

  function toast(msg, isError) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' is-error' : '');
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, isError ? 6000 : 3000);
  }

  function api(path, opts) {
    return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' }, opts || {}))
      .then(function (r) {
        if (r.status === 401) { window.location.href = '/login'; throw new Error('Signed out'); }
        return r.json().then(function (body) {
          if (!r.ok) throw new Error(body.error || 'Something went wrong');
          return body;
        });
      });
  }

  function load() {
    return api('/api/data').then(function (d) {
      state.data = d;
      var me = d.me;
      if (!state.defaulted) {
        state.defaulted = true;
        state.view = me.role === 'Viewer' ? 'analytics' : 'board';
      }
      render();
      if (state.view === 'analytics') loadAnalytics();
    }).catch(function (e) {
      $('studios').innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    });
  }

  function loadAnalytics() {
    return api('/api/analytics').then(function (a) {
      state.analytics = a;
      renderAnalytics();
    }).catch(function (e) { toast(e.message, true); });
  }

  // ---------- Rendering ----------
  function render() {
    var d = state.data, me = d.me;
    $('user-name').textContent = me.role === 'Viewer' ? 'Viewing as ' + d.user.name : me.name + ' · ' + (me.role === 'Producer' ? 'CP' : me.role);
    $('mock-banner').hidden = !d.mock;
    $('readonly-banner').hidden = me.canWrite;
    $('readonly-banner').textContent = me.ownOnly
      ? 'Your sessions. They update when you move the checklist in Chaser, so there is nothing to log here.'
      : 'View only. Sessions update from Chaser.';
    $('views').hidden = !me.canSeeAnalytics;
    $('add-session').hidden = !me.canWrite;
    $('new-client').hidden = !me.canManageClients;
    if (!me.canSeeAnalytics) state.view = 'board';
    Array.prototype.forEach.call(document.querySelectorAll('#views [data-view]'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
    });
    $('board-view').hidden = state.view !== 'board';
    $('analytics-view').hidden = state.view !== 'analytics';

    $('board-title').textContent = me.ownOnly ? 'Your sessions' : 'Is every session on the clock?';
    $('esc-title').textContent = me.ownOnly ? 'Needs you now' : 'Needs Tamika';
    $('esc-sub').textContent = me.ownOnly ? 'RED, or no Chaser update for too long. Tamika sees these too.' : 'RED, or no Chaser update for too long.';
    $('as-of').textContent = 'As of ' + d.asOf + ' · ' + d.settings.promise +
      '-business-day promise, end of recording to client inbox';

    renderFilters(d);
    renderKpis(d);
    renderStudios(d);
    renderSide(d);
  }

  function renderFilters(d) {
    var names = ['All studios'].concat(d.studios.map(function (s) { return s.name; }));
    $('studio-filters').innerHTML = names.map(function (n) {
      return '<button type="button" class="pill" data-studio="' + esc(n) + '" aria-pressed="' + (state.studio === n) + '">' + esc(n) + '</button>';
    }).join('');
    $('flagged-toggle').setAttribute('aria-pressed', String(state.flagged));
    $('done-toggle').setAttribute('aria-pressed', String(state.showDone));
  }

  function visibleStudios(d) {
    return d.studios.filter(function (s) { return state.studio === 'All studios' || s.name === state.studio; });
  }

  function renderKpis(d) {
    // Counts follow the studio filter so a producer sees their own studio's numbers.
    var all = [];
    visibleStudios(d).forEach(function (st) { st.clients.forEach(function (c) { all = all.concat(c.sessions); }); });
    var count = function (f) { return all.filter(function (s) { return s.flag === f; }).length; };
    var active = all.filter(function (s) { return s.flag !== 'DONE'; });
    var sent = all.filter(function (s) { return s.steps[2].date && s.internalDays != null; });
    var avgDays = sent.length ? (sent.reduce(function (t, s) { return t + s.internalDays; }, 0) / sent.length).toFixed(1) : '–';
    var scope = d.me.ownOnly ? 'Yours' : state.studio === 'All studios' ? 'Across ' + d.studios.length + ' studios' : state.studio;
    var items = [
      ['', 'Active sessions', active.length, scope],
      ['is-red', 'RED', count('RED'), 'Needs Tamika'],
      ['is-amber', 'AMBER', count('AMBER'), 'Due tomorrow, not sent'],
      ['is-late', 'Client late', count('CLIENT LATE'), 'Over 48 hours'],
      ['', 'Past 5-day promise', active.filter(function (s) { return s.pastPromise; }).length, 'Active sessions'],
      ['', 'Avg days to client', avgDays, 'Recording to inbox']
    ];
    $('kpis').innerHTML = items.map(kpiCard).join('');
  }

  function kpiCard(i) {
    return '<div class="kpi ' + i[0] + '"><span class="label">' + esc(i[1]) + '</span>' +
      '<span class="value">' + esc(i[2]) + '</span><span class="sub">' + esc(i[3]) + '</span></div>';
  }

  function renderStudios(d) {
    var html = visibleStudios(d).map(function (st) {
      var clients = st.clients.map(function (c) {
        var sessions = c.sessions.filter(function (s) {
          return (!state.flagged || FLAGGED[s.flag] || s.stuck) && (state.showDone || s.flag !== 'DONE');
        });
        if (!sessions.length) return '';
        return '<div class="client"><h3>' + esc(c.name) + '</h3>' + sessions.map(sessionRow).join('') + '</div>';
      }).join('');
      if (state.flagged && !clients) return '';
      var doneCount = st.clients.reduce(function (t, c) { return t + c.sessions.filter(function (s) { return s.flag === 'DONE'; }).length; }, 0);
      var counts = '<span class="chip chip-count">' + st.active + ' active</span>' +
        (st.red ? '<span class="' + chipClass('RED') + '">' + st.red + ' RED</span>' : '') +
        (st.amber ? '<span class="' + chipClass('AMBER') + '">' + st.amber + ' AMBER</span>' : '') +
        (st.clientLate ? '<span class="' + chipClass('CLIENT LATE') + '">' + st.clientLate + ' CLIENT LATE</span>' : '');
      return '<section class="studio" aria-label="' + esc(st.name) + '">' +
        '<div class="studio-head"><div class="studio-title"><h2>' + esc(st.name) + '</h2>' +
        (st.producers.length ? '<span class="producer">' + esc(st.producers.join(', ')) + '</span>' : '') + '</div>' +
        '<div class="counts">' + counts + '</div></div>' +
        (clients || '<div class="no-sessions">' + (doneCount ? 'Nothing open. ' + doneCount + ' finished.' : 'No sessions logged yet.') + '</div>') +
        '<div style="height:8px"></div></section>';
    }).join('');
    $('studios').innerHTML = html || '<div class="empty">No sessions match this filter.</div>';
  }

  function sessionRow(s) {
    var steps = s.steps.map(function (st, i) {
      var cls = i < s.stepsDone ? 'done' : (i === s.stepsDone && s.flag !== 'DONE' ? 'current' : '');
      return '<li class="' + cls + '"><span class="dot" aria-hidden="true"></span>' +
        '<span class="lbl">' + esc(st.label) + '</span><span class="when">' + esc(shortDate(st.date)) + '</span></li>';
    }).join('');
    var actions = s.actions.map(function (a) {
      return '<button type="button" class="act' + (a.primary ? ' primary' : '') + '" data-row="' + s.row +
        '" data-action="' + esc(a.key) + '" data-label="' + esc(a.label) + '">' + esc(a.label) + '</button>';
    }).join('');
    return '<div class="session" data-row="' + s.row + '">' +
      '<div class="s-name"><strong>' + esc(s.session) + '</strong><span>' + esc(stageLabel(s.stage)) + '</span>' +
      '<span class="who-line">' + esc(s.producer || 'No producer set') + '</span></div>' +
      '<ol class="tracker" aria-label="' + esc(s.session + ': ' + s.stepsDone + ' of 6 steps done') + '">' + steps + '</ol>' +
      '<div class="s-clock"><strong>' + esc(s.clock) + '</strong><span>' + esc(s.note) + '</span>' +
      (s.chaserStatus ? '<span class="chaser">Chaser: ' + esc(s.chaserStatus) + (s.sinceUpdate != null && s.flag !== 'DONE' ? ' · ' + s.sinceUpdate + ' d ago' : '') + '</span>' : '') + '</div>' +
      '<span class="chips"><span class="' + chipClass(s.flag) + '">' + esc(s.flag) + '</span>' +
      (s.stuck && s.flag !== 'DONE' ? '<span class="chip chip-STUCK">STUCK</span>' : '') + '</span>' +
      (actions ? '<div class="s-actions">' + actions + '</div>' : '') +
      '</div>';
  }

  function shortDate(v) { return v ? String(v).replace(/^\w{3}\s+/, '').replace(/,?\s+\d{4}$/, '') : ''; }
  function stageLabel(v) { return String(v || '').replace(/^\d\.\s*/, ''); }

  function renderSide(d) {
    var inScope = function (e) { return state.studio === 'All studios' || e.studio === state.studio; };
    var esc1 = d.escalations.filter(inScope);
    $('escalations').innerHTML = esc1.length ? esc1.map(function (e) {
      return '<div class="alert ' + (e.kind === 'RED' ? 'alert-red' : 'alert-stuck') + '"><strong>' + (e.kind === 'RED' ? '' : 'Stuck: ') + esc(e.title) +
        '</strong><span>' + esc(e.reason) + '</span><small>' + esc(e.meta) + '</small></div>';
    }).join('') : '<p class="none">Nothing RED or stuck right now.</p>';
    var late = d.clientLate.filter(inScope);
    $('client-late').innerHTML = late.length ? late.map(function (e) {
      return '<div class="alert alert-late"><strong>' + esc(e.title) + '</strong><span>' + esc(e.reason) + '</span><small>' + esc(e.meta) + '</small></div>';
    }).join('') : '<p class="none">No clients past 48 hours.</p>';
    var s = d.settings;
    $('legend').innerHTML =
      '<li><span class="' + chipClass('RED') + '">RED</span> Day ' + s.red + ' since recording and not sent, or rework not returned the same day.</li>' +
      '<li><span class="' + chipClass('AMBER') + '">AMBER</span> Day ' + s.amber + ' since recording and not sent.</li>' +
      '<li><span class="' + chipClass('CLIENT LATE') + '">CLIENT LATE</span> Sent, no reply after ' + s.clientTarget + ' business days.</li>' +
      '<li><span class="chip chip-STUCK">STUCK</span> No Chaser update for ' + (s.stuck || 3) + ' business days (not counted while waiting on the client).</li>' +
      '<li class="muted">Thresholds come from the Settings tab of the tracker sheet.</li>';
  }

  // ---------- Analytics ----------
  // Records come from the server once; every filter below is computed here.
  var CHART = {
    ink: '#0A0A0A', grid: '#E6E6E1', muted: '#5E5E5E', surface: '#FFFFFF',
    good: '#0ca30c', critical: '#d03b3b', warning: '#fab219', late: '#6250d6',
    stages: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'] // validated categorical slots 1-4
  };
  var STAGES = [
    ['production', 'Production', 'Recording to content ready'],
    ['review', 'Client review', 'Content ready to first client reply'],
    ['rework', 'Rework', 'Changes requested to sent back'],
    ['scheduling', 'Scheduling', 'Approved to scheduled']
  ];
  var charts = {};

  function dayMs(iso) { return Date.parse(iso + 'T00:00:00Z'); }
  function periodRange(a) {
    var today = dayMs(a.today), D = 864e5;
    if (state.period === '30') return { start: today - 29 * D, end: today, prev: [today - 59 * D, today - 30 * D], label: 'Last 30 days' };
    if (state.period === '90') return { start: today - 89 * D, end: today, prev: [today - 179 * D, today - 90 * D], label: 'Last 90 days' };
    if (state.period === 'ytd') {
      var y = new Date(today).getUTCFullYear();
      var start = Date.UTC(y, 0, 1);
      return { start: start, end: today, prev: [Date.UTC(y - 1, 0, 1), today - (start - Date.UTC(y - 1, 0, 1))], label: 'This year' };
    }
    return { start: -Infinity, end: today, prev: null, label: 'All time' };
  }
  function matchesFilters(r) {
    return (state.anStudio === 'all' || r.studio === state.anStudio) && (state.anCp === 'all' || r.producer === state.anCp);
  }
  function inWindow(r, from, to) { var t = dayMs(r.recorded); return t >= from && t <= to; }
  function mean(xs) { return xs.length ? xs.reduce(function (a, b) { return a + b; }, 0) / xs.length : null; }
  function r1(x) { return x == null ? null : Math.round(x * 10) / 10; }

  function summarize(list) {
    var sent = list.filter(function (r) { return r.productionDone; });
    var replied = list.filter(function (r) { return r.reviewDone; });
    var reworked = list.filter(function (r) { return r.reworkRounds > 0; });
    var stage = {};
    STAGES.forEach(function (s) {
      var key = s[0];
      stage[key] = r1(mean(list.filter(function (r) { return r[key] != null; }).map(function (r) { return r[key]; })));
    });
    return {
      count: list.length,
      sent: sent.length,
      onTimePct: sent.length ? Math.round(sent.filter(function (r) { return r.onTime; }).length / sent.length * 100) : null,
      lateCount: list.filter(function (r) { return r.late; }).length,
      avgDays: r1(mean(sent.map(function (r) { return r.production; }))),
      avgReply: r1(mean(replied.map(function (r) { return r.review; }))),
      reworkPct: replied.length ? Math.round(reworked.length / replied.length * 100) : null,
      stage: stage
    };
  }

  // Arrow + change vs the previous period. betterWhenUp decides the colour.
  function delta(now, before, betterWhenUp, unit) {
    if (now == null || before == null) return '';
    var d = r1(now - before);
    if (!d) return '<span class="delta flat">no change</span>';
    var good = betterWhenUp ? d > 0 : d < 0;
    return '<span class="delta ' + (good ? 'up' : 'down') + '">' + (d > 0 ? '▲ ' : '▼ ') + Math.abs(d) + (unit || '') + '</span>';
  }

  function renderAnalytics() {
    var a = state.analytics;
    if (!a) return;
    Array.prototype.forEach.call(document.querySelectorAll('[data-period]'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.period === state.period));
    });
    var opt = function (v, label, cur) { return '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(label) + '</option>'; };
    $('an-studio').innerHTML = opt('all', 'All studios', state.anStudio) + a.studios.map(function (s) { return opt(s, s, state.anStudio); }).join('');
    var cps = a.producers.slice();
    a.records.forEach(function (r) { if (cps.indexOf(r.producer) < 0) cps.push(r.producer); });
    $('an-cp').innerHTML = opt('all', 'All CPs', state.anCp) + cps.map(function (c) { return opt(c, c, state.anCp); }).join('');

    var p = periodRange(a);
    var filtered = a.records.filter(matchesFilters);
    var cur = filtered.filter(function (r) { return inWindow(r, p.start, p.end); });
    var prev = p.prev ? filtered.filter(function (r) { return inWindow(r, p.prev[0], p.prev[1]); }) : [];
    var S = summarize(cur), P = p.prev && prev.length ? summarize(prev) : null;
    var scope = [state.anStudio === 'all' ? 'all studios' : state.anStudio, state.anCp === 'all' ? 'all CPs' : state.anCp].join(', ');
    $('an-sub').textContent = p.label + ' · ' + scope + ' · by recording date · promise ' + a.promise + ' business days' +
      (P ? ' · arrows compare with the ' + (state.period === 'ytd' ? 'same dates last year' : 'previous ' + state.period + ' days') : '');

    var kpi = function (cls, label, value, sub, d) {
      return '<div class="kpi ' + cls + '"><span class="label">' + esc(label) + '</span><span class="value">' + esc(value) + '</span>' +
        '<span class="sub">' + (d || '') + ' ' + esc(sub) + '</span></div>';
    };
    $('an-kpis').innerHTML = [
      kpi(S.onTimePct != null && S.onTimePct < 80 ? 'is-red' : '', 'On time', dash(S.onTimePct, '%'), S.sent + ' sent', P && delta(S.onTimePct, P.onTimePct, true, ' pts')),
      kpi('', 'Avg days to content ready', dash(S.avgDays), 'business days', P && delta(S.avgDays, P.avgDays, false)),
      kpi('', 'Sessions wrapped', S.count, 'recorded', P && delta(S.count, P.count, true)),
      kpi(S.lateCount ? 'is-red' : '', 'Late', S.lateCount, 'past the promise', P && delta(S.lateCount, P.lateCount, false)),
      kpi('is-late', 'Avg client reply', dash(S.avgReply, ' d'), 'business days', P && delta(S.avgReply, P.avgReply, false)),
      kpi('', 'Rework rate', dash(S.reworkPct, '%'), 'of replies', P && delta(S.reworkPct, P.reworkPct, false, ' pts'))
    ].join('');

    renderHealth(filtered.filter(function (r) { return r.open; }));
    renderTrends(cur, p, a);
    renderCps(cur, prev, a, cps);
    renderStages(cur, cps);
    renderStudioTable(cur, prev, a);
    renderClients(cur);
  }

  function renderHealth(open) {
    var parts = [
      ['On track', open.filter(function (r) { return r.flag === 'GREEN'; }).length, CHART.good],
      ['AMBER', open.filter(function (r) { return r.flag === 'AMBER'; }).length, CHART.warning],
      ['RED', open.filter(function (r) { return r.flag === 'RED'; }).length, CHART.critical],
      ['Client late', open.filter(function (r) { return r.flag === 'CLIENT LATE'; }).length, CHART.late]
    ];
    var total = open.length;
    var stuck = open.filter(function (r) { return r.stuck; }).length;
    var overdue = parts[2][1] + open.filter(function (r) { return r.late && r.flag !== 'RED'; }).length;
    var bar = total ? '<div class="seg" role="img" aria-label="' + esc(parts.map(function (p) { return p[0] + ' ' + p[1]; }).join(', ')) + '">' +
      parts.filter(function (p) { return p[1]; }).map(function (p) {
        return '<span style="flex:' + p[1] + ';background:' + p[2] + '" title="' + esc(p[0] + ': ' + p[1]) + '"></span>';
      }).join('') + '</div>' : '';
    $('an-health').innerHTML = '<div class="health-row">' +
      '<div class="health-big"><span class="value">' + total + '</span><span class="label">open sessions</span></div>' +
      '<div class="health-big"><span class="value' + (overdue ? ' red' : '') + '">' + overdue + '</span><span class="label">overdue</span></div>' +
      '<div class="health-big"><span class="value">' + (total - overdue) + '</span><span class="label">not overdue</span></div>' +
      '<div class="health-big"><span class="value' + (stuck ? ' red' : '') + '">' + stuck + '</span><span class="label">stuck (no Chaser update)</span></div>' +
      '</div>' + bar + '<ul class="seg-legend">' + parts.map(function (p) {
        return '<li><span class="sw" style="background:' + p[2] + '"></span>' + esc(p[0]) + ' <strong>' + p[1] + '</strong></li>';
      }).join('') + '</ul>' + (total ? '' : '<p class="none">No open sessions match these filters.</p>');
  }

  // Weekly buckets for 30/90 days, monthly for longer windows.
  function buckets(p, recs, a) {
    var monthly = state.period === 'ytd' || state.period === 'all';
    var start = p.start;
    if (start === -Infinity) {
      start = recs.reduce(function (m, r) { return Math.min(m, dayMs(r.recorded)); }, dayMs(a.today));
    }
    var out = [], d = new Date(start);
    if (monthly) {
      d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
      while (d.getTime() <= p.end) {
        var next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
        out.push({ from: d.getTime(), to: next - 1, label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }) });
        d = new Date(next);
      }
    } else {
      var dow = (d.getUTCDay() + 6) % 7; // Monday = 0
      var t = d.getTime() - dow * 864e5;
      while (t <= p.end) {
        out.push({ from: t, to: t + 7 * 864e5 - 1, label: 'Wk of ' + new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) });
        t += 7 * 864e5;
      }
    }
    return out.map(function (b) {
      var inB = recs.filter(function (r) { var x = dayMs(r.recorded); return x >= b.from && x <= b.to; });
      var sent = inB.filter(function (r) { return r.productionDone; });
      return {
        label: b.label,
        onTime: inB.filter(function (r) { return !r.late; }).length,
        late: inB.filter(function (r) { return r.late; }).length,
        avgDays: r1(mean(sent.map(function (r) { return r.production; })))
      };
    });
  }

  function chart(id, config) {
    if (typeof Chart === 'undefined') return;
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart($(id), config);
  }
  function baseOptions(extra) {
    var o = {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', align: 'start', labels: { boxWidth: 12, boxHeight: 12, color: CHART.muted, font: { family: 'Barlow', size: 13 } } },
        tooltip: { backgroundColor: CHART.ink, titleFont: { family: 'Barlow', weight: '700' }, bodyFont: { family: 'Barlow' }, padding: 10 }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: CHART.muted, font: { family: 'Barlow' } }, border: { color: CHART.grid } },
        y: { beginAtZero: true, grid: { color: CHART.grid }, ticks: { color: CHART.muted, font: { family: 'Barlow' }, precision: 0 }, border: { display: false } }
      }
    };
    return Object.assign(o, extra || {});
  }

  function renderTrends(cur, p, a) {
    var b = buckets(p, cur, a);
    var labels = b.map(function (x) { return x.label; });
    chart('chart-ontime', {
      type: 'bar',
      data: { labels: labels, datasets: [
        { label: 'On time', data: b.map(function (x) { return x.onTime; }), backgroundColor: CHART.good, borderRadius: 4, borderColor: CHART.surface, borderWidth: 2, borderSkipped: false, maxBarThickness: 36 },
        { label: 'Late', data: b.map(function (x) { return x.late; }), backgroundColor: CHART.critical, borderRadius: 4, borderColor: CHART.surface, borderWidth: 2, borderSkipped: false, maxBarThickness: 36 }
      ] },
      options: baseOptions({ scales: Object.assign(baseOptions().scales, { x: Object.assign(baseOptions().scales.x, { stacked: true }), y: Object.assign(baseOptions().scales.y, { stacked: true, title: { display: true, text: 'Sessions', color: CHART.muted } }) }) })
    });
    chart('chart-days', {
      type: 'line',
      data: { labels: labels, datasets: [
        { label: 'Avg days to content ready', data: b.map(function (x) { return x.avgDays; }), borderColor: CHART.ink, backgroundColor: CHART.ink, borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, spanGaps: true, tension: 0 },
        { label: a.promise + '-day promise', data: b.map(function () { return a.promise; }), borderColor: CHART.critical, borderDash: [6, 4], borderWidth: 2, pointRadius: 0, pointHoverRadius: 0 }
      ] },
      options: baseOptions({ scales: Object.assign(baseOptions().scales, { y: Object.assign(baseOptions().scales.y, { suggestedMax: a.promise + 2, title: { display: true, text: 'Business days', color: CHART.muted } }) }) })
    });
  }

  function onTimeClass(v) { return v == null ? '' : v >= 90 ? 'good' : v >= 75 ? 'warn' : 'bad'; }
  function slowestStage(st) {
    var best = null;
    STAGES.forEach(function (s) { if (st[s[0]] != null && (!best || st[s[0]] > st[best[0]])) best = s; });
    return best ? best[1] + ' (' + st[best[0]] + ' d)' : '–';
  }

  function renderCps(cur, prev, a, cps) {
    var open = a.records.filter(function (r) { return r.open && matchesFilters(r); });
    var rows = cps.filter(function (c) { return state.anCp === 'all' || c === state.anCp; }).map(function (c) {
      var mine = function (r) { return r.producer === c; };
      var S = summarize(cur.filter(mine)), P = prev.length ? summarize(prev.filter(mine)) : null;
      var o = open.filter(mine);
      return { name: c, S: S, P: P && P.count ? P : null, red: o.filter(function (r) { return r.flag === 'RED'; }).length, stuck: o.filter(function (r) { return r.stuck; }).length, open: o.length };
    }).filter(function (r) { return r.S.count || r.open; });
    rows.sort(function (x, y) { return (x.S.onTimePct == null ? 101 : x.S.onTimePct) - (y.S.onTimePct == null ? 101 : y.S.onTimePct) || y.S.lateCount - x.S.lateCount; });
    $('an-cps').innerHTML = '<thead><tr><th scope="col">CP</th><th scope="col" class="num">Sessions</th><th scope="col" class="num">On time</th>' +
      '<th scope="col" class="num">Avg days to content ready</th><th scope="col" class="num">Late</th><th scope="col">Slowest stage</th>' +
      '<th scope="col" class="num">Avg client reply</th><th scope="col" class="num">Rework rate</th><th scope="col" class="num">Open now</th>' +
      '<th scope="col" class="num">RED now</th><th scope="col" class="num">Stuck now</th></tr></thead><tbody>' +
      (rows.length ? rows.map(function (r) {
        return '<tr><th scope="row">' + esc(r.name) + '</th><td class="num">' + r.S.count + '</td>' +
          '<td class="num"><span class="pctv ' + onTimeClass(r.S.onTimePct) + '">' + dash(r.S.onTimePct, '%') + '</span> ' + (r.P ? delta(r.S.onTimePct, r.P.onTimePct, true, '') : '') + '</td>' +
          '<td class="num' + (r.S.avgDays > a.promise ? ' over' : '') + '">' + dash(r.S.avgDays) + ' ' + (r.P ? delta(r.S.avgDays, r.P.avgDays, false) : '') + '</td>' +
          '<td class="num' + (r.S.lateCount ? ' over' : '') + '">' + r.S.lateCount + '</td>' +
          '<td>' + esc(slowestStage(r.S.stage)) + '</td>' +
          '<td class="num">' + dash(r.S.avgReply, ' d') + '</td><td class="num">' + dash(r.S.reworkPct, '%') + '</td>' +
          '<td class="num">' + r.open + '</td><td class="num' + (r.red ? ' over' : '') + '">' + r.red + '</td>' +
          '<td class="num' + (r.stuck ? ' over' : '') + '">' + r.stuck + '</td></tr>';
      }).join('') : '<tr><td colspan="11" class="muted">No sessions in this window.</td></tr>') + '</tbody>';
  }

  function renderStages(cur, cps) {
    var groups = [['All CPs', cur]].concat(cps.filter(function (c) { return state.anCp === 'all' || c === state.anCp; })
      .map(function (c) { return [c, cur.filter(function (r) { return r.producer === c; })]; })
      .filter(function (g) { return g[1].length; }));
    if (state.anCp !== 'all') groups = groups.slice(1);
    var sums = groups.map(function (g) { return { name: g[0], st: summarize(g[1]).stage, n: g[1].length }; });
    chart('chart-stages', {
      type: 'bar',
      data: { labels: sums.map(function (s) { return s.name; }), datasets: STAGES.map(function (s, i) {
        return { label: s[1], data: sums.map(function (x) { return x.st[s[0]]; }), backgroundColor: CHART.stages[i], borderColor: CHART.surface, borderWidth: 2, borderSkipped: false, borderRadius: 4, maxBarThickness: 28 };
      }) },
      options: baseOptions({
        indexAxis: 'y',
        interaction: { mode: 'index', intersect: false, axis: 'y' },
        scales: {
          x: { stacked: true, beginAtZero: true, grid: { color: CHART.grid }, ticks: { color: CHART.muted, font: { family: 'Barlow' } }, border: { display: false }, title: { display: true, text: 'Business days', color: CHART.muted } },
          y: { stacked: true, grid: { display: false }, ticks: { color: CHART.ink, font: { family: 'Barlow', weight: '600' } }, border: { color: CHART.grid } }
        }
      })
    });
    $('chart-stages').parentNode.style.height = Math.max(160, 70 + sums.length * 44) + 'px';
    $('an-stages').innerHTML = '<thead><tr><th scope="col">Stage (business days)</th>' + sums.map(function (s) { return '<th scope="col" class="num">' + esc(s.name) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + STAGES.map(function (s) {
        return '<tr><th scope="row">' + esc(s[1]) + '<small>' + esc(s[2]) + '</small></th>' + sums.map(function (x) {
          return '<td class="num">' + dash(x.st[s[0]]) + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody>';
  }

  function renderStudioTable(cur, prev, a) {
    var open = a.records.filter(function (r) { return r.open && matchesFilters(r); });
    var names = a.studios.filter(function (s) { return state.anStudio === 'all' || s === state.anStudio; });
    $('an-studios').innerHTML = '<thead><tr><th scope="col">Studio</th><th scope="col" class="num">Sessions</th><th scope="col" class="num">On time</th>' +
      '<th scope="col" class="num">Avg days to content ready</th><th scope="col" class="num">Late</th><th scope="col">Slowest stage</th>' +
      '<th scope="col" class="num">Open now</th><th scope="col" class="num">RED now</th><th scope="col" class="num">Stuck now</th></tr></thead><tbody>' +
      names.map(function (n) {
        var mine = function (r) { return r.studio === n; };
        var S = summarize(cur.filter(mine)), P = prev.length ? summarize(prev.filter(mine)) : null;
        var o = open.filter(mine);
        var red = o.filter(function (r) { return r.flag === 'RED'; }).length, stuck = o.filter(function (r) { return r.stuck; }).length;
        return '<tr><th scope="row">' + esc(n) + '</th><td class="num">' + S.count + '</td>' +
          '<td class="num"><span class="pctv ' + onTimeClass(S.onTimePct) + '">' + dash(S.onTimePct, '%') + '</span> ' + (P && P.count ? delta(S.onTimePct, P.onTimePct, true, '') : '') + '</td>' +
          '<td class="num' + (S.avgDays > a.promise ? ' over' : '') + '">' + dash(S.avgDays) + '</td>' +
          '<td class="num' + (S.lateCount ? ' over' : '') + '">' + S.lateCount + '</td><td>' + esc(slowestStage(S.stage)) + '</td>' +
          '<td class="num">' + o.length + '</td><td class="num' + (red ? ' over' : '') + '">' + red + '</td><td class="num' + (stuck ? ' over' : '') + '">' + stuck + '</td></tr>';
      }).join('') + '</tbody>';
  }

  function renderClients(cur) {
    var by = {};
    cur.forEach(function (r) {
      if (!(r.late || r.stuck || r.flag === 'RED' || r.flag === 'AMBER' || r.flag === 'CLIENT LATE')) return;
      var c = by[r.client] || (by[r.client] = { name: r.client, studios: [], cps: [], late: 0, slowest: 0, issues: [] });
      if (c.studios.indexOf(r.studio) < 0) c.studios.push(r.studio);
      if (c.cps.indexOf(r.producer) < 0) c.cps.push(r.producer);
      if (r.late) c.late++;
      if (r.productionDone) c.slowest = Math.max(c.slowest, r.production);
      if (r.open && r.flag !== 'GREEN') c.issues.push('<span class="' + chipClass(r.flag) + '">' + esc(r.flag) + '</span> ' + esc(r.session));
      if (r.open && r.stuck) c.issues.push('<span class="chip chip-STUCK">STUCK</span> ' + esc(r.session));
    });
    var list = Object.keys(by).map(function (k) { return by[k]; })
      .sort(function (x, y) { return y.issues.length - x.issues.length || y.late - x.late; });
    $('an-clients').innerHTML = '<thead><tr><th scope="col">Client</th><th scope="col">Studio</th><th scope="col">CP</th>' +
      '<th scope="col" class="num">Sessions late</th><th scope="col" class="num">Slowest (days)</th><th scope="col">Open issues</th></tr></thead><tbody>' +
      (list.length ? list.map(function (c) {
        return '<tr><th scope="row">' + esc(c.name) + '</th><td>' + esc(c.studios.join(', ')) + '</td><td>' + esc(c.cps.join(', ')) + '</td>' +
          '<td class="num' + (c.late ? ' over' : '') + '">' + c.late + '</td><td class="num">' + (c.slowest || '–') + '</td>' +
          '<td class="issues">' + (c.issues.join('<br>') || '<span class="muted">None open</span>') + '</td></tr>';
      }).join('') : '<tr><td colspan="6" class="muted">No clients affected in this window.</td></tr>') + '</tbody>';
  }

  // ---------- Events ----------
  document.addEventListener('click', function (e) {
    var t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.studio) { state.studio = t.dataset.studio; render(); return; }
    if (t.dataset.action) { runAction(t); return; }
    if (t.dataset.view) {
      state.view = t.dataset.view; render();
      if (state.view === 'analytics') loadAnalytics();
      return;
    }
    if (t.dataset.period) { state.period = t.dataset.period; renderAnalytics(); return; }
  });

  $('flagged-toggle').addEventListener('click', function () { state.flagged = !state.flagged; render(); });
  $('an-studio').addEventListener('change', function () { state.anStudio = this.value; renderAnalytics(); });
  $('an-cp').addEventListener('change', function () { state.anCp = this.value; renderAnalytics(); });
  $('done-toggle').addEventListener('click', function () { state.showDone = !state.showDone; render(); });
  $('refresh').addEventListener('click', function () { load().then(function () { toast('Updated from the sheet'); }); });
  $('logout').addEventListener('click', function () {
    api('/auth/logout', { method: 'POST' }).finally(function () { window.location.href = '/login'; });
  });

  function findSession(row) {
    var out = null;
    state.data.studios.forEach(function (st) {
      st.clients.forEach(function (c) { c.sessions.forEach(function (s) { if (s.row === row) out = s; }); });
    });
    return out;
  }

  // Dates for the date pickers, in the browser's local time.
  function isoDay(offsetDays) {
    var d = new Date(); d.setDate(d.getDate() + (offsetDays || 0));
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function setDateLimits(input) { input.max = isoDay(0); input.min = isoDay(-14); input.value = isoDay(0); }

  var recDlg = $('rec-dialog'), recPending = null;
  function runAction(btn) {
    if (state.busy) return;
    var row = Number(btn.dataset.row);
    var s = findSession(row);
    if (!s) return;
    if (btn.dataset.action === 'recorded') {
      recPending = { btn: btn, s: s, row: row };
      $('rec-which').textContent = s.client + ', ' + s.session;
      setDateLimits($('rec-date'));
      $('rec-error').hidden = true;
      recDlg.showModal();
      return;
    }
    var msg = btn.dataset.label + ' for ' + s.client + ', ' + s.session + '?\n\nThis records today\'s date in the tracker.';
    if (!window.confirm(msg)) return;
    sendAction(btn, s, row, null);
  }
  $('rec-cancel').addEventListener('click', function () { recDlg.close(); });
  $('rec-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var p = recPending;
    if (!p || !$('rec-date').value) return;
    recDlg.close();
    sendAction(p.btn, p.s, p.row, $('rec-date').value);
  });
  function sendAction(btn, s, row, date) {
    state.busy = true;
    btn.disabled = true;
    api('/api/action', {
      method: 'POST',
      body: JSON.stringify({ row: row, client: s.client, session: s.session, action: btn.dataset.action, date: date })
    }).then(function () {
      toast(btn.dataset.label + ': ' + s.client + ', ' + s.session);
      return load();
    }).catch(function (e) {
      toast(e.message, true);
      btn.disabled = false;
    }).finally(function () { state.busy = false; });
  }

  // ---------- Log session: client, studio (when the client has two), producer, name ----------
  var dlg = $('add-dialog');
  function meName() { return state.data.me && state.data.me.name; }
  function mySessions() {
    var out = [], me = meName();
    if (!me) return out;
    state.data.studios.forEach(function (st) { st.clients.forEach(function (c) { c.sessions.forEach(function (s) {
      if (s.producer === me) out.push({ client: c.name, studio: st.name });
    }); }); });
    return out;
  }
  function renumber() {
    var n = $('add-studio-wrap').hidden ? 2 : 3;
    $('producer-step').textContent = n + '. Producer';
    $('name-step').textContent = (n + 1) + '. Session name';
    $('rec-step').textContent = (n + 2) + '. Recording';
  }
  $('add-session').addEventListener('click', function () {
    var d = state.data, me = d.me;
    var myStudio = null;
    var inStudio = function (n) { return myStudio && (d.clientStudios[n] || []).indexOf(myStudio) >= 0; };
    var first = d.clientNames.filter(inStudio), rest = d.clientNames.filter(function (n) { return !inStudio(n); });
    var opt = function (n) { return '<option>' + esc(n) + '</option>'; };
    $('add-client').innerHTML = '<option value="">Choose a client</option>' +
      (first.length ? '<optgroup label="' + esc(myStudio) + ' clients">' + first.map(opt).join('') + '</optgroup>' +
        '<optgroup label="Other studios">' + rest.map(opt).join('') + '</optgroup>' : rest.map(opt).join(''));
    var meIsProducer = d.producers.indexOf(meName()) >= 0;
    $('add-producer').innerHTML = (meIsProducer ? '' : '<option value="">Choose a producer</option>') + d.producers.map(function (n) {
      return '<option' + (n === meName() ? ' selected' : '') + '>' + esc(n) + '</option>';
    }).join('');
    $('add-name').value = '';
    $('add-error').hidden = true;
    $('add-studio-wrap').hidden = true;
    $('add-studio-auto').hidden = true;
    setDateLimits($('add-recorded'));
    document.querySelector('input[name=rec][value=yes]').checked = true;
    $('add-recorded').disabled = false;
    renumber();
    dlg.showModal();
  });
  $('add-client').addEventListener('change', function () {
    var client = $('add-client').value;
    var studios = state.data.clientStudios[client] || [];
    var me = state.data.me;
    var pick = studios[0];
    $('add-studio').innerHTML = studios.map(function (n) {
      return '<option' + (n === pick ? ' selected' : '') + '>' + esc(n) + '</option>';
    }).join('');
    $('add-studio-wrap').hidden = studios.length < 2;
    $('add-studio-auto').hidden = studios.length !== 1;
    $('add-studio-auto').textContent = studios.length === 1 ? 'Studio: ' + studios[0] : '';
    renumber();
  });
  $('add-cancel').addEventListener('click', function () { dlg.close(); });
  Array.prototype.forEach.call(document.querySelectorAll('input[name=rec]'), function (r) {
    r.addEventListener('change', function () { $('add-recorded').disabled = this.value !== 'yes' || !this.checked; });
  });
  $('add-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var client = $('add-client').value;
    var name = $('add-name').value.trim();
    var producer = $('add-producer').value;
    if (!client || !name) { $('add-error').textContent = 'Pick a client and name the session.'; $('add-error').hidden = false; return; }
    if (!producer) { $('add-error').textContent = 'Pick the producer for this session.'; $('add-error').hidden = false; return; }
    var studio = $('add-studio-wrap').hidden ? '' : $('add-studio').value;
    var recorded = document.querySelector('input[name=rec]:checked').value === 'yes' ? $('add-recorded').value : '';
    if (document.querySelector('input[name=rec]:checked').value === 'yes' && !recorded) {
      $('add-error').textContent = 'Pick the recording date, or choose Not recorded yet.'; $('add-error').hidden = false; return;
    }
    api('/api/sessions', { method: 'POST', body: JSON.stringify({ client: client, studio: studio, producer: producer, session: name, recorded: recorded }) })
      .then(function () { dlg.close(); toast('Session added for ' + client); return load(); })
      .catch(function (err) { $('add-error').textContent = err.message; $('add-error').hidden = false; });
  });

  // ---------- Add client (Ops and CP Trainer) ----------
  var cdlg = $('client-dialog');
  $('new-client').addEventListener('click', function () {
    var d = state.data;
    $('c-existing').innerHTML = d.clientNames.map(function (n) { return '<option value="' + esc(n) + '"></option>'; }).join('');
    $('c-studio').innerHTML = '<option value="">Choose a studio</option>' + d.studioNames.map(function (n) {
      return '<option>' + esc(n) + '</option>';
    }).join('');
    ['c-name', 'c-contacts', 'c-emails'].forEach(function (id) { $(id).value = ''; });
    $('c-error').hidden = true;
    cdlg.showModal();
  });
  $('c-cancel').addEventListener('click', function () { cdlg.close(); });
  $('client-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var body = { name: $('c-name').value, studio: $('c-studio').value, contacts: $('c-contacts').value, emails: $('c-emails').value };
    if (!body.name.trim() || !body.studio) { $('c-error').textContent = 'Enter a client name and pick a studio.'; $('c-error').hidden = false; return; }
    api('/api/clients', { method: 'POST', body: JSON.stringify(body) })
      .then(function (r) {
        cdlg.close();
        toast(r.addedStudio ? body.studio + ' added for ' + r.name : r.name + ' added to ' + body.studio);
        return load();
      })
      .catch(function (err) { $('c-error').textContent = err.message; $('c-error').hidden = false; });
  });

  load();
  // Keep the view current while it's left open on a screen.
  setInterval(function () {
    if (document.hidden || state.busy || dlg.open || cdlg.open || recDlg.open) return;
    load();
  }, 60000);
})();
