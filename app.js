/* MyGym v2 — Trainingsplan, Satz-Tracking, Pausen-Timer, PRs, Statistik.
   Alle Daten bleiben lokal auf dem Gerät (localStorage). */

'use strict';

const STORAGE_KEY = 'mygym-data-v1';
const APP_VERSION = 2;

/* ---------------- Daten ---------------- */

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function samplePlan() {
  const ex = (name, sets, reps, rest = 90, notes = '') =>
    ({ id: uid(), name, sets, reps, restSec: rest, notes });
  return {
    days: [
      { id: uid(), name: 'Push', exercises: [
        ex('Bankdrücken', 3, '8', 150),
        ex('Schrägbank Kurzhanteldrücken', 3, '10'),
        ex('Schulterdrücken', 3, '10'),
        ex('Seitheben', 3, '12', 60),
        ex('Trizepsdrücken am Kabel', 3, '12', 60),
      ]},
      { id: uid(), name: 'Pull', exercises: [
        ex('Latzug', 3, '8', 120),
        ex('Langhantelrudern', 3, '8', 120),
        ex('Rudern am Kabel', 3, '10'),
        ex('Face Pulls', 3, '15', 60),
        ex('Bizepscurls', 3, '12', 60),
      ]},
      { id: uid(), name: 'Beine', exercises: [
        ex('Kniebeugen', 3, '8', 180),
        ex('Beinpresse', 3, '10', 120),
        ex('Rumänisches Kreuzheben', 3, '10', 120),
        ex('Beinstrecker', 3, '12', 60),
        ex('Beincurls', 3, '12', 60),
        ex('Wadenheben', 4, '15', 45),
      ]},
    ],
  };
}

const DEFAULT_SETTINGS = { defaultRestSec: 90, sound: true, vibrate: true };

function migrate(data) {
  data.version = APP_VERSION;
  data.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  data.bodyweight = Array.isArray(data.bodyweight) ? data.bodyweight : [];
  return data;
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.sessions) && data.plan) return migrate(data);
    }
  } catch (e) { /* korrupte Daten → Neustart mit Beispielplan */ }
  return migrate({ plan: samplePlan(), sessions: [], activeSession: null });
}

let state = load();

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/* ---------------- Laufzeit-Zustand ---------------- */

let currentTab = 'home';
let expandedSessions = new Set();
let openNotes = new Set();
let collapsedEx = new Set();
let statsExName = null;
let statsMetric = 'max';   // max | e1rm | vol
let statsRange = 90;       // Tage; 0 = alle
let elapsedInterval = null;
let restInterval = null;
let wakeLock = null;

/* ---------------- Hilfsfunktionen ---------------- */

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtDate = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
const fmtDateShort = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' });
const fmtMonth = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' });

const fmtW = (n) => String(Math.round(n * 100) / 100).replace('.', ',');

function fmtDuration(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function fmtClock(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtKg(n) {
  if (n >= 10000) return `${(n / 1000).toFixed(1).replace('.', ',')} t`;
  return `${Math.round(n).toLocaleString('de-DE')} kg`;
}

function relativeDay(iso) {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / 86400000);
  if (diff === 0) return 'Heute';
  if (diff === 1) return 'Gestern';
  if (diff < 7) return `vor ${diff} Tagen`;
  return fmtDate.format(d);
}

const e1rm = (w, r) => (r > 0 ? w * (1 + Math.min(r, 12) / 30) : w);

function sessionVolume(session) {
  let v = 0;
  for (const e of session.entries)
    for (const s of e.sets)
      if (s.done && s.weight > 0 && s.reps > 0) v += s.weight * s.reps;
  return v;
}

function sessionSetsDone(session) {
  let n = 0;
  for (const e of session.entries) for (const s of e.sets) if (s.done) n++;
  return n;
}

function lastEntryFor(name) {
  for (let i = state.sessions.length - 1; i >= 0; i--) {
    const entry = state.sessions[i].entries.find((e) => e.name === name);
    if (entry && entry.sets.some((s) => s.done)) return { entry, date: state.sessions[i].dateISO };
  }
  return null;
}

function lastSessionForDay(dayId) {
  for (let i = state.sessions.length - 1; i >= 0; i--)
    if (state.sessions[i].dayId === dayId) return state.sessions[i];
  return null;
}

// Bisheriges Maximalgewicht einer Übung (optional eine Session ausklammern)
function maxWeightFor(name, excludeSessionId = null) {
  let max = 0;
  for (const s of state.sessions) {
    if (s.id === excludeSessionId) continue;
    const e = s.entries.find((x) => x.name === name);
    if (!e) continue;
    for (const set of e.sets) if (set.done && set.weight > max) max = set.weight;
  }
  return max;
}

// Lokaler Tagesschlüssel (nicht UTC), damit späte Trainings am richtigen Tag landen
function localDayKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

function isoWeekStart(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const day = (date.getDay() + 6) % 7; // Mo = 0
  date.setDate(date.getDate() - day);
  return date;
}

/* ---------------- UI-Bausteine: Toast, Confirm, Input, Sheet ---------------- */

function toast(msg, { actionLabel, onAction, duration = 2600 } = {}) {
  const wrap = $('#toast-wrap');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (actionLabel) {
    const btn = document.createElement('button');
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => { el.remove(); onAction && onAction(); });
    el.appendChild(btn);
    duration = 8000;
  }
  wrap.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, duration);
}

function uiConfirm(title, text, { okLabel = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    const dlg = $('#confirm-dialog');
    $('#cfm-title').textContent = title;
    $('#cfm-text').textContent = text || '';
    const ok = $('#cfm-ok');
    ok.textContent = okLabel;
    ok.classList.toggle('btn-danger', danger);
    const done = (val) => { dlg.close(); cleanup(); resolve(val); };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onDlgCancel = () => { cleanup(); resolve(false); };
    function cleanup() {
      ok.removeEventListener('click', onOk);
      $('#cfm-cancel').removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onDlgCancel);
    }
    ok.addEventListener('click', onOk);
    $('#cfm-cancel').addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onDlgCancel);
    dlg.showModal();
  });
}

function uiInput(title, { label = '', value = '', placeholder = '', type = 'text' } = {}) {
  return new Promise((resolve) => {
    const dlg = $('#input-dialog');
    $('#inp-title').textContent = title;
    $('#inp-label').textContent = label;
    const inp = $('#inp-value');
    inp.type = type;
    inp.value = value;
    inp.placeholder = placeholder;
    if (type === 'number') { inp.step = 'any'; inp.inputMode = 'decimal'; }
    const done = (val) => { cleanup(); resolve(val); };
    const onSubmit = (e) => { e.preventDefault(); dlg.close(); done(inp.value.trim()); };
    const onCancel = () => { dlg.close(); done(null); };
    const onDlgCancel = () => done(null);
    function cleanup() {
      $('#input-form').removeEventListener('submit', onSubmit);
      $('#inp-cancel').removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onDlgCancel);
    }
    $('#input-form').addEventListener('submit', onSubmit);
    $('#inp-cancel').addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onDlgCancel);
    dlg.showModal();
    setTimeout(() => inp.select(), 50);
  });
}

function uiSheet(title, actions) {
  const dlg = $('#sheet-dialog');
  $('#sheet-title').textContent = title;
  const wrap = $('#sheet-actions');
  wrap.innerHTML = '';
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.textContent = a.label;
    if (a.danger) btn.classList.add('btn-danger');
    btn.addEventListener('click', () => { dlg.close(); a.action(); });
    wrap.appendChild(btn);
  }
  dlg.showModal();
}
$('#sheet-cancel').addEventListener('click', () => $('#sheet-dialog').close());

