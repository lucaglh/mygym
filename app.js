/* MyGym — Trainingsplan, Satz-Tracking, Pausen-Timer, Statistik.
   Alle Daten bleiben lokal auf dem Gerät (localStorage). */

'use strict';

const STORAGE_KEY = 'mygym-data-v1';
const DEFAULT_REST = 90;

/* ---------------- Daten ---------------- */

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function samplePlan() {
  const ex = (name, sets, reps, rest = DEFAULT_REST, notes = '') =>
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

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.sessions) && data.plan) return data;
    }
  } catch (e) { /* korrupte Daten → Neustart mit Beispielplan */ }
  return { version: 1, plan: samplePlan(), sessions: [], activeSession: null };
}

let state = load();

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/* ---------------- Laufzeit-Zustand (nicht persistiert) ---------------- */

let currentTab = state.activeSession ? 'workout' : 'workout';
let expandedSessions = new Set();
let openNotes = new Set();
let statsExName = null;
let elapsedInterval = null;
let restInterval = null;
let wakeLock = null;

/* ---------------- Hilfsfunktionen ---------------- */

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtDate = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
const fmtDateShort = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' });

function fmtDuration(sec) {
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function fmtClock(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const fmtW = (n) => String(n).replace('.', ',');

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

// Letzter Verlaufs-Eintrag für eine Übung (per Name), um Werte vorzubelegen
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

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { /* nicht unterstützt oder abgelehnt — kein Problem */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.activeSession) acquireWakeLock();
});

/* ---------------- Tabs & Rendering ---------------- */

const TITLES = { workout: 'Training', plan: 'Trainingsplan', history: 'Verlauf', stats: 'Statistik' };

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  render();
}

function render() {
  $('#topbar-title').textContent = TITLES[currentTab];
  updateTopbarMeta();
  const view = $('#view');
  if (currentTab === 'workout') renderWorkout(view);
  else if (currentTab === 'plan') renderPlan(view);
  else if (currentTab === 'history') renderHistory(view);
  else renderStats(view);
}

function updateTopbarMeta() {
  const meta = $('#topbar-meta');
  if (currentTab === 'workout' && state.activeSession) {
    const sec = Math.floor((Date.now() - state.activeSession.startedAt) / 1000);
    meta.textContent = fmtClock(sec);
  } else {
    meta.textContent = '';
  }
}

/* ---------------- Ansicht: Training ---------------- */

function renderWorkout(view) {
  if (!state.activeSession) return renderDayPicker(view);
  renderActiveSession(view);
}

function renderDayPicker(view) {
  const days = state.plan.days;
  let html = '<div class="section-title">Trainingstag wählen</div>';
  if (!days.length) {
    html += '<div class="empty">Noch kein Plan vorhanden.<br>Lege im Tab „Plan“ Trainingstage an.</div>';
  }
  for (const day of days) {
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
  view.innerHTML = html;
  view.querySelectorAll('[data-start-day]').forEach((btn) =>
    btn.addEventListener('click', () => startSession(btn.dataset.startDay)));
}

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
    return { exId: ex.id, name: ex.name, targetReps: ex.reps, restSec: ex.restSec ?? DEFAULT_REST, sets };
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
  save();
  acquireWakeLock();
  startElapsedTicker();
  render();
}

function startElapsedTicker() {
  clearInterval(elapsedInterval);
  elapsedInterval = setInterval(updateTopbarMeta, 1000);
}

