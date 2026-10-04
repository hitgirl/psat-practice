// Online saving (Supabase) and the live tutor page.
//
// Each student has a private random code. The device he practices on keeps it
// in localStorage and uploads every finished module under it; the tutor link
// (#/tutor/<code>) reads them back. The database only allows two things, both
// through functions set up by source/supabase-setup.sql: add an attempt, and
// read the attempts for one code. Nothing can be edited or deleted from here.
//
// Uses helpers from app.js and report.js.

const SB = window.PSAT_SUPABASE || {};
const SYNC_KEY = "psat-sync-token";

function syncConfigured() { return !!(SB.url && SB.key); }

function syncToken() {
  try { return localStorage.getItem(SYNC_KEY) || ""; } catch { return ""; }
}

function setSyncToken(token) {
  try { localStorage.setItem(SYNC_KEY, token); } catch {}
}

function newSyncToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return toB64url(bytes); // 24 characters
}

function siteBase() {
  return location.protocol.startsWith("http") ? location.origin + location.pathname : SHARE_BASE;
}

async function rpc(fn, body) {
  const res = await fetch(`${SB.url.replace(/\/$/, "")}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SB.key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// ---------- upload ----------
let syncing = null;
let lastSyncError = "";

// Uploads every attempt not yet saved online. Safe to call often: attempts
// have permanent ids, so a retry never creates duplicates.
function syncAttempts() {
  if (!syncConfigured() || !syncToken()) return Promise.resolve();
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      for (const a of history.filter(x => !x.synced)) {
        await rpc("record_attempt", {
          p_token: syncToken(), p_id: a.id, p_name: studentName() || null,
          p_section: a.s, p_exam: a.e, p_started: a.startedAt, p_finished: a.finishedAt,
          p_answers: a.answers, p_seconds: a.time,
        });
        a.synced = true;
        saveHistory();
      }
      lastSyncError = "";
    } catch (err) {
      lastSyncError = navigator.onLine === false ? "This device is offline." : String(err.message || err);
    } finally {
      syncing = null;
      if (document.getElementById("onlineCard")) renderOnlineCard();
    }
  })();
  return syncing;
}

window.addEventListener("online", () => syncAttempts());

// ---------- report page: online saving controls ----------
function renderOnlineCard() {
  const box = document.getElementById("onlineCard");
  if (!box) return;
  if (!syncConfigured()) { box.innerHTML = ""; return; }

  const token = syncToken();
  if (!token) {
    box.innerHTML = `<div class="card" style="margin-top:12px">
      <strong>Online saving is off on this device</strong>
      <p class="muted small">Turn it on here, on the device he practices on. Every finished module is then saved
      online, and you get a link for tutors that always shows his latest wrong and skipped questions.</p>
      <div class="row"><button class="btn primary" id="syncOn">Turn on online saving</button></div>
    </div>`;
    document.getElementById("syncOn").addEventListener("click", async () => {
      if (!studentName() && !confirm("Add his name above first so tutors see it? Click Cancel to add it, OK to continue without.")) return;
      setSyncToken(newSyncToken());
      renderOnlineCard();
      await syncAttempts();
    });
    return;
  }

  const pending = history.filter(a => !a.synced).length;
  const status = syncing ? "Saving…"
    : lastSyncError ? `<span class="bad">Not saved yet: ${esc(lastSyncError)}. It will retry automatically.</span>`
    : pending ? `${pending} attempt${pending > 1 ? "s" : ""} waiting to save`
    : `All ${history.length} attempt${history.length === 1 ? "" : "s"} saved online`;
  const tutorLink = `${siteBase()}#/tutor/${token}`;
  const connectLink = `${siteBase()}#/connect/${token}`;

  box.innerHTML = `<div class="card onlineOn" style="margin-top:12px">
    <strong>Online saving is on</strong> <span class="muted small">· ${status}</span>
    <p class="muted small">The tutor link always shows his latest results. Anyone with the link can view them (not change them), so share it only with his tutors.</p>
    <div class="row">
      <button class="btn primary" id="copyTutor">Copy tutor link</button>
      <a class="btn" href="${tutorLink}" target="_blank" rel="noopener">Open tutor page</a>
      <button class="btn" id="copyConnect">Copy link to connect another device</button>
      ${lastSyncError || pending ? `<button class="btn" id="retry">Retry now</button>` : ""}
    </div>
    <p class="muted small" id="onlineNote"></p>
  </div>`;

  const copy = async (text, msg) => {
    try { await navigator.clipboard.writeText(text); document.getElementById("onlineNote").textContent = msg; }
    catch { prompt("Copy this link:", text); }
  };
  document.getElementById("copyTutor").addEventListener("click", () =>
    copy(tutorLink, "Tutor link copied. Paste it into a message or email to his tutors."));
  document.getElementById("copyConnect").addEventListener("click", () =>
    copy(connectLink, "Connect link copied. Open it on his other device to save results from there too."));
  const retry = document.getElementById("retry");
  if (retry) retry.addEventListener("click", () => { syncAttempts(); renderOnlineCard(); });
}

// ---------- #/connect/<code> ----------
function connectDevice(token) {
  if (!syncConfigured() || token.length < 20) return go("#/report");
  const current = syncToken();
  if (current && current !== token &&
      !confirm("This device already saves results under a different student code. Switch to the new one?")) {
    return go("#/report");
  }
  setSyncToken(token);
  syncAttempts();
  go("#/report");
}

// ---------- #/tutor/<code> ----------
async function renderTutor(token) {
  document.title = "Questions to review · PSAT 8/9";
  app.innerHTML = `<h1>Questions to review</h1><p class="muted">Loading his latest results…</p>`;
  if (!syncConfigured()) {
    app.innerHTML = `<h1>Questions to review</h1><div class="card">Online saving isn't set up for this site yet.</div>`;
    return;
  }

  let rows;
  try {
    rows = await rpc("get_attempts", { p_token: token });
  } catch (err) {
    app.innerHTML = `<h1>Questions to review</h1><div class="card">Couldn't load results right now. Check the
      connection and reload the page.<p class="muted small">${esc(String(err.message || err))}</p></div>`;
    return;
  }

  const attempts = rows
    .filter(r => DATA[r.section] && DATA[r.section].exams[r.exam])
    .map(r => ({
      id: r.id, s: r.section, e: r.exam,
      startedAt: r.started_at ? Date.parse(r.started_at) : null,
      finishedAt: r.finished_at ? Date.parse(r.finished_at) : null,
      answers: r.answers || {}, time: r.seconds || {},
    }));
  const name = [...rows].reverse().map(r => r.student_name).find(Boolean) || "";

  if (!attempts.length) {
    app.innerHTML = `<h1>Questions to review${name ? ` — ${esc(name)}` : ""}</h1>${noAttemptsHTML()}`;
    return;
  }

  const latest = latestAttempts(attempts);
  const latestList = Object.values(latest);
  const lastActivity = Math.max(...attempts.map(a => a.finishedAt || 0));
  const counts = { all: 0, wrong: 0, skipped: 0 };
  latestList.forEach(a => missedQuestions(a).forEach(({ q }) => {
    counts.all++;
    counts[a.answers[q.id] ? "wrong" : "skipped"]++;
  }));

  let filter = "all";
  const draw = () => {
    app.innerHTML = `
      <h1>Questions to review${name ? ` — ${esc(name)}` : ""}</h1>
      <p class="muted">Live results · last module finished ${fmtDate(lastActivity)}</p>
      ${statsHTML(latestList)}
      <div class="row noPrint filters">
        ${[["all", "All"], ["wrong", "Incorrect"], ["skipped", "Skipped"]].map(([f, label]) =>
          `<button class="btn ${filter === f ? "primary" : ""}" data-filter="${f}">${label} (${counts[f]})</button>`).join("")}
        <button class="btn" id="csv">Download spreadsheet (CSV)</button>
        <button class="btn" id="print">Print / Save as PDF</button>
      </div>
      ${mistakesHTML(latestList, filter)}
      ${scoresHTML(latest)}
      ${attemptsHTML(attempts)}
    `;
    app.querySelectorAll("[data-filter]").forEach(b => b.addEventListener("click", () => {
      filter = b.dataset.filter;
      draw();
    }));
    document.getElementById("csv").addEventListener("click", () => {
      const stamp = new Date().toISOString().slice(0, 10);
      download(`psat-report-${(name || "student").replace(/\W+/g, "-")}-${stamp}.csv`, reportCSV(attempts, name), "text/csv");
    });
    document.getElementById("print").addEventListener("click", () => window.print());
  };
  draw();
}