/* ---------------- Audio & Wake Lock ---------------- */

let audioCtx = null;
function unlockAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}
document.addEventListener('touchend', unlockAudio, { once: true, passive: true });
document.addEventListener('click', unlockAudio, { once: true });

function beep() {
  if (!state.settings.sound) return;
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t0 = audioCtx.currentTime;
  [0, 0.25, 0.5].forEach((off) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    osc.connect(gain).connect(audioCtx.destination);
    gain.gain.setValueAtTime(0.001, t0 + off);
    gain.gain.exponentialRampToValueAtTime(0.4, t0 + off + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + off + 0.18);
    osc.start(t0 + off);
    osc.stop(t0 + off + 0.2);
  });
}

function haptic(pattern = 15) {
  if (state.settings.vibrate && navigator.vibrate) navigator.vibrate(pattern);
}

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { /* nicht unterstützt — kein Problem */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.activeSession) acquireWakeLock();
});

/* ---------------- Tabs & Rendering ---------------- */

const TITLES = { home: 'MyGym', plan: 'Trainingsplan', history: 'Verlauf', stats: 'Statistik' };

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  render();
}

function render() {
  $('#topbar-title').textContent =
    currentTab === 'home' && state.activeSession ? 'Training' : TITLES[currentTab];
  updateTopbarMeta();
  const view = $('#view');
  if (currentTab === 'home') renderHome(view);
  else if (currentTab === 'plan') renderPlan(view);
  else if (currentTab === 'history') renderHistory(view);
  else renderStats(view);
}

function updateTopbarMeta() {
  const meta = $('#topbar-meta');
  if (currentTab === 'home' && state.activeSession) {
    const sec = Math.floor((Date.now() - state.activeSession.startedAt) / 1000);
    meta.textContent = fmtClock(sec);
  } else {
    meta.textContent = '';
  }
}

/* ---------------- Ansicht: Start / Dashboard ---------------- */

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Nachtschicht? 🌙';
  if (h < 11) return 'Guten Morgen 💪';
  if (h < 18) return 'Hey Luca 👋';
  return 'Guten Abend 🔥';
}

function weekStreak() {
  if (!state.sessions.length) return 0;
  const weeks = new Set(state.sessions.map((s) => isoWeekStart(new Date(s.dateISO)).getTime()));
  let streak = 0;
  let cursor = isoWeekStart(new Date()).getTime();
  if (!weeks.has(cursor)) cursor -= 7 * 86400000; // laufende Woche zählt noch nicht negativ
  while (weeks.has(cursor)) { streak++; cursor -= 7 * 86400000; }
  return streak;
}

function suggestedDay() {
  const days = state.plan.days;
  if (!days.length) return null;
  const last = state.sessions[state.sessions.length - 1];
  if (!last) return days[0];
  const idx = days.findIndex((d) => d.id === last.dayId);
  return days[(idx + 1) % days.length] || days[0];
}

function renderHome(view) {
  if (state.activeSession) return renderActiveSession(view);

  const days = state.plan.days;
  const weekStart = isoWeekStart(new Date());
  const trained = new Set(state.sessions
    .filter((s) => new Date(s.dateISO) >= weekStart)
    .map((s) => (new Date(s.dateISO).getDay() + 6) % 7));
  const todayIdx = (new Date().getDay() + 6) % 7;
  const labels = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const streak = weekStreak();

  let dots = '';
  labels.forEach((l, i) => {
    dots += `
      <div class="wd ${trained.has(i) ? 'did' : ''} ${i === todayIdx ? 'today' : ''}">
        <span class="dot">${trained.has(i) ? '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}</span>
        <span class="wl">${l}</span>
      </div>`;
  });

  let html = `
    <div class="hero">
      <div class="greet">${greeting()}</div>
      <div class="greet-sub">${new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</div>
      <div class="hero-row">
        <div class="week-dots">${dots}</div>
        <div class="streak-chip">
          <div class="sc-v">${streak > 0 ? '🔥 ' + streak : '–'}</div>
          <div class="sc-l">Wochen-Streak</div>
        </div>
      </div>
    </div>`;

  const next = suggestedDay();
  if (next) {
    const preview = next.exercises.slice(0, 4).map((e) => e.name).join(' · ');
    const more = next.exercises.length > 4 ? ` · +${next.exercises.length - 4} weitere` : '';
    const last = lastSessionForDay(next.id);
    html += `
      <div class="next-card">
        <div class="nc-kicker">Nächstes Training</div>
        <div class="nc-name">${esc(next.name)}</div>
        <div class="nc-sub">${esc(preview + more)}${last ? `<br>Zuletzt: ${relativeDay(last.dateISO)}` : ''}</div>
        <button class="btn-primary" data-start-day="${next.id}">Training starten</button>
      </div>`;
  }

  const others = days.filter((d) => !next || d.id !== next.id);
  if (others.length) {
    html += '<div class="section-title">Anderes Training</div>';
    for (const day of others) {
      const last = lastSessionForDay(day.id);
      const sub = `${day.exercises.length} Übungen` + (last ? ` · zuletzt ${relativeDay(last.dateISO)}` : '');
      html += `
        <button class="day-pick" data-start-day="${day.id}">
          <span class="day-badge">${esc(day.name.slice(0, 2))}</span>
          <span class="day-info">
            <span class="day-name">${esc(day.name)}</span>
            <div class="day-sub">${esc(sub)}</div>
          </span>
          <svg class="chev" width="20" height="20" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
        </button>`;
    }
  }

  if (!days.length) {
    html += '<div class="empty">Noch kein Plan vorhanden.<br>Lege im Tab „Plan“ Trainingstage an.</div>';
  }

  view.innerHTML = html;
  view.querySelectorAll('[data-start-day]').forEach((btn) =>
    btn.addEventListener('click', () => startSession(btn.dataset.startDay)));
}

/* ---------------- Aktives Training ---------------- */

function startSession(dayId) {
  const day = state.plan.days.find((d) => d.id === dayId);
  if (!day) return;
  const entries = day.exercises.map((ex) => {
    const last = lastEntryFor(ex.name);
    const sets = [];
    for (let i = 0; i < ex.sets; i++) {
      const prev = last ? last.entry.sets.filter((s) => s.done)[i] || last.entry.sets[i] : null;
      sets.push({ weight: prev ? prev.weight : 0, reps: prev ? prev.reps : 0, done: false });
    }
    return { exId: ex.id, name: ex.name, targetReps: ex.reps, restSec: ex.restSec ?? state.settings.defaultRestSec, sets };
  });
  state.activeSession = {
    id: uid(),
    dayId: day.id,
    dayName: day.name,
    dateISO: new Date().toISOString(),
    startedAt: Date.now(),
    entries,
    restEndsAt: null,
    restTotal: null,
  };
  collapsedEx = new Set();
  openNotes = new Set();
  save();
  acquireWakeLock();
  startElapsedTicker();
  switchTab('home');
}

function startElapsedTicker() {
  clearInterval(elapsedInterval);
  elapsedInterval = setInterval(updateTopbarMeta, 1000);
}

