// PSAT 8/9 practice — one question per page, hash-routed.
// Routes:
//   #/                       home (exams grouped by subject, with final scores)
//   #/s/<sec>/e/<exam>/q/<n>  question n (1-based) of a module
//   #/s/<sec>/e/<exam>/results
//   #/report                 progress report for tutors (report.js)
//   #/shared/<data>          a report shared as a link (read-only)
//   #/tutor/<code>           live page of wrong/skipped questions, from the database (sync.js)
//   #/connect/<code>         connects this device to a student's online results (sync.js)
//
// <sec> indexes PSAT_DATA (one entry per subject module). The answer key lives
// in key.js and is only decoded to score a finished module; it is never shown
// while a module is in progress, and finished modules are locked.

const DATA = window.PSAT_DATA;
const app = document.getElementById("app");
const STORE_KEY = "psat-progress-v1";
const LETTERS = ["A", "B", "C", "D"];
const SUBJECTS = [
  { label: "Reading and Writing", mods: [0, 1] },
  { label: "Math", mods: [2, 3] },
];

// ---------- answer key ----------
let KEY = null;
function answerKey() {
  if (!KEY) {
    const obf = "psat89";
    const bin = atob(window.PSAT_KEY);
    const bytes = Uint8Array.from(bin, (c, i) => c.charCodeAt(0) ^ obf.charCodeAt(i % obf.length));
    KEY = JSON.parse(new TextDecoder().decode(bytes));
  }
  return KEY;
}

// ---------- progress storage ----------
let progress = {};
try { progress = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { progress = {}; }

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(progress)); } catch {}
}

function examState(s, e) {
  const key = `${s}-${e}`;
  if (!progress[key]) progress[key] = { answers: {}, skipped: {}, time: {}, finished: false };
  return progress[key];
}

// ---------- attempt history (kept across retakes, used by the report) ----------
// Each finished module becomes one attempt: { id, s, e, startedAt, finishedAt, answers, time, synced }.
// Attempts are also saved online when this device is connected (sync.js).
const HISTORY_KEY = "psat-history-v1";
let history = [];
try { history = JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { history = []; }

function saveHistory() {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch {}
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Attempts recorded before online saving existed need an id to sync.
if (history.some(a => !a.id)) {
  history.forEach(a => { if (!a.id) a.id = newId(); });
  saveHistory();
}

function recordAttempt(s, e) {
  const st = examState(s, e);
  history.push({
    id: newId(),
    s, e,
    startedAt: st.startedAt || null,
    finishedAt: st.finishedAt || null,
    answers: { ...st.answers },
    time: { ...(st.time || {}) },
  });
  st.logged = true;
  saveHistory();
  save();
  syncAttempts();
}

// Modules finished before history tracking existed get logged once.
for (const [k, st] of Object.entries(progress)) {
  if (st.finished && !st.logged) {
    const [s, e] = k.split("-").map(Number);
    recordAttempt(s, e);
  }
}

// ---------- time per question ----------
// Counts time while a question is on screen and the tab is visible.
// A single visit is capped at 30 minutes so a forgotten open tab doesn't skew it.
let timer = null;
let pausedTimer = null;

function startTimer(s, e, qid) {
  stopTimer();
  timer = { s, e, qid, t: Date.now() };
}

function stopTimer() {
  if (!timer) return;
  const st = progress[`${timer.s}-${timer.e}`];
  if (st && !st.finished) {
    const secs = Math.min((Date.now() - timer.t) / 1000, 1800);
    st.time = st.time || {};
    st.time[timer.qid] = Math.round((st.time[timer.qid] || 0) + secs);
    save();
  }
  timer = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    pausedTimer = timer && { ...timer };
    stopTimer();
  } else if (pausedTimer) {
    startTimer(pausedTimer.s, pausedTimer.e, pausedTimer.qid);
    pausedTimer = null;
  }
});

