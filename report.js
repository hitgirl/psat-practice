// Progress report for tutors: scores, every mistake with the correct answer,
// time per question, and the full attempt history (retakes included).
// Shared three ways: a read-only link (the data is packed into the URL, no
// server needed), a CSV for spreadsheets, and print / Save as PDF.
// Uses helpers from app.js (DATA, SUBJECTS, answerKey, esc, renderPrompt, history).

const NAME_KEY = "psat-student-name";
const SHARE_BASE = "https://hitgirl.github.io/psat-practice/";

function studentName() {
  try { return localStorage.getItem(NAME_KEY) || ""; } catch { return ""; }
}

// ---------- formatting ----------
function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function fmtSecs(secs) {
  if (!secs) return "—";
  const m = Math.floor(secs / 60), s = Math.round(secs % 60);
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

function attemptLabel(a) {
  return `${subjectOf(a.s).label} · Exam ${a.e + 1} · ${DATA[a.s].label}`;
}

function scoreAttempt(a) {
  const qs = DATA[a.s].exams[a.e];
  const key = answerKey();
  const correct = qs.filter(q => a.answers[q.id] === key[q.id][0]).length;
  const secs = qs.reduce((t, q) => t + (a.time[q.id] || 0), 0);
  return { correct, total: qs.length, secs };
}

// Latest attempt per module, keyed "s-e".
function latestAttempts(attempts) {
  const latest = {};
  attempts.forEach(a => { latest[`${a.s}-${a.e}`] = a; });
  return latest;
}

// ---------- share-link encoding ----------
// Payload: { n: name, g: generated, a: [[s, e, startedAt, finishedAt, "AB-C...", [secs...]]] }
function packAttempts(attempts) {
  return attempts.map(a => {
    const qs = DATA[a.s].exams[a.e];
    return [a.s, a.e, a.startedAt, a.finishedAt,
      qs.map(q => a.answers[q.id] || "-").join(""),
      qs.map(q => a.time[q.id] || 0)];
  });
}

function unpackAttempts(rows) {
  return rows.map(([s, e, startedAt, finishedAt, ans, secs]) => {
    const qs = DATA[s].exams[e];
    const answers = {}, time = {};
    qs.forEach((q, i) => {
      if (ans[i] && ans[i] !== "-") answers[q.id] = ans[i];
      if (secs[i]) time[q.id] = secs[i];
    });
    return { s, e, startedAt, finishedAt, answers, time };
  });
}

const toB64url = bytes => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64url = str => Uint8Array.from(atob(str.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

async function streamBytes(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

// "z" prefix = deflate-compressed JSON, "j" = plain JSON (older browsers).
async function encodeReport(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  if (window.CompressionStream) {
    return "z" + toB64url(await streamBytes(bytes, new CompressionStream("deflate-raw")));
  }
  return "j" + toB64url(bytes);
}

async function decodeReport(str) {
  let bytes = fromB64url(str.slice(1));
  if (str[0] === "z") bytes = await streamBytes(bytes, new DecompressionStream("deflate-raw"));
  return JSON.parse(new TextDecoder().decode(bytes));
}

// ---------- CSV ----------
function reportCSV(attempts, name) {
  const key = answerKey();
  const cell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["Student", "Subject", "Exam", "Module", "Attempt finished", "Question", "Question ID",
    "Student answer", "Correct answer", "Result", "Seconds", "Question text"]];
  attempts.forEach(a => {
    DATA[a.s].exams[a.e].forEach((q, i) => {
      const mine = a.answers[q.id] || "";
      const correct = key[q.id][0];
      rows.push([name, subjectOf(a.s).label, a.e + 1, DATA[a.s].label, fmtDate(a.finishedAt), i + 1, q.id,
        mine, correct, !mine ? "Unanswered" : mine === correct ? "Correct" : "Incorrect",
        a.time[q.id] || "", q.prompt.replace(/\n/g, " ")]);
    });
  });
  return rows.map(r => r.map(cell).join(",")).join("\r\n");
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob(["﻿" + text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- report sections (shared by the report, snapshot and tutor pages) ----------
function noAttemptsHTML() {
  return `<div class="card"><p class="muted" style="margin:0">No finished modules yet. Scores and mistakes show up here after a module is finished.</p></div>`;
}

function missedQuestions(a) {
  const key = answerKey();
  return DATA[a.s].exams[a.e].map((q, i) => ({ q, i })).filter(({ q }) => a.answers[q.id] !== key[q.id][0]);
}

// Overall numbers, from the latest attempt of each module.
function statsHTML(latestList) {
  const totals = latestList.map(scoreAttempt).reduce((t, x) =>
    ({ correct: t.correct + x.correct, total: t.total + x.total }), { correct: 0, total: 0 });
  const unanswered = latestList.reduce((t, a) =>
    t + DATA[a.s].exams[a.e].filter(q => !a.answers[q.id]).length, 0);
  return `<div class="statRow">
    <div class="stat"><div class="statNum">${latestList.length}</div><div class="muted">modules finished</div></div>
    <div class="stat"><div class="statNum">${Math.round((totals.correct / totals.total) * 100)}%</div><div class="muted">${totals.correct}/${totals.total} correct</div></div>
    <div class="stat"><div class="statNum">${totals.total - totals.correct - unanswered}</div><div class="muted">incorrect</div></div>
    <div class="stat"><div class="statNum">${unanswered}</div><div class="muted">skipped</div></div>
  </div>
  <p class="muted small">Scores and mistakes use the most recent attempt of each module. Earlier attempts are listed under “All attempts”.</p>`;
}

// Scores table per subject.
function scoresHTML(latest) {
  let html = `<h2>Scores</h2>`;
  SUBJECTS.forEach(sub => {
    const exams = [...Array(12).keys()].filter(e => sub.mods.some(s => latest[`${s}-${e}`]));
    if (!exams.length) return;
    html += `<h3>${sub.label}</h3><div class="tableWrap"><table class="data">
      <tr><th>Exam</th>${sub.mods.map(s => `<th>${DATA[s].label}</th>`).join("")}<th>Final</th></tr>`;
    exams.forEach(e => {
      const scores = sub.mods.map(s => latest[`${s}-${e}`] && scoreAttempt(latest[`${s}-${e}`]));
      const final = scores.every(Boolean) &&
        scores.reduce((a, b) => ({ correct: a.correct + b.correct, total: a.total + b.total }));
      html += `<tr><td>Exam ${e + 1}</td>
        ${scores.map(sc => `<td>${sc ? `${sc.correct}/${sc.total}` : `<span class="muted">—</span>`}</td>`).join("")}
        <td>${final ? `<strong>${final.correct}/${final.total}</strong> · ${pct(final)}%` : `<span class="muted">—</span>`}</td></tr>`;
    });
    html += `</table></div>`;
  });
  return html;
}

// Every wrong or skipped question, grouped by module.
// filter: "all" | "wrong" | "skipped"
function mistakesHTML(latestList, filter = "all") {
  const key = answerKey();
  const ordered = latestList.slice().sort((a, b) =>
    SUBJECTS.indexOf(subjectOf(a.s)) - SUBJECTS.indexOf(subjectOf(b.s)) || a.e - b.e || a.s - b.s);
  let html = "";
  ordered.forEach(a => {
    const missed = missedQuestions(a).filter(({ q }) =>
      filter === "all" || (filter === "skipped") === !a.answers[q.id]);
    if (!missed.length) return;
    const sc = scoreAttempt(a);
    html += `<h3>${esc(attemptLabel(a))} <span class="muted small">· ${sc.correct}/${sc.total}${a.finishedAt ? ` · ${fmtDate(a.finishedAt)}` : ""}</span></h3>
      <div class="review">`;
    missed.forEach(({ q, i }) => {
      const mine = a.answers[q.id];
      const [correct, explanation] = key[q.id];
      html += `<div class="card mistake">
        <div class="qHeader"><strong>Question ${i + 1}</strong>
          <span>${mine ? `<span class="tag wrong">Incorrect</span>` : `<span class="tag skip">Skipped</span>`}
          <span class="muted small">${fmtSecs(a.time[q.id])}</span></span></div>
        <div class="prompt">${renderPrompt(q.prompt)}</div>
        <div>Student's answer: <strong>${mine ? `${mine}. ${richText(q.choices[mine])}` : "— (skipped)"}</strong></div>
        <div>Correct answer: <strong>${correct}. ${richText(q.choices[correct])}</strong></div>
        <div class="explain">${esc(explanation)}</div>
      </div>`;
    });
    html += `</div>`;
  });
  return html || `<p class="muted">Nothing to review here on the latest attempts.</p>`;
}

// Full history, newest first.
function attemptsHTML(attempts) {
  let html = `<h2>All attempts</h2><div class="tableWrap"><table class="data">
    <tr><th>Finished</th><th>Module</th><th>Score</th><th>Time</th></tr>`;
  attempts.slice().reverse().forEach(a => {
    const sc = scoreAttempt(a);
    html += `<tr><td>${fmtDate(a.finishedAt)}</td><td>${esc(attemptLabel(a))}</td>
      <td>${sc.correct}/${sc.total} · ${pct(sc)}%</td><td>${fmtSecs(sc.secs)}</td></tr>`;
  });
  return html + `</table></div>`;
}

function reportBody(attempts) {
  if (!attempts.length) return noAttemptsHTML();
  const latest = latestAttempts(attempts);
  const latestList = Object.values(latest);
  return statsHTML(latestList) + scoresHTML(latest) +
    `<h2>Mistakes to review</h2>` + mistakesHTML(latestList) + attemptsHTML(attempts);
}

function renderReport() {
  document.title = "Progress report · PSAT 8/9";
  const name = studentName();
  app.innerHTML = `
    <h1>Progress report</h1>
    <p class="muted">Generated ${fmtDate(Date.now())}</p>
    <div class="card noPrint">
      <label class="label" for="studentName">Student name (shown on the report)</label>
      <input id="studentName" class="input" value="${esc(name)}" placeholder="e.g. Alex" />
      <div class="row">
        <button class="btn" id="share">Copy snapshot link</button>
        <button class="btn" id="csv">Download spreadsheet (CSV)</button>
        <button class="btn" id="print">Print / Save as PDF</button>
      </div>
      <p class="muted small" id="shareNote">A snapshot link shows the report as of now and works without online saving.</p>
    </div>
    <div id="onlineCard" class="noPrint"></div>
    <p class="printOnly"><strong>Student:</strong> ${esc(name || "—")}</p>
    ${reportBody(history)}
  `;

  const nameInput = document.getElementById("studentName");
  nameInput.addEventListener("input", () => {
    try { localStorage.setItem(NAME_KEY, nameInput.value.trim()); } catch {}
    document.querySelector(".printOnly").innerHTML = `<strong>Student:</strong> ${esc(nameInput.value.trim() || "—")}`;
  });

  document.getElementById("share").addEventListener("click", async () => {
    const note = document.getElementById("shareNote");
    const code = await encodeReport({ n: studentName(), g: Date.now(), a: packAttempts(history) });
    const base = location.protocol.startsWith("http") ? location.origin + location.pathname : SHARE_BASE;
    const link = `${base}#/shared/${code}`;
    try {
      await navigator.clipboard.writeText(link);
      note.textContent = "Link copied. Paste it into a message or email to the tutors. It's a snapshot as of now.";
    } catch {
      prompt("Copy this link and send it to the tutors:", link);
    }
  });

  document.getElementById("csv").addEventListener("click", () => {
    const stamp = new Date().toISOString().slice(0, 10);
    download(`psat-report-${(studentName() || "student").replace(/\W+/g, "-")}-${stamp}.csv`,
      reportCSV(history, studentName()), "text/csv");
  });

  document.getElementById("print").addEventListener("click", () => window.print());
  renderOnlineCard();
}

async function renderSharedReport(code) {
  document.title = "Shared progress report · PSAT 8/9";
  let payload;
  try {
    payload = await decodeReport(code);
  } catch {
    app.innerHTML = `<h1>Progress report</h1><div class="card">This report link is incomplete or damaged. Ask for a new link.</div>`;
    return;
  }
  const attempts = unpackAttempts(payload.a);
  app.innerHTML = `
    <h1>Progress report${payload.n ? ` — ${esc(payload.n)}` : ""}</h1>
    <p class="muted">Shared report · snapshot from ${fmtDate(payload.g)}</p>
    <div class="row noPrint" style="margin-bottom:16px">
      <button class="btn" id="csv">Download spreadsheet (CSV)</button>
      <button class="btn" id="print">Print / Save as PDF</button>
    </div>
    ${reportBody(attempts)}
  `;
  document.getElementById("csv").addEventListener("click", () => {
    download(`psat-report-${(payload.n || "student").replace(/\W+/g, "-")}.csv`, reportCSV(attempts, payload.n || ""), "text/csv");
  });
  document.getElementById("print").addEventListener("click", () => window.print());
}