function renderActiveSession(view) {
  const s = state.activeSession;
  const plan = state.plan.days.find((d) => d.id === s.dayId);
  const totalSets = s.entries.reduce((n, e) => n + e.sets.length, 0);
  const doneSets = sessionSetsDone(s);
  const pct = totalSets ? Math.round((doneSets / totalSets) * 100) : 0;

  let html = `
    <div class="session-head">
      <div class="sh-row">
        <div>
          <div class="sh-title">${esc(s.dayName)}</div>
          <div class="sh-sub">${doneSets} / ${totalSets} Sätze · ${fmtKg(sessionVolume(s))}</div>
        </div>
        <button class="btn-ghost" id="cancel-session">Abbrechen</button>
      </div>
      <div class="session-progress"><div class="sp-bar" style="width:${pct}%"></div></div>
    </div>`;

  s.entries.forEach((entry, ei) => {
    const planEx = plan ? plan.exercises.find((e) => e.id === entry.exId) : null;
    const notes = planEx ? planEx.notes : '';
    const allDone = entry.sets.length > 0 && entry.sets.every((x) => x.done);
    const doneCnt = entry.sets.filter((x) => x.done).length;

    // Fertige Übung eingeklappt anzeigen
    if (allDone && collapsedEx.has(entry.exId)) {
      const top = entry.sets.filter((x) => x.weight > 0).reduce((a, b) => (b.weight > (a?.weight || 0) ? b : a), null);
      html += `
        <div class="card exercise-card done-all">
          <button class="collapsed-ex" data-expand="${ei}">
            <span class="ce-check"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
            <span class="ce-name">${esc(entry.name)}</span>
            <span class="ce-sum">${top ? `${fmtW(top.weight)} kg × ${top.reps}` : `${doneCnt} Sätze`}</span>
          </button>
        </div>`;
      return;
    }

    const last = lastEntryFor(entry.name);
    let lastHint = '';
    if (last) {
      const best = last.entry.sets.filter((x) => x.done && x.weight > 0);
      if (best.length) {
        const top = best.reduce((a, b) => (b.weight > a.weight ? b : a));
        lastHint = `<div class="ex-last">Letztes Mal: ${fmtW(top.weight)} kg × ${top.reps}</div>`;
      }
    }

    // Live-PR-Hinweis: aktuelles Max in dieser Session vs. Historie
    const prevMax = maxWeightFor(entry.name);
    const sessionMax = Math.max(0, ...entry.sets.filter((x) => x.done).map((x) => x.weight));
    const prBadge = prevMax > 0 && sessionMax > prevMax
      ? '<span class="pr-flash">🏆 PR</span>' : '';

    let rows = '';
    entry.sets.forEach((set, si) => {
      rows += `
        <div class="set-row ${set.done ? 'is-done' : ''}" data-ex="${ei}" data-set="${si}">
          <span class="set-no">${si + 1}</span>
          <input type="text" inputmode="decimal" enterkeyhint="done" data-field="weight"
                 value="${set.weight ? fmtW(set.weight) : ''}" placeholder="kg" aria-label="Gewicht">
          <input type="text" inputmode="numeric" enterkeyhint="done" data-field="reps"
                 value="${set.reps || ''}" placeholder="${esc(entry.targetReps)}" aria-label="Wiederholungen">
          <button class="set-check" data-check aria-label="Satz abhaken">
            <svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>`;
    });

    const notesOpen = openNotes.has(entry.exId);
    html += `
      <div class="card exercise-card ${allDone ? 'done-all' : ''}">
        <div class="ex-head">
          <div style="flex:1">
            <div class="ex-name">${esc(entry.name)}${prBadge}</div>
            <div class="ex-target">Ziel: ${entry.sets.length} × ${esc(entry.targetReps)} Wdh. · Pause ${fmtClock(entry.restSec)}</div>
            ${lastHint}
          </div>
          <span class="ex-progress ${allDone ? 'all' : ''}">${doneCnt}/${entry.sets.length}</span>
        </div>
        <div class="set-col-labels"><span>Satz</span><span>kg</span><span>Wdh.</span><span></span></div>
        <div class="set-grid">${rows}</div>
        <div class="ex-tools">
          <button class="btn-ghost" data-add-set="${ei}">+ Satz</button>
          <button class="btn-ghost" data-rm-set="${ei}" ${entry.sets.length <= 1 ? 'disabled' : ''}>− Satz</button>
          <button class="btn-ghost" data-notes="${ei}">Notizen${notes ? ' •' : ''}</button>
        </div>
        <textarea class="ex-notes" data-notes-input="${ei}" rows="2"
          placeholder="Geräteeinstellung, Technik …" ${notesOpen ? '' : 'hidden'}>${esc(notes)}</textarea>
      </div>`;
  });

  html += `
    <div class="finish-bar">
      <button class="btn-primary" id="finish-session">Training beenden</button>
    </div>`;
  view.innerHTML = html;

  view.querySelectorAll('.set-row input').forEach((inp) => {
    inp.addEventListener('input', onSetInput);
    inp.addEventListener('focus', () => inp.select());
  });
  view.querySelectorAll('[data-check]').forEach((btn) => btn.addEventListener('click', onCheckSet));
  view.querySelectorAll('[data-expand]').forEach((btn) => btn.addEventListener('click', () => {
    collapsedEx.delete(state.activeSession.entries[+btn.dataset.expand].exId);
    render();
  }));
  view.querySelectorAll('[data-add-set]').forEach((btn) =>
    btn.addEventListener('click', () => addSet(+btn.dataset.addSet)));
  view.querySelectorAll('[data-rm-set]').forEach((btn) =>
    btn.addEventListener('click', () => removeSet(+btn.dataset.rmSet)));
  view.querySelectorAll('[data-notes]').forEach((btn) =>
    btn.addEventListener('click', () => toggleNotes(+btn.dataset.notes)));
  view.querySelectorAll('[data-notes-input]').forEach((ta) =>
    ta.addEventListener('change', () => saveNotes(+ta.dataset.notesInput, ta.value)));
  $('#finish-session').addEventListener('click', finishSession);
  $('#cancel-session').addEventListener('click', cancelSession);
}

function parseNum(v) {
  const n = parseFloat(String(v).replace(',', '.'));
  return isFinite(n) && n >= 0 ? n : 0;
}

function onSetInput(e) {
  const row = e.target.closest('.set-row');
  const entry = state.activeSession.entries[+row.dataset.ex];
  const set = entry.sets[+row.dataset.set];
  set[e.target.dataset.field] = parseNum(e.target.value);
  save();
}

function onCheckSet(e) {
  const row = e.target.closest('.set-row');
  const ei = +row.dataset.ex;
  const entry = state.activeSession.entries[ei];
  const set = entry.sets[+row.dataset.set];
  set.done = !set.done;
  save();
  haptic();
  if (set.done) {
    startRest(entry.restSec, entry.name);
    if (entry.sets.every((x) => x.done)) collapsedEx.add(entry.exId);
  }
  render();
}

function addSet(ei) {
  const entry = state.activeSession.entries[ei];
  const prev = entry.sets[entry.sets.length - 1];
  entry.sets.push({ weight: prev ? prev.weight : 0, reps: prev ? prev.reps : 0, done: false });
  save(); render();
}

function removeSet(ei) {
  const entry = state.activeSession.entries[ei];
  if (entry.sets.length > 1) { entry.sets.pop(); save(); render(); }
}

function toggleNotes(ei) {
  const entry = state.activeSession.entries[ei];
  if (openNotes.has(entry.exId)) openNotes.delete(entry.exId);
  else openNotes.add(entry.exId);
  render();
}

function saveNotes(ei, value) {
  const entry = state.activeSession.entries[ei];
  const day = state.plan.days.find((d) => d.id === state.activeSession.dayId);
  const planEx = day ? day.exercises.find((x) => x.id === entry.exId) : null;
  if (planEx) { planEx.notes = value.trim(); save(); toast('Notiz gespeichert'); }
}