function isFinished(s, e) {
  const st = progress[`${s}-${e}`];
  return !!(st && st.finished);
}

// Correct count for a finished module, scored against the answer key.
function moduleScore(s, e) {
  const qs = DATA[s].exams[e];
  const st = examState(s, e);
  const key = answerKey();
  return { correct: qs.filter(q => st.answers[q.id] === key[q.id][0]).length, total: qs.length };
}

// Final score for a whole exam (both modules), or null until both are finished.
function examScore(subject, e) {
  if (!subject.mods.every(s => isFinished(s, e))) return null;
  return subject.mods.map(s => moduleScore(s, e))
    .reduce((a, b) => ({ correct: a.correct + b.correct, total: a.total + b.total }));
}

const pct = sc => Math.round((sc.correct / sc.total) * 100);

// ---------- helpers ----------
function esc(str) {
  return str.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Question text may underline the tested words with <u>…</u>; everything else is escaped.
function richText(str) {
  return esc(str).replace(/&lt;(\/?)u&gt;/g, "<$1u>");
}

// Prompts use "\n" for line breaks and "a | b | c" lines for tables.
function renderPrompt(text) {
  let html = "";
  let table = [];
  const flush = () => {
    if (!table.length) return;
    html += "<table>" + table.map(r => "<tr>" + r.map(c => `<td>${richText(c.trim())}</td>`).join("") + "</tr>").join("") + "</table>";
    table = [];
  };
  for (const line of text.split("\n")) {
    if (line.split(" | ").length >= 3) {
      table.push(line.split(" | "));
    } else {
      flush();
      if (line.trim()) html += `<p>${richText(line)}</p>`;
    }
  }
  flush();
  return html;
}

function subjectOf(s) { return SUBJECTS.find(sub => sub.mods.includes(s)); }
function moduleTitle(s) { return `${subjectOf(s).label} · ${DATA[s].label}`; }
function examPath(s, e) { return `#/s/${s}/e/${e}`; }
function go(hash) { location.hash = hash; }

// ---------- views ----------
function renderHome() {
  document.title = "PSAT 8/9 Practice";
  let html = `<h1>PSAT 8/9 Practice Exams</h1>
    <p class="muted">Each exam has two modules. Finish both to get the exam's final score.
    Your answers are saved in this browser.</p>`;

  SUBJECTS.forEach(sub => {
    html += `<h2>${sub.label}</h2><div class="examGrid">`;
    for (let e = 0; e < 12; e++) {
      const final = examScore(sub, e);
      const rows = sub.mods.map(s => {
        const qs = DATA[s].exams[e];
        const st = progress[`${s}-${e}`];
        let status = "Not started";
        let cls = "";
        let href = `${examPath(s, e)}/q/1`;
        if (st && st.finished) {
          const sc = moduleScore(s, e);
          status = `${sc.correct}/${sc.total}`;
          cls = "done";
          href = `${examPath(s, e)}/results`;
        } else if (st && (Object.keys(st.answers).length || Object.keys(st.skipped).length)) {
          status = `In progress · ${Object.keys(st.answers).length}/${qs.length}`;
          cls = "active";
          const next = qs.findIndex(q => !st.answers[q.id] && !st.skipped[q.id]);
          href = `${examPath(s, e)}/q/${next >= 0 ? next + 1 : 1}`;
        }
        return `<a class="modRow ${cls}" href="${href}"><span>${DATA[s].label}</span><span class="status">${status}</span></a>`;
      }).join("");

      html += `<div class="examCard ${final ? "done" : ""}">
        <div class="examTitle">Exam ${e + 1}</div>
        ${rows}
        <div class="final">${final
          ? `Final score <strong>${final.correct}/${final.total}</strong> · ${pct(final)}%`
          : `<span class="muted">Final score after both modules</span>`}</div>
      </div>`;
    }
    html += `</div>`;
  });
  app.innerHTML = html;
}

function renderQuestion(s, e, n) {
  // Finished modules are locked; send them to their results.
  if (isFinished(s, e)) return location.replace(`${examPath(s, e)}/results`);

  const qs = DATA[s].exams[e];
  const i = n - 1;
  const q = qs[i];
  const st = examState(s, e);
  const selected = st.answers[q.id];
  const isLast = n === qs.length;
  document.title = `Q${n} · Exam ${e + 1} · PSAT 8/9`;
  if (!st.startedAt) { st.startedAt = Date.now(); save(); }
  startTimer(s, e, q.id);

  const nav = qs.map((qq, k) => {
    const cls = [
      st.answers[qq.id] ? "answered" : st.skipped[qq.id] ? "skipped" : "",
      k === i ? "current" : "",
    ].join(" ");
    return `<button class="navDot ${cls}" data-go="${k + 1}" aria-label="Go to question ${k + 1}">${k + 1}</button>`;
  }).join("");

  app.innerHTML = `
    <div class="qHeader">
      <div><a href="#/" class="muted">All exams</a> · <strong>${esc(moduleTitle(s))}</strong> · Exam ${e + 1}</div>
      <div class="muted">Question ${n} of ${qs.length}</div>
    </div>
    <div class="progress"><div style="width:${(n / qs.length) * 100}%"></div></div>

    <div class="card">
      <div class="prompt">${renderPrompt(q.prompt)}</div>
      <ul class="choices">
        ${LETTERS.map(L => `<li><button class="choice ${selected === L ? "selected" : ""}" data-choice="${L}">
          <span class="letter">${L}</span><span>${richText(q.choices[L])}</span></button></li>`).join("")}
      </ul>
      <div class="actions">
        <button class="btn" id="back" ${n === 1 ? "disabled" : ""}>Back</button>
        <span class="spacer"></span>
        <button class="btn" id="skip">Skip</button>
        <button class="btn primary" id="next" ${selected ? "" : "disabled"}>${isLast ? "Finish" : "Next"}</button>
      </div>
    </div>

    <div class="navGrid">${nav}</div>
    <div class="legend">Blue = answered · Orange = skipped · Click a number to jump · Keys: A–D to choose, ← Back, → Next</div>
  `;

  const finishModule = () => {
    const open = qs.filter(qq => !st.answers[qq.id]).length;
    if (open && !confirm(`You have ${open} unanswered question${open > 1 ? "s" : ""}. ` +
      `Unanswered questions are scored as incorrect.\n\nFinish this module?`)) return false;
    stopTimer();
    st.finished = true;
    st.finishedAt = Date.now();
    recordAttempt(s, e);
    go(`${examPath(s, e)}/results`);
    return true;
  };
  const advance = () => isLast ? finishModule() : go(`${examPath(s, e)}/q/${n + 1}`);

  app.querySelectorAll("[data-choice]").forEach(btn => btn.addEventListener("click", () => {
    st.answers[q.id] = btn.dataset.choice;
    delete st.skipped[q.id];
    save();
    renderQuestion(s, e, n);
  }));
  app.querySelectorAll("[data-go]").forEach(btn => btn.addEventListener("click", () => {
    go(`${examPath(s, e)}/q/${btn.dataset.go}`);
  }));
  document.getElementById("back").addEventListener("click", () => go(`${examPath(s, e)}/q/${n - 1}`));
  document.getElementById("skip").addEventListener("click", () => {
    delete st.answers[q.id];
    st.skipped[q.id] = true;
    save();
    if (advance() === false) renderQuestion(s, e, n);
  });
  document.getElementById("next").addEventListener("click", advance);
}

function renderResults(s, e) {
  // Results (and the answer key) are only available once the module is finished.
  if (!isFinished(s, e)) return location.replace(`${examPath(s, e)}/q/1`);

  const qs = DATA[s].exams[e];
  const st = examState(s, e);
  const key = answerKey();
  const sub = subjectOf(s);
  const sc = moduleScore(s, e);
  const final = examScore(sub, e);
  const other = sub.mods.find(m => m !== s);
  document.title = `Results · Exam ${e + 1} · PSAT 8/9`;

  const items = qs.map((q, k) => {
    const [correct, explanation] = key[q.id];
    const mine = st.answers[q.id];
    const tag = !mine ? `<span class="tag skip">Unanswered</span>`
      : mine === correct ? `<span class="tag right">Correct</span>`
      : `<span class="tag wrong">Incorrect</span>`;
    return `<div class="card">
      <div class="qHeader"><strong>Question ${k + 1}</strong>${tag}</div>
      <div class="prompt">${renderPrompt(q.prompt)}</div>
      <div>Your answer: <strong>${mine ? `${mine}. ${richText(q.choices[mine])}` : "—"}</strong></div>
      <div>Correct answer: <strong>${correct}. ${richText(q.choices[correct])}</strong></div>
      <div class="explain">${esc(explanation)}</div>
    </div>`;
  }).join("");

  const finalBlock = final
    ? `<div class="finalBox">Exam ${e + 1} final score (both modules):
         <strong>${final.correct}/${final.total}</strong> · ${pct(final)}%</div>`
    : `<div class="row"><a class="btn primary" href="${examPath(other, e)}/q/1">Continue to ${DATA[other].label}</a></div>`;

  app.innerHTML = `
    <div class="qHeader"><div><a href="#/" class="muted">All exams</a> · <strong>${esc(moduleTitle(s))}</strong> · Exam ${e + 1}</div></div>
    <div class="card">
      <div class="muted">${esc(DATA[s].label)} score</div>
      <div class="score">${sc.correct} / ${sc.total}</div>
      <div class="muted">${pct(sc)}% · ${qs.filter(q => !st.answers[q.id]).length} unanswered</div>
      ${finalBlock}
      <div class="row">
        <button class="btn" id="reset">Retake this module</button>
        <a class="btn" href="#/">All exams</a>
      </div>
    </div>
    <h2>Review</h2>
    <div class="review">${items}</div>
  `;

  document.getElementById("reset").addEventListener("click", () => {
    if (!confirm("Start this module over? This attempt stays in the progress report.")) return;
    delete progress[`${s}-${e}`];
    save();
    go(`${examPath(s, e)}/q/1`);
  });
}

// ---------- router ----------
function route() {
  stopTimer();
  if (location.hash === "#/report") return renderReport();
  if (location.hash.startsWith("#/shared/")) return renderSharedReport(location.hash.slice(9));
  if (location.hash.startsWith("#/tutor/")) return renderTutor(location.hash.slice(8));
  if (location.hash.startsWith("#/connect/")) return connectDevice(location.hash.slice(10));
  const m = location.hash.match(/^#\/s\/(\d+)\/e\/(\d+)\/(?:q\/(\d+)|(results))$/);
  if (m) {
    const s = +m[1], e = +m[2];
    const qs = DATA[s] && DATA[s].exams[e];
    if (qs) {
      if (m[4]) return renderResults(s, e);
      const n = +m[3];
      if (n >= 1 && n <= qs.length) return renderQuestion(s, e, n);
    }
  }
  renderHome();
}

window.addEventListener("hashchange", () => { route(); window.scrollTo(0, 0); });

document.addEventListener("keydown", ev => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const key = ev.key.toUpperCase();
  if (LETTERS.includes(key)) {
    const btn = app.querySelector(`[data-choice="${key}"]`);
    if (btn) btn.click();
  } else if (ev.key === "ArrowLeft") {
    const b = document.getElementById("back");
    if (b && !b.disabled) b.click();
  } else if (ev.key === "ArrowRight") {
    const b = document.getElementById("next");
    if (b && !b.disabled) b.click();
  }
});

route();
syncAttempts();
