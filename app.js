(function () {
  'use strict';

  var state = {
    data: null, view: 'board', studio: 'All studios', flagged: false, mine: false, showDone: false,
    busy: false, defaulted: false, days: '30', analytics: null
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
      if (me && !state.defaulted) {
        state.defaulted = true;
        if (me.role === 'Producer') { state.studio = me.studio || 'All studios'; state.view = 'board'; }
        else if (me.role === 'Viewer') { state.view = 'analytics'; }
        else { state.view = 'board'; }
      }
      render();
      if ((!me || me.needsStudio) && !$('who-dialog').open) openWho(me && me.needsStudio ? me : null);
      if (state.view === 'analytics') loadAnalytics();
    }).catch(function (e) {
      $('studios').innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    });
  }

  function loadAnalytics() {
    var q = state.days === 'all' ? '' : '?days=' + state.days;
    return api('/api/analytics' + q).then(function (a) {
      state.analytics = a;
      renderAnalytics();
    }).catch(function (e) { toast(e.message, true); });
  }

  // ---------- Rendering ----------
  function render() {
    var d = state.data, me = d.me;
    var label = !me ? (d.user ? d.user.name : '') :
      me.role === 'Viewer' ? 'Viewing as ' + d.user.name :
      me.name + (me.studio ? ' · ' + me.studio : ' · ' + me.role);
    $('user-name').textContent = label;
    $('switch-user').hidden = !me || (me.auto && me.role !== 'Producer');
    $('mock-banner').hidden = !d.mock;
    $('readonly-banner').hidden = !me || me.canWrite || me.needsStudio;
    $('views').hidden = !(me && me.canSeeAnalytics);
    $('add-session').hidden = !(me && me.canWrite);
    $('new-client').hidden = !(me && me.canManageClients);
    if (!(me && me.canSeeAnalytics)) state.view = 'board';
    Array.prototype.forEach.call(document.querySelectorAll('#views [data-view]'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
    });
    $('board-view').hidden = state.view !== 'board';
    $('analytics-view').hidden = state.view !== 'analytics';

    $('board-title').textContent = me && me.role === 'Producer' && state.studio === me.studio
      ? me.studio + ': is every session on the clock?' : 'Is every session on the clock?';
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
      var mine = d.me && d.me.studio === n ? ' (yours)' : '';
      return '<button type="button" class="pill" data-studio="' + esc(n) + '" aria-pressed="' + (state.studio === n) + '">' + esc(n + mine) + '</button>';
    }).join('');
    $('flagged-toggle').setAttribute('aria-pressed', String(state.flagged));
    $('done-toggle').setAttribute('aria-pressed', String(state.showDone));
    var isProducer = d.me && d.me.role === 'Producer';
    $('mine-toggle').hidden = !isProducer;
    $('mine-toggle').setAttribute('aria-pressed', String(!!isProducer && state.mine));
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
    var sent = all.filter(function (s) { return s.stepsDone >= 3 && s.internalDays != null; });
    var avgDays = sent.length ? (sent.reduce(function (t, s) { return t + s.internalDays; }, 0) / sent.length).toFixed(1) : '–';
    var scope = state.studio === 'All studios' ? 'Across ' + d.studios.length + ' studios' : state.studio;
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
    var meName = d.me && d.me.name;
    var html = visibleStudios(d).map(function (st) {
      var clients = st.clients.map(function (c) {
        var sessions = c.sessions.filter(function (s) {
          return (!state.flagged || FLAGGED[s.flag]) && (!state.mine || !meName || s.producer === meName) &&
            (state.showDone || s.flag !== 'DONE');
        });
        if (!sessions.length) return '';
        return '<div class="client"><h3>' + esc(c.name) + '</h3>' + sessions.map(sessionRow).join('') + '</div>';
      }).join('');
      if ((state.flagged || state.mine) && !clients) return '';
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
      '<div class="s-clock"><strong>' + esc(s.clock) + '</strong><span>' + esc(s.note) + '</span></div>' +
      '<span class="' + chipClass(s.flag) + '">' + esc(s.flag) + '</span>' +
      (actions ? '<div class="s-actions">' + actions + '</div>' : '') +
      '</div>';
  }

  function shortDate(v) { return v ? String(v).replace(/^\w{3}\s+/, '') : ''; }
  function stageLabel(v) { return String(v || '').replace(/^\d\.\s*/, ''); }

  function renderSide(d) {
    var inScope = function (e) { return state.studio === 'All studios' || e.meta.indexOf(state.studio) === 0; };
    var esc1 = d.escalations.filter(inScope);
    $('escalations').innerHTML = esc1.length ? esc1.map(function (e) {
      return '<div class="alert alert-red"><strong>' + esc(e.title) + '</strong><span>' + esc(e.reason) + '</span><small>' + esc(e.meta) + '</small></div>';
    }).join('') : '<p class="none">Nothing RED right now.</p>';
    var late = d.clientLate;
    $('client-late').innerHTML = late.length ? late.map(function (e) {
      return '<div class="alert alert-late"><strong>' + esc(e.title) + '</strong><span>' + esc(e.reason) + '</span><small>' + esc(e.meta) + '</small></div>';
    }).join('') : '<p class="none">No clients past 48 hours.</p>';
    var s = d.settings;
    $('legend').innerHTML =
      '<li><span class="' + chipClass('RED') + '">RED</span> Day ' + s.red + ' since recording and not sent, or rework not returned the same day.</li>' +
      '<li><span class="' + chipClass('AMBER') + '">AMBER</span> Day ' + s.amber + ' since recording and not sent.</li>' +
      '<li><span class="' + chipClass('CLIENT LATE') + '">CLIENT LATE</span> Sent, no reply after ' + s.clientTarget + ' business days.</li>' +
      '<li class="muted">Thresholds come from the Settings tab of the tracker sheet.</li>';
  }

  // ---------- Analytics ----------
  function renderAnalytics() {
    var a = state.analytics;
    if (!a) return;
    Array.prototype.forEach.call(document.querySelectorAll('#analytics-view [data-days]'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.days === state.days));
    });
    $('an-sub').textContent = a.window + ' by recording date. Open sessions always count. Promise: ' + a.promise + ' business days.';
    var o = a.overall;
    $('an-kpis').innerHTML = [
      [o.onTimePct != null && o.onTimePct < 80 ? 'is-red' : '', 'On time', dash(o.onTimePct, '%'), o.late + ' of ' + o.sent + ' sent late'],
      ['', 'Avg days to client', dash(o.avgDays), 'Median ' + dash(o.medianDays)],
      ['', 'Sessions sent', o.sent, o.recorded + ' recorded'],
      ['is-red', 'RED now', o.red, o.amber + ' AMBER'],
      ['is-late', 'Avg client reply', dash(o.avgClientWait, ' d'), o.waitingOnClient + ' waiting now'],
      ['', 'Rework rate', dash(o.reworkPct, '%'), o.clientsAffected + ' clients affected']
    ].map(kpiCard).join('');

    var maxDays = Math.max(a.promise * 2, Math.max.apply(null, a.byStudio.concat(a.byProducer).map(function (r) { return r.avgDays || 0; })));
    var head = function (first, extra) {
      return '<thead><tr><th scope="col">' + first + '</th>' + (extra || '') +
        '<th scope="col" class="num">Sent</th><th scope="col" class="num">On time</th><th scope="col">Avg days to client</th>' +
        '<th scope="col" class="num">Slowest</th><th scope="col" class="num">RED</th><th scope="col" class="num">AMBER</th>' +
        '<th scope="col" class="num">Waiting on client</th><th scope="col" class="num">Avg client reply</th>' +
        '<th scope="col" class="num">Rework</th><th scope="col" class="num">Clients affected</th></tr></thead>';
    };
    var cells = function (r) {
      var onTimeCls = r.onTimePct == null ? '' : r.onTimePct >= 90 ? 'good' : r.onTimePct >= 75 ? 'warn' : 'bad';
      return '<td class="num">' + r.sent + '</td>' +
        '<td class="num"><span class="pctv ' + onTimeCls + '">' + dash(r.onTimePct, '%') + '</span></td>' +
        '<td>' + bar(r.avgDays, a.promise, maxDays) + '</td>' +
        '<td class="num' + (r.slowestDays > a.promise ? ' over' : '') + '">' + dash(r.slowestDays) + '</td>' +
        '<td class="num' + (r.red ? ' over' : '') + '">' + r.red + '</td>' +
        '<td class="num">' + r.amber + '</td>' +
        '<td class="num">' + r.waitingOnClient + (r.clientLate ? ' <span class="late-note">(' + r.clientLate + ' late)</span>' : '') + '</td>' +
        '<td class="num">' + dash(r.avgClientWait, ' d') + '</td>' +
        '<td class="num">' + dash(r.reworkPct, '%') + '</td>' +
        '<td class="num">' + r.clientsAffected + '</td>';
    };
    $('an-studios').innerHTML = head('Studio') + '<tbody>' + a.byStudio.map(function (r) {
      return '<tr><th scope="row">' + esc(r.name) + '<small>' + esc(r.producers.join(', ') || 'No sessions') + '</small></th>' + cells(r) + '</tr>';
    }).join('') + '</tbody>';
    $('an-producers').innerHTML = head('Producer', '<th scope="col">Home studio</th>') + '<tbody>' + a.byProducer.map(function (r) {
      return '<tr><th scope="row">' + esc(r.name) + '</th><td>' + esc(r.studio || '–') + '</td>' + cells(r) + '</tr>';
    }).join('') + '</tbody>';
    $('an-clients').innerHTML = '<thead><tr><th scope="col">Client</th><th scope="col">Studio</th><th scope="col">Producer</th>' +
      '<th scope="col" class="num">Sessions past promise</th><th scope="col" class="num">Slowest</th><th scope="col">Open issues</th></tr></thead><tbody>' +
      (a.clients.length ? a.clients.map(function (c) {
        var open = c.open.map(function (x) {
          return '<span class="' + chipClass(x.flag) + '">' + esc(x.flag) + '</span> ' + esc(x.session + ': ' + x.clock);
        }).join('<br>');
        return '<tr><th scope="row">' + esc(c.name) + '</th><td>' + esc(c.studios.join(', ')) + '</td><td>' + esc(c.producers.join(', ')) + '</td>' +
          '<td class="num' + (c.late ? ' over' : '') + '">' + c.late + '</td><td class="num">' + dash(c.slowestDays || null) + '</td>' +
          '<td class="issues">' + (open || '<span class="muted">None open</span>') + '</td></tr>';
      }).join('') : '<tr><td colspan="6" class="muted">No clients affected in this window.</td></tr>') + '</tbody>';
  }

  function bar(v, promise, max) {
    if (v == null) return '<span class="muted">–</span>';
    var w = Math.min(100, (v / max) * 100), p = (promise / max) * 100;
    return '<div class="bar" role="img" aria-label="' + v + ' days, promise ' + promise + '">' +
      '<span class="bar-fill' + (v > promise ? ' over' : '') + '" style="width:' + w + '%"></span>' +
      '<span class="bar-mark" style="left:' + p + '%"></span></div><span class="bar-val">' + v + '</span>';
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
    if (t.dataset.days) { state.days = t.dataset.days; loadAnalytics(); return; }
  });

  $('flagged-toggle').addEventListener('click', function () { state.flagged = !state.flagged; render(); });
  $('mine-toggle').addEventListener('click', function () { state.mine = !state.mine; render(); });
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

  // ---------- Who are you? Then, for producers, which studio. ----------
  var who = $('who-dialog');
  var pendingName = null;
  function showStep(step) {
    $('who-step-name').hidden = step !== 'name';
    $('who-step-studio').hidden = step !== 'studio';
  }
  function openWho(me) {
    var d = state.data;
    $('who-list').innerHTML = d.team.map(function (t) {
      return '<button type="button" class="who-btn" data-who="' + esc(t.name) + '"><strong>' + esc(t.name) + '</strong>' +
        '<span>' + esc(t.role + (t.studio ? ' · ' + t.studio : '')) + '</span></button>';
    }).join('');
    if (me && me.role === 'Producer') { pickStudio(me.name, me.auto); } else { showStep('name'); }
    if (!who.open) who.showModal();
  }
  function pickStudio(name, auto) {
    pendingName = name;
    var t = state.data.team.filter(function (x) { return x.name === name; })[0] || {};
    $('studio-hint').textContent = t.studio ? 'Your home studio is ' + t.studio + '. Pick another if you are covering a different one today.' : 'You will see everything in this studio.';
    $('studio-list').innerHTML = state.data.studioNames.map(function (s) {
      return '<button type="button" class="who-btn' + (s === t.studio ? ' is-home' : '') + '" data-pick-studio="' + esc(s) + '"><strong>' + esc(s) + '</strong>' +
        '<span>' + (s === t.studio ? 'Home studio' : '&nbsp;') + '</span></button>';
    }).join('');
    $('who-back').hidden = !!auto;
    showStep('studio');
  }
  function submitWho(name, studio) {
    api('/api/whoami', { method: 'POST', body: JSON.stringify({ name: name, studio: studio || '' }) })
      .then(function () { who.close(); state.defaulted = false; state.studio = 'All studios'; state.mine = false; return load(); })
      .catch(function (err) { toast(err.message, true); });
  }
  who.addEventListener('cancel', function (e) { var me = state.data && state.data.me; if (!me || me.needsStudio) e.preventDefault(); });
  who.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.who) {
      var t = state.data.team.filter(function (x) { return x.name === b.dataset.who; })[0];
      if (t && t.role === 'Producer') pickStudio(t.name, false);
      else submitWho(b.dataset.who);
    } else if (b.dataset.pickStudio) {
      submitWho(pendingName, b.dataset.pickStudio);
    } else if (b.id === 'who-back') {
      showStep('name');
    }
  });
  $('switch-user').addEventListener('click', function () {
    var me = state.data.me;
    openWho(null);
    if (me && me.auto && me.role === 'Producer') pickStudio(me.name, true);
  });

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
    var myStudio = me && me.studio;
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
    var pick = (me && studios.indexOf(me.studio) >= 0) ? me.studio : studios[0];
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
    if (document.hidden || state.busy || dlg.open || who.open || cdlg.open || recDlg.open) return;
    load();
  }, 60000);
})();