async function finishSession() {
  const s = state.activeSession;
  const doneSets = sessionSetsDone(s);
  if (doneSets === 0) {
    const ok = await uiConfirm('Kein Satz abgehakt', 'Training trotzdem speichern?', { okLabel: 'Speichern' });
    if (!ok) return;
  }

  // Neue PRs ermitteln (vor dem Speichern, gegen die bisherige Historie)
  const prs = [];
  for (const e of s.entries) {
    const prevMax = maxWeightFor(e.name);
    const nowMax = Math.max(0, ...e.sets.filter((x) => x.done).map((x) => x.weight));
    if (nowMax > 0 && nowMax > prevMax && prevMax > 0) prs.push({ name: e.name, weight: nowMax, prev: prevMax });
  }

  const prevSame = lastSessionForDay(s.dayId);
  const session = {
    id: s.id,
    dateISO: s.dateISO,
    dayId: s.dayId,
    dayName: s.dayName,
    durationSec: Math.floor((Date.now() - s.startedAt) / 1000),
    entries: s.entries
      .map((e) => ({ exId: e.exId, name: e.name, sets: e.sets.filter((x) => x.done || x.weight > 0 || x.reps > 0) }))
      .filter((e) => e.sets.length > 0),
  };
  state.sessions.push(session);
  state.activeSession = null;
  save();
  stopRest();
  releaseWakeLock();
  clearInterval(elapsedInterval);
  expandedSessions = new Set([session.id]);
  showSummary(session, prs, prevSame);
}

function showSummary(session, prs, prevSame) {
  $('#sum-emoji').textContent = prs.length ? '🏆' : '🎉';
  $('#sum-title').textContent = prs.length ? 'Neue Bestleistung!' : 'Training abgeschlossen!';
  const vol = sessionVolume(session);
  $('#sum-tiles').innerHTML = `
    <div class="sum-tile"><div class="sv">${fmtDuration(session.durationSec)}</div><div class="sl">Dauer</div></div>
    <div class="sum-tile"><div class="sv">${sessionSetsDone(session)}</div><div class="sl">Sätze</div></div>
    <div class="sum-tile"><div class="sv">${fmtKg(vol)}</div><div class="sl">Volumen</div></div>`;
  $('#sum-prs').innerHTML = prs.map((p) => `
    <div class="sum-pr-row">
      <span>🏆</span>
      <span class="spr-name">${esc(p.name)}</span>
      <span class="spr-val">${fmtW(p.weight)} kg <small style="color:var(--muted)">(vorher ${fmtW(p.prev)})</small></span>
    </div>`).join('');
  let cmp = '';
  if (prevSame) {
    const prevVol = sessionVolume(prevSame);
    if (prevVol > 0 && vol > 0) {
      const delta = Math.round(((vol - prevVol) / prevVol) * 100);
      cmp = delta >= 0
        ? `Volumen <b>+${delta} %</b> vs. letztes ${esc(session.dayName)}-Training 📈`
        : `Volumen <b>${delta} %</b> vs. letztes ${esc(session.dayName)}-Training`;
    }
  }
  $('#sum-compare').innerHTML = cmp ? `<div class="sum-compare">${cmp}</div>` : '';
  $('#summary-dialog').showModal();
}

$('#summary-close').addEventListener('click', () => {
  $('#summary-dialog').close();
  switchTab('history');
});

async function cancelSession() {
  const ok = await uiConfirm('Training abbrechen?', 'Alle Eingaben dieses Trainings gehen verloren.', { okLabel: 'Abbrechen bestätigen', danger: true });
  if (!ok) return;
  state.activeSession = null;
  save();
  stopRest();
  releaseWakeLock();
  clearInterval(elapsedInterval);
  render();
}

/* ---------------- Pausen-Timer ---------------- */

function startRest(sec, exName) {
  if (!sec || sec <= 0) return;
  state.activeSession.restEndsAt = Date.now() + sec * 1000;
  state.activeSession.restTotal = sec;
  state.activeSession.restLabel = exName || 'Pause';
  save();
  showRestUI();
}

function showRestUI() {
  $('#rest-timer').hidden = false;
  $('#rt-label').textContent = state.activeSession.restLabel || 'Pause';
  clearInterval(restInterval);
  restInterval = setInterval(tickRest, 250);
  tickRest();
}

function tickRest() {
  const s = state.activeSession;
  if (!s || !s.restEndsAt) return stopRest();
  const remaining = Math.max(0, Math.ceil((s.restEndsAt - Date.now()) / 1000));
  $('#rt-time').textContent = fmtClock(remaining);
  $('#rest-timer').classList.toggle('ending', remaining <= 5 && remaining > 0);
  const frac = Math.max(0, (s.restEndsAt - Date.now()) / (s.restTotal * 1000));
  $('#rt-bar').style.width = `${frac * 100}%`;
  if (remaining <= 0) {
    beep();
    haptic([200, 100, 200]);
    stopRest();
  }
}

function stopRest() {
  clearInterval(restInterval);
  restInterval = null;
  $('#rest-timer').hidden = true;
  $('#rest-timer').classList.remove('ending');
  if (state.activeSession) {
    state.activeSession.restEndsAt = null;
    state.activeSession.restTotal = null;
    save();
  }
}

$('#rt-skip').addEventListener('click', stopRest);
$('#rt-plus').addEventListener('click', () => {
  const s = state.activeSession;
  if (s && s.restEndsAt) {
    s.restEndsAt += 30000;
    s.restTotal += 30;
    save();
    tickRest();
  }
});

/* ---------------- Ansicht: Plan-Editor ---------------- */

let editingEx = null; // {dayId, exId|null}

const COMMON_EXERCISES = [
  'Bankdrücken', 'Schrägbankdrücken', 'Kurzhantel-Bankdrücken', 'Schrägbank Kurzhanteldrücken',
  'Schulterdrücken', 'Arnold Press', 'Seitheben', 'Frontheben', 'Reverse Flys', 'Butterfly',
  'Kabelzug Fliegende', 'Dips', 'Liegestütze', 'Trizepsdrücken am Kabel', 'French Press',
  'Klimmzüge', 'Latzug', 'Latzug eng', 'Langhantelrudern', 'Kurzhantelrudern', 'Rudern am Kabel',
  'T-Bar Rudern', 'Face Pulls', 'Überzüge', 'Bizepscurls', 'Hammercurls', 'Scottcurls',
  'Kniebeugen', 'Frontkniebeugen', 'Beinpresse', 'Ausfallschritte', 'Bulgarian Split Squats',
  'Kreuzheben', 'Rumänisches Kreuzheben', 'Hip Thrusts', 'Beinstrecker', 'Beincurls',
  'Wadenheben', 'Hyperextensions', 'Plank', 'Crunches', 'Beinheben', 'Cable Crunches', 'Russian Twists',
];

function refreshExerciseNames() {
  const names = new Set(COMMON_EXERCISES);
  for (const d of state.plan.days) for (const e of d.exercises) names.add(e.name);
  for (const s of state.sessions) for (const e of s.entries) names.add(e.name);
  $('#exercise-names').innerHTML = [...names].sort((a, b) => a.localeCompare(b, 'de'))
    .map((n) => `<option value="${esc(n)}">`).join('');
}

