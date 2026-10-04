const API = "https://us-central1-workshop-booking-system-b791e.cloudfunctions.net/askAdmin";
const token = localStorage.getItem("adminToken");

const $ = (id) => document.getElementById(id);
let sessions = [];
let current = null;
let pollTimer = null;

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  setTimeout(() => (t.hidden = true), 2500);
}

async function api(body) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, ...body }),
  });
  const data = await res.json();
  if (res.status === 401) {
    localStorage.removeItem("adminToken");
    showView("loginView");
    throw new Error(data.error);
  }
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  kids.forEach((k) => e.append(k));
  return e;
}

function showView(id) {
  ["loginView", "sessionsView", "feedView"].forEach((v) => ($(v).hidden = v !== id));
}

function timeAgo(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

async function loadSessions() {
  try {
    sessions = (await api({ action: "listSessions" })).sessions;
  } catch (e) { if (token) toast(e.message); return; }
  const list = $("sessionList");
  list.replaceChildren();
  if (!sessions.length) {
    list.append(el("p", { className: "empty", textContent: "No sessions yet. Create one above." }));
    return;
  }
  sessions.forEach((s) => {
    const info = el("span", {}, s.name);
    const right = el("span", {});
    if (s.open) right.append(el("span", { className: "badge open", textContent: `${s.open} new` }), " ");
    right.append(el("span", { className: "badge", textContent: `${s.total} total` }));
    list.append(el("button", { className: "session-btn", onclick: () => openFeed(s) }, info, right));
  });
}

async function loadFeed() {
  if (!current) return;
  let questions;
  try {
    questions = (await api({ action: "listQuestions", sessionId: current.id })).questions;
  } catch (e) { return; }
  const feed = $("feed");
  feed.replaceChildren();
  if (!questions.length) {
    feed.append(el("p", { className: "empty", textContent: "No questions yet. This updates automatically." }));
    return;
  }
  questions.forEach((q) => {
    const card = el("div", { className: "card" + (q.answered ? " answered" : "") });
    card.append(el("p", { textContent: q.text }), el("div", { className: "meta", textContent: timeAgo(q.createdAt) }));
    card.append(el("div", { className: "row" },
      el("button", { className: "btn small " + (q.answered ? "ghost" : "green"), textContent: q.answered ? "Mark unanswered" : "Mark answered", onclick: async () => {
        try { await api({ action: "markAnswered", id: q.id, answered: !q.answered }); loadFeed(); } catch (e) { toast(e.message); }
      } }),
      el("button", { className: "btn small danger", textContent: "Delete", onclick: async () => {
        if (!confirm("Delete this question?")) return;
        try { await api({ action: "deleteQuestion", id: q.id }); loadFeed(); } catch (e) { toast(e.message); }
      } })
    ));
    feed.append(card);
  });
}

function openFeed(s) {
  current = s;
  $("feedTitle").textContent = s.name;
  showView("feedView");
  loadFeed();
  clearInterval(pollTimer);
  pollTimer = setInterval(loadFeed, 8000);
}

function closeFeed() {
  clearInterval(pollTimer);
  current = null;
  showView("sessionsView");
  loadSessions();
}

$("newForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("newName").value.trim();
  if (!name) return;
  try {
    await api({ action: "saveSession", name });
    $("newName").value = "";
    loadSessions();
  } catch (err) { toast(err.message); }
});

$("backBtn").addEventListener("click", closeFeed);

$("renameBtn").addEventListener("click", async () => {
  const name = (prompt("Session name", current.name) || "").trim();
  if (!name) return;
  try {
    await api({ action: "saveSession", id: current.id, name });
    current.name = name;
    $("feedTitle").textContent = name;
  } catch (err) { toast(err.message); }
});

$("deleteSessionBtn").addEventListener("click", async () => {
  if (!confirm(`Delete "${current.name}" and all its questions?`)) return;
  try {
    await api({ action: "deleteSession", id: current.id });
    closeFeed();
  } catch (err) { toast(err.message); }
});

if (!token) {
  showView("loginView");
} else {
  showView("sessionsView");
  loadSessions();
}
