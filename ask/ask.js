const API = "https://us-central1-workshop-booking-system-b791e.cloudfunctions.net/askPublic";

let clientId = localStorage.getItem("askClientId");
if (!clientId) {
  clientId = crypto.randomUUID() + crypto.randomUUID();
  localStorage.setItem("askClientId", clientId);
}

const $ = (id) => document.getElementById(id);
let sessionId = null;
let editingId = null;
let questions = [];

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
    body: JSON.stringify({ clientId, ...body }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  kids.forEach((k) => e.append(k));
  return e;
}

async function loadSessions() {
  const list = $("sessionList");
  try {
    const { sessions } = await api({ action: "listSessions" });
    list.replaceChildren();
    if (!sessions.length) {
      list.append(el("p", { className: "empty", textContent: "No sessions are open right now." }));
      return;
    }
    sessions.forEach((s) => {
      const b = el("button", { className: "session-btn", onclick: () => openSession(s.id) },
        el("span", { textContent: s.name }), el("span", { className: "arrow", textContent: "→" }));
      list.append(b);
    });
  } catch (e) {
    list.replaceChildren(el("p", { className: "empty", textContent: "Couldn't load sessions. Please refresh." }));
  }
}

async function openSession(id) {
  try {
    const data = await api({ action: "listMine", sessionId: id });
    sessionId = id;
    history.replaceState({}, "", `?s=${encodeURIComponent(id)}`);
    $("sessionName").textContent = data.session.name;
    questions = data.questions;
    $("pickView").hidden = true;
    $("askView").hidden = false;
    renderQuestions();
  } catch (e) {
    toast(e.message);
    history.replaceState({}, "", location.pathname);
    loadSessions();
  }
}

function renderQuestions() {
  const box = $("myQuestions");
  box.replaceChildren();
  if (!questions.length) {
    box.append(el("p", { className: "empty", textContent: "You haven't asked anything yet." }));
    return;
  }
  questions.forEach((q) => {
    const card = el("div", { className: "card" + (q.answered ? " answered" : "") });
    if (editingId === q.id) {
      const ta = el("textarea", { value: q.text, maxLength: 500 });
      const save = el("button", { className: "btn small", textContent: "Save", onclick: async () => {
        const text = ta.value.trim();
        if (!text) return;
        try {
          await api({ action: "edit", sessionId, questionId: q.id, text });
          q.text = text;
          editingId = null;
          renderQuestions();
        } catch (e) { toast(e.message); }
      } });
      const cancel = el("button", { className: "btn small ghost", textContent: "Cancel", onclick: () => { editingId = null; renderQuestions(); } });
      card.append(ta, el("div", { className: "row" }, save, cancel));
    } else {
      card.append(el("p", { textContent: q.text }));
      const row = el("div", { className: "row" });
      if (q.answered) row.append(el("span", { className: "badge", textContent: "Answered" }));
      row.append(
        el("button", { className: "btn small ghost", textContent: "Edit", onclick: () => { editingId = q.id; renderQuestions(); } }),
        el("button", { className: "btn small danger", textContent: "Delete", onclick: async () => {
          try {
            await api({ action: "delete", sessionId, questionId: q.id });
            questions = questions.filter((x) => x.id !== q.id);
            renderQuestions();
          } catch (e) { toast(e.message); }
        } })
      );
      card.append(row);
    }
    box.append(card);
  });
}

$("askForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("questionInput");
  const text = input.value.trim();
  if (!text) return;
  const btn = $("submitBtn");
  btn.disabled = true;
  try {
    await api({ action: "add", sessionId, text });
    input.value = "";
    const data = await api({ action: "listMine", sessionId });
    questions = data.questions;
    renderQuestions();
    toast("Question sent");
  } catch (err) {
    toast(err.message);
  }
  btn.disabled = false;
});

$("backBtn").addEventListener("click", () => {
  sessionId = null;
  editingId = null;
  history.replaceState({}, "", location.pathname);
  $("askView").hidden = true;
  $("pickView").hidden = false;
  loadSessions();
});

const preset = new URLSearchParams(location.search).get("s");
if (preset) openSession(preset);
else loadSessions();