function renderPlan(view) {
  let html = '';
  state.plan.days.forEach((day, di) => {
    let rows = '';
    day.exercises.forEach((ex, i) => {
      rows += `
        <div class="plan-ex-row">
          <button class="pe-info" data-edit-ex="${day.id}:${ex.id}">
            <div class="pe-name">${esc(ex.name)}</div>
            <div class="pe-sub">${ex.sets} × ${esc(ex.reps)} Wdh. · Pause ${fmtClock(ex.restSec ?? state.settings.defaultRestSec)}</div>
            ${ex.notes ? `<div class="pe-note">📝 ${esc(ex.notes)}</div>` : ''}
          </button>
          <button class="icon-btn" data-move="${day.id}:${ex.id}:-1" aria-label="Nach oben" ${i === 0 ? 'disabled style="opacity:.25"' : ''}>
            <svg viewBox="0 0 24 24"><path d="M6 14l6-6 6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
          </button>
          <button class="icon-btn" data-move="${day.id}:${ex.id}:1" aria-label="Nach unten" ${i === day.exercises.length - 1 ? 'disabled style="opacity:.25"' : ''}>
            <svg viewBox="0 0 24 24"><path d="M6 10l6 6 6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
          </button>
        </div>`;
    });
    html += `
      <div class="card plan-day-card">
        <div class="plan-day-head">
          <span class="pd-name">${esc(day.name)}</span>
          <span class="pd-count">${day.exercises.length} Übungen</span>
          <button class="icon-btn" data-day-menu="${day.id}" aria-label="Optionen">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/></svg>
          </button>
        </div>
        ${rows}
        <button class="plan-add-ex" data-add-ex="${day.id}">+ Übung hinzufügen</button>
      </div>`;
  });
  html += `<button class="btn-ghost" id="add-day" style="width:100%;text-align:center;padding:14px">+ Trainingstag hinzufügen</button>`;
  view.innerHTML = html;

  view.querySelectorAll('[data-edit-ex]').forEach((b) => b.addEventListener('click', () => {
    const [dayId, exId] = b.dataset.editEx.split(':');
    openExerciseDialog(dayId, exId);
  }));
  view.querySelectorAll('[data-add-ex]').forEach((b) =>
    b.addEventListener('click', () => openExerciseDialog(b.dataset.addEx, null)));
  view.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', () => {
    const [dayId, exId, dir] = b.dataset.move.split(':');
    moveExercise(dayId, exId, +dir);
  }));
  view.querySelectorAll('[data-day-menu]').forEach((b) =>
    b.addEventListener('click', () => openDayMenu(b.dataset.dayMenu)));
  $('#add-day').addEventListener('click', async () => {
    const name = await uiInput('Neuer Trainingstag', { label: 'Name', placeholder: 'z. B. Oberkörper' });
    if (name) {
      state.plan.days.push({ id: uid(), name, exercises: [] });
      save(); render();
    }
  });
}

function openDayMenu(dayId) {
  const days = state.plan.days;
  const i = days.findIndex((d) => d.id === dayId);
  const day = days[i];
  const actions = [
    { label: '✏️ Umbenennen', action: async () => {
      const name = await uiInput('Tag umbenennen', { label: 'Name', value: day.name });
      if (name) { day.name = name; save(); render(); }
    }},
    { label: '📋 Duplizieren', action: () => {
      const copy = JSON.parse(JSON.stringify(day));
      copy.id = uid();
      copy.name = day.name + ' (Kopie)';
      copy.exercises.forEach((e) => { e.id = uid(); });
      days.splice(i + 1, 0, copy);
      save(); render(); toast('Tag dupliziert');
    }},
  ];
  if (i > 0) actions.push({ label: '⬆️ Nach oben', action: () => {
    [days[i - 1], days[i]] = [days[i], days[i - 1]]; save(); render();
  }});
  if (i < days.length - 1) actions.push({ label: '⬇️ Nach unten', action: () => {
    [days[i], days[i + 1]] = [days[i + 1], days[i]]; save(); render();
  }});
  actions.push({ label: '🗑 Löschen', danger: true, action: async () => {
    const ok = await uiConfirm(`„${day.name}“ löschen?`, `Der Tag mit ${day.exercises.length} Übungen wird aus dem Plan entfernt. Dein Verlauf bleibt erhalten.`, { okLabel: 'Löschen', danger: true });
    if (ok) { state.plan.days = days.filter((d) => d.id !== day.id); save(); render(); }
  }});
  uiSheet(day.name, actions);
}

function moveExercise(dayId, exId, dir) {
  const day = state.plan.days.find((d) => d.id === dayId);
  const i = day.exercises.findIndex((e) => e.id === exId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= day.exercises.length) return;
  [day.exercises[i], day.exercises[j]] = [day.exercises[j], day.exercises[i]];
  save(); render();
}

function openExerciseDialog(dayId, exId) {
  editingEx = { dayId, exId };
  refreshExerciseNames();
  const day = state.plan.days.find((d) => d.id === dayId);
  const ex = exId ? day.exercises.find((e) => e.id === exId) : null;
  $('#exdlg-title').textContent = ex ? 'Übung bearbeiten' : 'Neue Übung';
  $('#exdlg-name').value = ex ? ex.name : '';
  $('#exdlg-sets').value = ex ? ex.sets : 3;
  $('#exdlg-reps').value = ex ? ex.reps : '10';
  $('#exdlg-rest').value = ex ? (ex.restSec ?? state.settings.defaultRestSec) : state.settings.defaultRestSec;
  $('#exdlg-notes').value = ex ? ex.notes : '';
  let delBtn = $('#exdlg-delete');
  if (delBtn) delBtn.remove();
  if (ex) {
    delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.id = 'exdlg-delete';
    delBtn.className = 'btn-ghost btn-danger';
    delBtn.textContent = 'Löschen';
    delBtn.style.marginRight = 'auto';
    delBtn.addEventListener('click', async () => {
      $('#exercise-dialog').close();
      const ok = await uiConfirm(`„${ex.name}“ löschen?`, 'Die Übung wird aus dem Plan entfernt. Dein Verlauf bleibt erhalten.', { okLabel: 'Löschen', danger: true });
      if (ok) {
        day.exercises = day.exercises.filter((e) => e.id !== ex.id);
        save(); render();
      }
    });
    $('#exdlg-actions').prepend(delBtn);
  }
  $('#exercise-dialog').showModal();
}

$('#exercise-form').addEventListener('submit', () => {
  const { dayId, exId } = editingEx;
  const day = state.plan.days.find((d) => d.id === dayId);
  const data = {
    name: $('#exdlg-name').value.trim(),
    sets: Math.max(1, parseInt($('#exdlg-sets').value, 10) || 3),
    reps: $('#exdlg-reps').value.trim() || '10',
    restSec: Math.max(0, parseInt($('#exdlg-rest').value, 10) || state.settings.defaultRestSec),
    notes: $('#exdlg-notes').value.trim(),
  };
  if (!data.name) return;
  if (exId) {
    Object.assign(day.exercises.find((e) => e.id === exId), data);
  } else {
    day.exercises.push({ id: uid(), ...data });
  }
  save(); render();
});

$('#exdlg-cancel').addEventListener('click', () => $('#exercise-dialog').close());

/* ---------------- Ansicht: Verlauf ---------------- */