function renderActiveSession(view) {
  const s = state.activeSession;
  const plan = state.plan.days.find((d) => d.id === s.dayId);
  let html = `
    <div class="session-head">
      <div>
        <div class="sh-title">${esc(s.dayName)}</div>
        <div class="sh-sub">${fmtDate.format(new Date(s.dateISO))}</div>
      </div>
      <button class="btn-ghost" id="cancel-session">Abbrechen</button>
    </div>`;

  s.entries.forEach((entry, ei) => {
    const planEx = plan ? plan.exercises.find((e) => e.id === entry.exId) : null;
    const notes = planEx ? planEx.notes : '';
    const last = lastEntryFor(entry.name);
    const allDone = entry.sets.length > 0 && entry.sets.every((x) => x.done);
    let lastHint = '';
    if (last) {
      const best = last.entry.sets.filter((x) => x.done && x.weight > 0);
      if (best.length) {
        const top = best.reduce((a, b) => (b.weight > a.weight ? b : a));
        lastHint = `<div class="ex-last">Letztes Mal: ${fmtW(top.weight)} kg × ${top.reps}</div>`;
      }
    }
    let rows = '';
    entry.sets.forEach((set, si) => {
      rows += `
        <div class="set-row ${set.done ? 'is-done' : ''}" data-ex="${ei}" data-set="${si}">
          <span class="set-no">Satz ${si + 1}</span>
          <input type="text" inputmode="decimal" enterkeyhint="done" data-field="weight"
                 value="${set.weight || ''}" placeholder="kg" aria-label="Gewicht">
          <input type="text" inputmode="numeric" enterkeyhint="done" data-field="reps"
                 value="${set.reps || ''}" placeholder="${esc(entry.targetReps)}" aria-label="Wiederholungen">
          <button class="set-check" data-check aria-label="Satz abhaken">
            <svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>`;
    });
    const notesOpen = openNotes.has(entry.exId) || false;
    html += `
      <div class="card exercise-card ${allDone ? 'done-all' : ''}" data-excard="${ei}">
        <div class="ex-head">
          <div style="flex:1">
            <div class="ex-name">${esc(entry.name)}</div>
            <div class="ex-target">Ziel: ${entry.sets.length} × ${esc(entry.targetReps)} Wdh. · Pause ${fmtClock(entry.restSec)}</div>
            ${lastHint}
          </div>
        </div>
        <div class="set-col-labels"><span></span><span>kg</span><span>Wdh.</span><span></span></div>
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
  view.querySelectorAll('[data-add-set]').forEach((btn) =>
    btn.addEventListener('click', () => { addSet(+btn.dataset.addSet); }));
  view.querySelectorAll('[data-rm-set]').forEach((btn) =>
    btn.addEventListener('click', () => { removeSet(+btn.dataset.rmSet); }));
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
  if (set.done) startRest(entry.restSec, entry.name);
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
  if (planEx) { planEx.notes = value.trim(); save(); }
}

function finishSession() {
  const s = state.activeSession;
  const doneSets = sessionSetsDone(s);
  if (doneSets === 0 && !confirm('Es wurde kein Satz abgehakt. Training trotzdem speichern?')) return;
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
  switchTab('history');
  expandedSessions = new Set([session.id]);
  render();
}

function cancelSession() {
  if (!confirm('Training wirklich abbrechen? Eingaben gehen verloren.')) return;
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
  save();
  showRestUI();
}

function showRestUI() {
  $('#rest-timer').hidden = false;
  clearInterval(restInterval);
  restInterval = setInterval(tickRest, 250);
  tickRest();
}

function tickRest() {
  const s = state.activeSession;
  if (!s || !s.restEndsAt) return stopRest();
  const remaining = Math.max(0, Math.ceil((s.restEndsAt - Date.now()) / 1000));
  $('#rt-time').textContent = fmtClock(remaining);
  const frac = Math.max(0, (s.restEndsAt - Date.now()) / (s.restTotal * 1000));
  $('#rt-bar').style.width = `${frac * 100}%`;
  if (remaining <= 0) {
    beep();
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    stopRest();
  }
}

function stopRest() {
  clearInterval(restInterval);
  restInterval = null;
  $('#rest-timer').hidden = true;
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

function renderPlan(view) {
  let html = '';
  for (const day of state.plan.days) {
    let rows = '';
    day.exercises.forEach((ex, i) => {
      rows += `
        <div class="plan-ex-row">
          <button class="pe-info" data-edit-ex="${day.id}:${ex.id}" style="all:unset;flex:1;min-width:0;cursor:pointer;padding:2px 0">
            <div class="pe-name">${esc(ex.name)}</div>
            <div class="pe-sub">${ex.sets} × ${esc(ex.reps)} Wdh. · Pause ${fmtClock(ex.restSec ?? DEFAULT_REST)}</div>
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
          <button class="icon-btn" data-rename-day="${day.id}" aria-label="Tag umbenennen">
            <svg viewBox="0 0 24 24"><path d="M4 20l1-4L16 5l3 3L8 19l-4 1zM14 7l3 3" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button class="icon-btn btn-danger" data-del-day="${day.id}" aria-label="Tag löschen">
            <svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V5h6v2m-8 0l1 13h8l1-13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
        ${rows}
        <button class="plan-add-ex" data-add-ex="${day.id}">+ Übung hinzufügen</button>
      </div>`;
  }
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
  view.querySelectorAll('[data-rename-day]').forEach((b) => b.addEventListener('click', () => {
    const day = state.plan.days.find((d) => d.id === b.dataset.renameDay);
    const name = prompt('Name des Trainingstags', day.name);
    if (name && name.trim()) { day.name = name.trim(); save(); render(); }
  }));
  view.querySelectorAll('[data-del-day]').forEach((b) => b.addEventListener('click', () => {
    const day = state.plan.days.find((d) => d.id === b.dataset.delDay);
    if (confirm(`Trainingstag „${day.name}“ mit ${day.exercises.length} Übungen löschen?`)) {
      state.plan.days = state.plan.days.filter((d) => d.id !== day.id);
      save(); render();
    }
  }));
  $('#add-day').addEventListener('click', () => {
    const name = prompt('Name des Trainingstags', '');
    if (name && name.trim()) {
      state.plan.days.push({ id: uid(), name: name.trim(), exercises: [] });
      save(); render();
    }
  });
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
  const day = state.plan.days.find((d) => d.id === dayId);
  const ex = exId ? day.exercises.find((e) => e.id === exId) : null;
  $('#exdlg-title').textContent = ex ? 'Übung bearbeiten' : 'Neue Übung';
  $('#exdlg-name').value = ex ? ex.name : '';
  $('#exdlg-sets').value = ex ? ex.sets : 3;
  $('#exdlg-reps').value = ex ? ex.reps : '10';
  $('#exdlg-rest').value = ex ? (ex.restSec ?? DEFAULT_REST) : DEFAULT_REST;
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
    delBtn.addEventListener('click', () => {
      if (confirm(`„${ex.name}“ aus dem Plan löschen?`)) {
        day.exercises = day.exercises.filter((e) => e.id !== ex.id);
        save();
        $('#exercise-dialog').close();
        render();
      }
    });
    $('#exercise-form .dialog-actions').prepend(delBtn);
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
    restSec: Math.max(0, parseInt($('#exdlg-rest').value, 10) || DEFAULT_REST),
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
    view.innerHTML = '<div class="empty">Noch keine Trainings absolviert.<br>Starte dein erstes Training im Tab „Training“.</div>';
    return;
  }
  let html = '';
  for (const s of sessions) {
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
            <div class="h-sub">${sessionSetsDone(s)} Sätze · ${fmtKg(vol)} Volumen · ${fmtDuration(s.durationSec || 0)}</div>
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
  view.querySelectorAll('[data-del-session]').forEach((b) => b.addEventListener('click', () => {
    if (confirm('Dieses Training endgültig aus dem Verlauf löschen?')) {
      state.sessions = state.sessions.filter((x) => x.id !== b.dataset.delSession);
      save(); render();
    }
  }));
}

/* ---------------- Ansicht: Statistik ---------------- */

function isoWeekStart(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const day = (date.getDay() + 6) % 7; // Mo = 0
  date.setDate(date.getDate() - day);
  return date;
}

function renderStats(view) {
  const sessions = state.sessions;
  const now = new Date();
  const weekStart = isoWeekStart(now);
  const last7 = sessions.filter((s) => now - new Date(s.dateISO) < 7 * 86400000).length;
  const weekVol = sessions
    .filter((s) => new Date(s.dateISO) >= weekStart)
    .reduce((sum, s) => sum + sessionVolume(s), 0);

  // Übungsliste für Auswahl: aus Verlauf + Plan, dedupliziert per Name
  const names = new Set();
  for (const s of sessions) for (const e of s.entries) if (e.sets.some((x) => x.done && x.weight > 0)) names.add(e.name);
  if (!names.size) for (const d of state.plan.days) for (const e of d.exercises) names.add(e.name);
  const nameList = [...names];
  if (!statsExName || !names.has(statsExName)) statsExName = nameList[0] || null;

  let html = `
    <div class="stat-tiles">
      <div class="stat-tile"><div class="st-value">${sessions.length}</div><div class="st-label">Trainings gesamt</div></div>
      <div class="stat-tile"><div class="st-value">${last7}</div><div class="st-label">Letzte 7 Tage</div></div>
      <div class="stat-tile"><div class="st-value">${weekVol >= 1000 ? (weekVol / 1000).toFixed(1).replace('.', ',') + ' t' : Math.round(weekVol)}</div><div class="st-label">Volumen (Woche)</div></div>
    </div>`;

  // --- Gewichtsverlauf pro Übung ---
  html += `<div class="card chart-card">
    <h3>Gewichtsverlauf</h3>
    <div class="chart-sub">Höchstes Gewicht pro Training (kg)</div>
    <select id="stats-ex-select">${nameList.map((n) =>
      `<option value="${esc(n)}" ${n === statsExName ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
    <div class="chart-wrap" id="weight-chart"></div>
  </div>`;

  // --- Wochenvolumen ---
  html += `<div class="card chart-card">
    <h3>Trainingsvolumen pro Woche</h3>
    <div class="chart-sub">Summe Gewicht × Wiederholungen (kg), letzte 8 Wochen</div>
    <div class="chart-wrap" id="volume-chart"></div>
  </div>`;

  html += `
    <div class="section-title">Daten</div>
    <div class="data-tools">
      <button class="btn-ghost" id="export-data">Exportieren</button>
      <button class="btn-ghost" id="import-data">Importieren</button>
    </div>
    <p class="muted" style="margin-top:10px;text-align:center;font-size:12px">
      Alle Daten liegen nur lokal auf diesem Gerät.
    </p>`;

  view.innerHTML = html;

  drawWeightChart();
  drawVolumeChart();

  $('#stats-ex-select').addEventListener('change', (e) => {
    statsExName = e.target.value;
    drawWeightChart();
  });
  $('#export-data').addEventListener('click', exportData);
  $('#import-data').addEventListener('click', () => $('#import-dialog').showModal());
}

function drawWeightChart() {
  const wrap = $('#weight-chart');
  if (!wrap) return;
  const points = [];
  for (const s of state.sessions) {
    const e = s.entries.find((x) => x.name === statsExName);
    if (!e) continue;
    const done = e.sets.filter((x) => x.done && x.weight > 0);
    if (!done.length) continue;
    const top = done.reduce((a, b) => (b.weight > a.weight ? b : a));
    points.push({ label: fmtDateShort.format(new Date(s.dateISO)), value: top.weight, sub: `${fmtW(top.weight)} kg × ${top.reps}` });
  }
  wrap.innerHTML = points.length
    ? lineChartSVG(points, 'kg')
    : '<div class="empty" style="padding:24px">Noch keine Daten für diese Übung.</div>';
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
    : '<div class="empty" style="padding:24px">Noch kein Trainingsvolumen erfasst.</div>';
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

const CHART = { w: 340, h: 190, padL: 42, padR: 12, padT: 12, padB: 26 };

function chartFrame(yMax, yFmt) {
  const { w, h, padL, padR, padT, padB } = CHART;
  const innerH = h - padT - padB;
  let g = '';
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const val = (yMax / ticks) * i;
    const y = padT + innerH - (innerH * i) / ticks;
    g += `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="${i === 0 ? 'var(--baseline)' : 'var(--grid)'}" stroke-width="1"/>`;
    g += `<text x="${padL - 6}" y="${y + 3.5}" text-anchor="end" font-size="10" fill="var(--muted)" font-variant-numeric="tabular-nums">${yFmt(val)}</text>`;
  }
  return g;
}

function lineChartSVG(points, unit) {
  const { w, h, padL, padR, padT, padB } = CHART;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const yMax = niceMax(Math.max(...points.map((p) => p.value)) * 1.1);
  const x = (i) => (points.length === 1 ? padL + innerW / 2 : padL + (innerW * i) / (points.length - 1));
  const y = (v) => padT + innerH - (innerH * v) / yMax;

  let svg = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Gewichtsverlauf">`;
  svg += chartFrame(yMax, (v) => (v % 1 === 0 ? v : v.toFixed(1)));

  if (points.length > 1) {
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
    svg += `<path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  points.forEach((p, i) => {
    svg += `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>`;
    svg += `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="16" fill="transparent" data-tt-label="${esc(p.label)}" data-tt-value="${esc(p.sub)}"/>`;
  });

  // Direktbeschriftung: letzter Wert
  const li = points.length - 1;
  const lx = Math.min(x(li), w - padR - 8);
  svg += `<text x="${lx}" y="${Math.max(12, y(points[li].value) - 10)}" text-anchor="${li === 0 ? 'middle' : 'end'}" font-size="11" font-weight="600" fill="var(--ink-2)" font-variant-numeric="tabular-nums">${fmtW(points[li].value)} ${unit}</text>`;

  // X-Beschriftung: erster und letzter Punkt
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

  let svg = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Wochenvolumen">`;
  svg += chartFrame(yMax, yFmt);

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
    alert('Export wurde in die Zwischenablage kopiert. Speichere ihn z. B. in einer Notiz.');
  } catch (e) {
    prompt('Export-JSON (manuell kopieren):', json);
  }
}

$('#import-cancel').addEventListener('click', () => $('#import-dialog').close());
$('#import-confirm').addEventListener('click', () => {
  try {
    const data = JSON.parse($('#import-text').value);
    if (!data || !data.plan || !Array.isArray(data.sessions)) throw new Error('Format');
    if (!confirm('Aktuelle Daten wirklich durch den Import ersetzen?')) return;
    data.activeSession = null;
    state = data;
    save();
    $('#import-text').value = '';
    $('#import-dialog').close();
    render();
  } catch (e) {
    alert('Import fehlgeschlagen: Das ist kein gültiger MyGym-Export.');
  }
});

/* ---------------- Start ---------------- */

document.querySelectorAll('.tab').forEach((b) =>
  b.addEventListener('click', () => switchTab(b.dataset.tab)));

// Abgelaufene/laufende Pause nach Neustart wiederherstellen
if (state.activeSession) {
  startElapsedTicker();
  acquireWakeLock();
  if (state.activeSession.restEndsAt) {
    if (state.activeSession.restEndsAt > Date.now()) showRestUI();
    else { state.activeSession.restEndsAt = null; state.activeSession.restTotal = null; save(); }
  }
}

switchTab('workout');

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