function renderHistory(view) {
  const sessions = [...state.sessions].reverse();
  if (!sessions.length) {
    view.innerHTML = '<div class="empty">Noch keine Trainings absolviert.<br>Starte dein erstes Training im Tab „Start“.</div>';
    return;
  }
  let html = '';
  let lastMonth = '';
  for (const s of sessions) {
    const month = fmtMonth.format(new Date(s.dateISO));
    if (month !== lastMonth) {
      html += `<div class="hist-month">${month}</div>`;
      lastMonth = month;
    }
    const open = expandedSessions.has(s.id);
    const vol = sessionVolume(s);
    let detail = '';
    if (open) {
      let exHtml = '';
      for (const e of s.entries) {
        const setsTxt = e.sets
          .map((x) => (x.done ? `${fmtW(x.weight || 0)}×${x.reps || 0}` : `(${fmtW(x.weight || 0)}×${x.reps || 0})`))
          .join('  ·  ');
        exHtml += `<div class="hist-ex"><div class="he-name">${esc(e.name)}</div><div class="he-sets">${setsTxt} kg×Wdh.</div></div>`;
      }
      detail = `
        <div class="hist-detail">
          ${exHtml || '<div class="muted">Keine Sätze erfasst.</div>'}
          <div class="hist-actions">
            <button class="btn-ghost btn-danger" data-del-session="${s.id}">Training löschen</button>
          </div>
        </div>`;
    }
    html += `
      <div class="card hist-card">
        <button class="hist-head" data-toggle-session="${s.id}">
          <div class="h-info">
            <div class="h-title">${esc(s.dayName)} — ${relativeDay(s.dateISO)}</div>
            <div class="h-sub">${sessionSetsDone(s)} Sätze · ${fmtKg(vol)} · ${fmtDuration(s.durationSec || 0)}</div>
          </div>
          <svg width="20" height="20" viewBox="0 0 24 24" style="color:var(--muted);flex:none;transform:rotate(${open ? 180 : 0}deg)">
            <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>
          </svg>
        </button>
        ${detail}
      </div>`;
  }
  view.innerHTML = html;
  view.querySelectorAll('[data-toggle-session]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.toggleSession;
    if (expandedSessions.has(id)) expandedSessions.delete(id);
    else expandedSessions.add(id);
    render();
  }));
  view.querySelectorAll('[data-del-session]').forEach((b) => b.addEventListener('click', async () => {
    const ok = await uiConfirm('Training löschen?', 'Dieses Training wird endgültig aus dem Verlauf entfernt.', { okLabel: 'Löschen', danger: true });
    if (ok) {
      state.sessions = state.sessions.filter((x) => x.id !== b.dataset.delSession);
      save(); render();
    }
  }));
}

/* ---------------- Ansicht: Statistik ---------------- */

function renderStats(view) {
  const sessions = state.sessions;
  const now = new Date();
  const weekStart = isoWeekStart(now);
  const last7 = sessions.filter((s) => now - new Date(s.dateISO) < 7 * 86400000).length;
  const weekVol = sessions
    .filter((s) => new Date(s.dateISO) >= weekStart)
    .reduce((sum, s) => sum + sessionVolume(s), 0);

  const names = new Set();
  for (const s of sessions) for (const e of s.entries) if (e.sets.some((x) => x.done && x.weight > 0)) names.add(e.name);
  if (!names.size) for (const d of state.plan.days) for (const e of d.exercises) names.add(e.name);
  const nameList = [...names].sort((a, b) => a.localeCompare(b, 'de'));
  if (!statsExName || !names.has(statsExName)) statsExName = nameList[0] || null;

  let html = `
    <div class="stat-tiles">
      <div class="stat-tile"><div class="st-value">${sessions.length}</div><div class="st-label">Trainings gesamt</div></div>
      <div class="stat-tile"><div class="st-value">${last7}</div><div class="st-label">Letzte 7 Tage</div></div>
      <div class="stat-tile"><div class="st-value">${weekVol >= 1000 ? (weekVol / 1000).toFixed(1).replace('.', ',') + ' t' : Math.round(weekVol)}</div><div class="st-label">Volumen (Woche)</div></div>
    </div>`;

  html += `<div class="card chart-card">
    <h3>Aktivität</h3>
    <div class="chart-sub">Trainings der letzten 12 Wochen</div>
    ${heatmapHTML()}
  </div>`;

  html += `<div class="card chart-card">
    <h3>Übungs-Fortschritt</h3>
    <select id="stats-ex-select">${nameList.map((n) =>
      `<option value="${esc(n)}" ${n === statsExName ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
    <div class="chart-ctrl">
      <div class="seg" id="seg-metric">
        <button data-m="max" class="${statsMetric === 'max' ? 'on' : ''}">Max</button>
        <button data-m="e1rm" class="${statsMetric === 'e1rm' ? 'on' : ''}">e1RM</button>
        <button data-m="vol" class="${statsMetric === 'vol' ? 'on' : ''}">Volumen</button>
      </div>
      <div class="seg" id="seg-range">
        <button data-r="28" class="${statsRange === 28 ? 'on' : ''}">4 W</button>
        <button data-r="90" class="${statsRange === 90 ? 'on' : ''}">3 M</button>
        <button data-r="0" class="${statsRange === 0 ? 'on' : ''}">Alle</button>
      </div>
    </div>
    <div class="chart-wrap" id="weight-chart"></div>
  </div>`;

  html += `<div class="card chart-card">
    <h3>Trainingsvolumen pro Woche</h3>
    <div class="chart-sub">Summe Gewicht × Wiederholungen (kg), letzte 8 Wochen</div>
    <div class="chart-wrap" id="volume-chart"></div>
  </div>`;

  html += `<div class="card chart-card">
    <h3>Bestwerte</h3>
    <div class="chart-sub">Schwerster Satz und geschätztes 1RM pro Übung</div>
    ${prTableHTML()}
  </div>`;

  const bw = state.bodyweight;
  const bwLast = bw.length ? bw[bw.length - 1] : null;
  html += `<div class="card chart-card">
    <div class="bw-head">
      <div>
        <h3>Körpergewicht</h3>
        <div class="bw-current">${bwLast ? `${fmtW(bwLast.kg)} <small>kg · ${relativeDay(bwLast.dateISO)}</small>` : '<small>Noch kein Eintrag</small>'}</div>
      </div>
      <button class="btn-ghost" id="add-bw">+ Eintrag</button>
    </div>
    <div class="chart-wrap" id="bw-chart"></div>
  </div>`;

  view.innerHTML = html;

  drawWeightChart();
  drawVolumeChart();
  drawBwChart();

  $('#stats-ex-select').addEventListener('change', (e) => {
    statsExName = e.target.value;
    drawWeightChart();
  });
  $('#seg-metric').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    statsMetric = b.dataset.m;
    $('#seg-metric').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    drawWeightChart();
  }));
  $('#seg-range').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    statsRange = +b.dataset.r;
    $('#seg-range').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    drawWeightChart();
  }));
  $('#add-bw').addEventListener('click', async () => {
    const val = await uiInput('Körpergewicht', { label: 'Gewicht in kg', type: 'number', value: bwLast ? String(bwLast.kg) : '', placeholder: 'z. B. 78,5' });
    if (val === null) return;
    const kg = parseNum(val);
    if (kg <= 0) return;
    const today = localDayKey(new Date());
    state.bodyweight = state.bodyweight.filter((x) => localDayKey(x.dateISO) !== today);
    state.bodyweight.push({ dateISO: new Date().toISOString(), kg });
    state.bodyweight.sort((a, b) => a.dateISO.localeCompare(b.dateISO));
    save(); render();
    toast('Gewicht gespeichert');
  });
}

function heatmapHTML() {
  const start = isoWeekStart(new Date());
  const dayVol = new Map();
  for (const s of state.sessions) {
    const key = localDayKey(s.dateISO);
    dayVol.set(key, (dayVol.get(key) || 0) + Math.max(sessionVolume(s), 1));
  }
  const vols = [...dayVol.values()];
  const maxV = Math.max(1, ...vols);
  let cols = '';
  for (let w = 11; w >= 0; w--) {
    const ws = new Date(start); ws.setDate(ws.getDate() - w * 7);
    let cells = '';
    for (let d = 0; d < 7; d++) {
      const day = new Date(ws); day.setDate(day.getDate() + d);
      const key = localDayKey(day);
      const v = dayVol.get(key) || 0;
      let cls = '';
      if (v > 0) {
        const f = v / maxV;
        cls = f > 0.75 ? 'l4' : f > 0.5 ? 'l3' : f > 0.25 ? 'l2' : 'l1';
      }
      const future = day > new Date();
      cells += `<div class="hm-cell ${cls}" ${future ? 'style="opacity:0.25"' : ''} title="${fmtDateShort.format(day)}"></div>`;
    }
    cols += `<div class="hm-col">${cells}</div>`;
  }
  return `<div class="heatmap">${cols}</div>
    <div class="hm-legend"><span>Weniger</span><div class="hm-cell"></div><div class="hm-cell l1"></div><div class="hm-cell l2"></div><div class="hm-cell l3"></div><div class="hm-cell l4"></div><span>Mehr</span></div>`;
}

function prTableHTML() {
  const best = new Map(); // name → {w, r, e}
  for (const s of state.sessions) {
    for (const e of s.entries) {
      for (const set of e.sets) {
        if (!set.done || set.weight <= 0) continue;
        const cur = best.get(e.name);
        const est = e1rm(set.weight, set.reps);
        if (!cur || set.weight > cur.w || (set.weight === cur.w && est > cur.e)) {
          best.set(e.name, { w: set.weight, r: set.reps, e: Math.max(est, cur ? cur.e : 0) });
        } else if (est > cur.e) {
          cur.e = est;
        }
      }
    }
  }
  if (!best.size) return '<div class="chart-empty">Noch keine Trainings erfasst.</div>';
  const rows = [...best.entries()]
    .sort((a, b) => b[1].w - a[1].w)
    .slice(0, 10)
    .map(([name, b]) => `<tr><td>${esc(name)}</td><td>${fmtW(b.w)} kg × ${b.r}</td><td>${fmtW(Math.round(b.e * 10) / 10)} kg</td></tr>`)
    .join('');
  return `<table class="pr-table"><thead><tr><th>Übung</th><th>Bester Satz</th><th>e1RM</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function drawWeightChart() {
  const wrap = $('#weight-chart');
  if (!wrap) return;
  const cutoff = statsRange > 0 ? Date.now() - statsRange * 86400000 : 0;
  const points = [];
  for (const s of state.sessions) {
    if (new Date(s.dateISO).getTime() < cutoff) continue;
    const e = s.entries.find((x) => x.name === statsExName);
    if (!e) continue;
    const done = e.sets.filter((x) => x.done && x.weight > 0);
    if (!done.length) continue;
    let value, sub;
    if (statsMetric === 'vol') {
      value = Math.round(done.reduce((sum, x) => sum + x.weight * x.reps, 0));
      sub = `${fmtKg(value)} Volumen`;
    } else if (statsMetric === 'e1rm') {
      value = Math.round(Math.max(...done.map((x) => e1rm(x.weight, x.reps))) * 10) / 10;
      sub = `≈ ${fmtW(value)} kg 1RM`;
    } else {
      const top = done.reduce((a, b) => (b.weight > a.weight ? b : a));
      value = top.weight;
      sub = `${fmtW(top.weight)} kg × ${top.reps}`;
    }
    points.push({ label: fmtDateShort.format(new Date(s.dateISO)), value, sub });
  }
  const unit = statsMetric === 'vol' ? 'kg Vol.' : 'kg';
  wrap.innerHTML = points.length
    ? lineChartSVG(points, unit)
    : '<div class="chart-empty">Keine Daten für diese Übung im gewählten Zeitraum.</div>';
  attachChartTooltips(wrap);
}

function drawVolumeChart() {
  const wrap = $('#volume-chart');
  if (!wrap) return;
  const weeks = [];
  const start = isoWeekStart(new Date());
  for (let i = 7; i >= 0; i--) {
    const ws = new Date(start); ws.setDate(ws.getDate() - i * 7);
    const we = new Date(ws); we.setDate(we.getDate() + 7);
    const vol = state.sessions
      .filter((s) => { const d = new Date(s.dateISO); return d >= ws && d < we; })
      .reduce((sum, s) => sum + sessionVolume(s), 0);
    weeks.push({ label: fmtDateShort.format(ws), value: Math.round(vol), sub: `${fmtKg(vol)} Volumen` });
  }
  const has = weeks.some((w) => w.value > 0);
  wrap.innerHTML = has
    ? barChartSVG(weeks)
    : '<div class="chart-empty">Noch kein Trainingsvolumen erfasst.</div>';
  attachChartTooltips(wrap);
}

function drawBwChart() {
  const wrap = $('#bw-chart');
  if (!wrap) return;
  const points = state.bodyweight.map((x) => ({
    label: fmtDateShort.format(new Date(x.dateISO)),
    value: x.kg,
    sub: `${fmtW(x.kg)} kg`,
  }));
  if (points.length < 2) {
    wrap.innerHTML = points.length === 1
      ? '<div class="chart-empty">Ab zwei Einträgen erscheint hier dein Verlauf.</div>' : '';
    return;
  }
  wrap.innerHTML = lineChartSVG(points, 'kg', { zoomY: true });
  attachChartTooltips(wrap);
}

/* ---------------- Diagramme (SVG) ---------------- */

function niceMax(v) {
  if (v <= 0) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (m * pow >= v) return m * pow;
  }
  return 10 * pow;
}

const CHART = { w: 340, h: 190, padL: 44, padR: 12, padT: 12, padB: 26 };

function chartFrame(yMin, yMax, yFmt) {
  const { w, h, padL, padR, padT, padB } = CHART;
  const innerH = h - padT - padB;
  let g = '';
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const val = yMin + ((yMax - yMin) / ticks) * i;
    const y = padT + innerH - (innerH * i) / ticks;
    g += `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="${i === 0 ? 'var(--baseline)' : 'var(--grid)'}" stroke-width="1"/>`;
    g += `<text x="${padL - 6}" y="${y + 3.5}" text-anchor="end" font-size="10" fill="var(--muted)">${yFmt(val)}</text>`;
  }
  return g;
}

function lineChartSVG(points, unit, { zoomY = false } = {}) {
  const { w, h, padL, padR, padT, padB } = CHART;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const vMax = Math.max(...points.map((p) => p.value));
  const vMin = Math.min(...points.map((p) => p.value));
  let yMax = niceMax(vMax * 1.05);
  let yMin = 0;
  if (zoomY) {
    const span = Math.max(vMax - vMin, 2);
    yMin = Math.floor((vMin - span * 0.3) / 5) * 5;
    yMax = Math.ceil((vMax + span * 0.3) / 5) * 5;
    if (yMin < 0) yMin = 0;
  }
  const x = (i) => (points.length === 1 ? padL + innerW / 2 : padL + (innerW * i) / (points.length - 1));
  const y = (v) => padT + innerH - (innerH * (v - yMin)) / (yMax - yMin);

  let svg = `<svg viewBox="0 0 ${w} ${h}" role="img">`;
  svg += chartFrame(yMin, yMax, (v) => (v >= 1000 ? `${(v / 1000).toFixed(1).replace('.', ',')}t` : (Math.round(v * 10) / 10).toString().replace('.', ',')));

  if (points.length > 1) {
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
    svg += `<path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  const showDots = points.length <= 40;
  points.forEach((p, i) => {
    if (showDots) svg += `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>`;
    svg += `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="14" fill="transparent" data-tt-label="${esc(p.label)}" data-tt-value="${esc(p.sub)}"/>`;
  });

  const li = points.length - 1;
  const lx = Math.min(x(li), w - padR - 8);
  svg += `<text x="${lx}" y="${Math.max(12, y(points[li].value) - 10)}" text-anchor="${li === 0 ? 'middle' : 'end'}" font-size="11" font-weight="600" fill="var(--ink-2)">${fmtW(points[li].value)} ${unit}</text>`;

  svg += `<text x="${x(0)}" y="${h - 8}" text-anchor="${points.length === 1 ? 'middle' : 'start'}" font-size="10" fill="var(--muted)">${esc(points[0].label)}</text>`;
  if (points.length > 1)
    svg += `<text x="${x(li)}" y="${h - 8}" text-anchor="end" font-size="10" fill="var(--muted)">${esc(points[li].label)}</text>`;
  svg += '</svg>';
  return svg;
}

function barChartSVG(bars) {
  const { w, h, padL, padR, padT, padB } = CHART;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const yMax = niceMax(Math.max(...bars.map((b) => b.value)) * 1.1);
  const n = bars.length;
  const slot = innerW / n;
  const bw = Math.min(28, slot - 8);
  const yFmt = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1).replace('.', ',')}t` : Math.round(v));

  let svg = `<svg viewBox="0 0 ${w} ${h}" role="img">`;
  svg += chartFrame(0, yMax, yFmt);

  bars.forEach((b, i) => {
    const bx = padL + slot * i + (slot - bw) / 2;
    const bh = (innerH * b.value) / yMax;
    const by = padT + innerH - bh;
    if (b.value > 0) {
      const r = Math.min(4, bh);
      svg += `<path d="M${bx},${padT + innerH} v${-(bh - r)} q0,${-r} ${r},${-r} h${bw - 2 * r} q${r},0 ${r},${r} v${bh - r} z" fill="var(--accent)"/>`;
    }
    svg += `<rect x="${padL + slot * i}" y="${padT}" width="${slot}" height="${innerH}" fill="transparent" data-tt-label="Woche ab ${esc(b.label)}" data-tt-value="${esc(b.sub)}"/>`;
    if (i === 0 || i === n - 1 || i === Math.floor(n / 2))
      svg += `<text x="${bx + bw / 2}" y="${h - 8}" text-anchor="middle" font-size="10" fill="var(--muted)">${esc(b.label)}</text>`;
  });
  svg += '</svg>';
  return svg;
}

let ttTimeout = null;
function attachChartTooltips(wrap) {
  const tt = $('#chart-tooltip');
  wrap.querySelectorAll('[data-tt-label]').forEach((el) => {
    el.addEventListener('pointerdown', (e) => {
      tt.innerHTML = `<div class="tt-label">${el.dataset.ttLabel}</div><div class="tt-value">${el.dataset.ttValue}</div>`;
      tt.hidden = false;
      const pad = 10;
      let left = e.clientX + 12;
      let top = e.clientY - 48;
      requestAnimationFrame(() => {
        const r = tt.getBoundingClientRect();
        if (left + r.width > window.innerWidth - pad) left = e.clientX - r.width - 12;
        if (top < pad) top = e.clientY + 16;
        tt.style.left = `${left}px`;
        tt.style.top = `${top}px`;
      });
      clearTimeout(ttTimeout);
      ttTimeout = setTimeout(() => { tt.hidden = true; }, 2200);
    });
  });
}

document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.chart-wrap')) $('#chart-tooltip').hidden = true;
});

/* ---------------- Einstellungen ---------------- */

$('#open-settings').addEventListener('click', () => {
  $('#set-sound').checked = state.settings.sound;
  $('#set-vibrate').checked = state.settings.vibrate;
  $('#set-rest').value = state.settings.defaultRestSec;
  $('#settings-dialog').showModal();
});
$('#settings-close').addEventListener('click', () => $('#settings-dialog').close());
$('#set-sound').addEventListener('change', (e) => { state.settings.sound = e.target.checked; save(); });
$('#set-vibrate').addEventListener('change', (e) => { state.settings.vibrate = e.target.checked; save(); });
$('#set-rest').addEventListener('change', (e) => {
  state.settings.defaultRestSec = Math.max(0, parseInt(e.target.value, 10) || 90);
  save();
});
$('#reset-data').addEventListener('click', async () => {
  $('#settings-dialog').close();
  const ok = await uiConfirm('Wirklich alles löschen?', 'Plan, Verlauf und Körpergewicht werden unwiderruflich gelöscht. Mach vorher ggf. einen Export.', { okLabel: 'Alles löschen', danger: true });
  if (!ok) return;
  localStorage.removeItem(STORAGE_KEY);
  state = load();
  stopRest();
  clearInterval(elapsedInterval);
  switchTab('home');
  toast('Alle Daten zurückgesetzt');
});

/* ---------------- Export / Import ---------------- */

async function exportData() {
  const json = JSON.stringify({ ...state, activeSession: null }, null, 1);
  const stamp = new Date().toISOString().slice(0, 10);
  try {
    if (navigator.share) {
      await navigator.share({ title: `MyGym Export ${stamp}`, text: json });
      return;
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
  }
  try {
    await navigator.clipboard.writeText(json);
    toast('Export in Zwischenablage kopiert');
  } catch (e) {
    await uiInput('Export-JSON (manuell kopieren)', { value: json });
  }
}

$('#export-data').addEventListener('click', exportData);
$('#import-data').addEventListener('click', () => {
  $('#settings-dialog').close();
  $('#import-dialog').showModal();
});
$('#import-cancel').addEventListener('click', () => $('#import-dialog').close());
$('#import-confirm').addEventListener('click', async () => {
  try {
    const data = JSON.parse($('#import-text').value);
    if (!data || !data.plan || !Array.isArray(data.sessions)) throw new Error('Format');
    $('#import-dialog').close();
    const ok = await uiConfirm('Daten ersetzen?', 'Alle aktuellen Daten werden durch den Import ersetzt.', { okLabel: 'Importieren' });
    if (!ok) return;
    data.activeSession = null;
    state = migrate(data);
    save();
    $('#import-text').value = '';
    switchTab('home');
    toast('Import erfolgreich');
  } catch (e) {
    toast('Import fehlgeschlagen: kein gültiger Export');
  }
});

/* ---------------- Start ---------------- */

document.querySelectorAll('.tab').forEach((b) =>
  b.addEventListener('click', () => switchTab(b.dataset.tab)));

if (state.activeSession) {
  startElapsedTicker();
  acquireWakeLock();
  if (state.activeSession.restEndsAt) {
    if (state.activeSession.restEndsAt > Date.now()) showRestUI();
    else { state.activeSession.restEndsAt = null; state.activeSession.restTotal = null; save(); }
  }
}

switchTab('home');

// Service Worker + Update-Hinweis
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw && nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Neue Version verfügbar', {
              actionLabel: 'Aktualisieren',
              onAction: () => location.reload(),
            });
          }
        });
      });
    } catch (e) { /* offline o. ä. */ }
  });
}
