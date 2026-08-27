const FUNCTIONS_BASE = "https://us-central1-workshop-booking-system-b791e.cloudfunctions.net";

const dashLoading = document.getElementById("dashLoading");
const dashInvalid = document.getElementById("dashInvalid");
const dashboard = document.getElementById("dashboard");

let currentToken = null;
let allBookings = [];
let allWorkshops = [];

// =================================================================
// Resolve the admin session token: prefer the URL (?token=) since
// that's freshest, falling back to localStorage for repeat visits.
// =================================================================
function getToken() {
  const params = new URLSearchParams(window.location.search);
  let token = params.get("token");

  if (token) {
    localStorage.setItem("adminToken", token);
    window.history.replaceState({}, "", window.location.pathname);
  } else {
    token = localStorage.getItem("adminToken");
  }

  return token;
}

function showInvalid() {
  localStorage.removeItem("adminToken");
  dashLoading.hidden = true;
  dashInvalid.hidden = false;
}

function formatCurrency(n) {
  return `£${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatDateTime(isoString) {
  if (!isoString) return "";
  return new Date(isoString).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// Same composite label used at checkout (course.html / vip-partner.js)
// so bookings can be matched back to the workshop they were made for.
function workshopLabel(w) {
  const locationLabel = w.category === "online" ? (w.location || "") : `📍 ${w.venueName || ""}`;
  return `${w.dateLabel} (${w.times}) — ${locationLabel}`;
}

async function loadDashboard() {
  currentToken = getToken();

  if (!currentToken) {
    showInvalid();
    return;
  }

  try {
    const res = await fetch(`${FUNCTIONS_BASE}/adminDashboard?token=${encodeURIComponent(currentToken)}`);
    if (!res.ok) {
      showInvalid();
      return;
    }
    const data = await res.json();
    renderDashboard(data);
  } catch (err) {
    console.error("Error loading admin dashboard:", err);
    showInvalid();
  }
}

function renderDashboard(data) {
  document.getElementById("sumBookings").textContent = data.summary.totalBookings;
  document.getElementById("sumRevenue").textContent = formatCurrency(data.summary.totalRevenue);
  document.getElementById("sumPartners").textContent = data.summary.totalVipPartners;

  allBookings = data.bookings || [];
  allWorkshops = data.workshops || [];

  renderBookings();
  renderWorkshops();
  renderPartners(data.vipPartners || []);
  renderInvitedPartners(data.invitedPartners || []);

  dashLoading.hidden = true;
  dashboard.hidden = false;
}

// =================================================================
// Tabs
// =================================================================
document.getElementById("adminTabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".admin-tab");
  if (!btn) return;

  document.querySelectorAll(".admin-tab").forEach((b) => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".admin-panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${btn.dataset.tab}`));
});

// =================================================================
// Bookings tab (history + per-booking revenue)
// =================================================================
function renderBookings() {
  const tbody = document.querySelector("#bookingsTable tbody");
  const emptyNote = document.getElementById("bookingsEmpty");

  tbody.innerHTML = "";
  emptyNote.hidden = allBookings.length > 0;

  allBookings.forEach((b) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${b.fullName}</td>
      <td>${b.email}</td>
      <td>${b.workshop || b.courseDate || "—"}</td>
      <td>${b.referralCode || "—"}</td>
      <td>${formatCurrency(b.amountTotal / 100)}</td>
      <td>${formatDateTime(b.createdAt)}</td>
      <td>
        <button class="btn btn-text admin-booking-edit-btn" data-id="${b.id}">Edit</button>
        <button class="btn btn-text admin-booking-delete-btn" data-id="${b.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll(".admin-booking-edit-btn").forEach((btn) =>
    btn.addEventListener("click", () => openBookingForm(btn.dataset.id))
  );
  tbody.querySelectorAll(".admin-booking-delete-btn").forEach((btn) =>
    btn.addEventListener("click", () => deleteBooking(btn.dataset.id))
  );
}

async function deleteBooking(id) {
  if (!confirm("Delete this booking? This can't be undone.")) return;

  try {
    const res = await fetch(`${FUNCTIONS_BASE}/adminDeleteBooking`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: currentToken, id }),
    });
    if (!res.ok) throw new Error("Request failed");
    await loadDashboard();
  } catch (err) {
    console.error("Error deleting booking:", err);
    alert("Something went wrong deleting that booking - please try again.");
  }
}

// =================================================================
// Manual booking form
// =================================================================
const bookingForm = document.getElementById("bookingForm");
const bkSendEmailRow = document.getElementById("bkSendEmailRow");

function openBookingForm(id) {
  const b = id ? allBookings.find((x) => x.id === id) : null;

  document.getElementById("bkId").value = b ? b.id : "";
  document.getElementById("bkFullName").value = b ? b.fullName || "" : "";
  document.getElementById("bkEmail").value = b ? b.email || "" : "";
  document.getElementById("bkCourseDate").value = b ? b.workshop || b.courseDate || "" : "";
  document.getElementById("bkAmount").value = b ? (b.amountTotal || 0) / 100 : 75;
  document.getElementById("bkSubmit").textContent = b ? "Save changes" : "Add booking";
  bkSendEmailRow.hidden = Boolean(b);

  bookingForm.hidden = false;
  bookingForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

document.getElementById("newBookingBtn").addEventListener("click", () => openBookingForm(null));
document.getElementById("bkCancelBtn").addEventListener("click", () => {
  bookingForm.hidden = true;
  bookingForm.reset();
});

bookingForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const id = document.getElementById("bkId").value;
  const submitBtn = document.getElementById("bkSubmit");
  submitBtn.disabled = true;
  submitBtn.textContent = id ? "Saving..." : "Adding...";

  const payload = {
    token: currentToken,
    fullName: document.getElementById("bkFullName").value.trim(),
    email: document.getElementById("bkEmail").value.trim(),
    courseDate: document.getElementById("bkCourseDate").value.trim(),
    amountTotal: Number(document.getElementById("bkAmount").value) || 0,
  };
  if (id) {
    payload.id = id;
    payload.referralCode = allBookings.find((x) => x.id === id)?.referralCode || "";
  } else {
    payload.sendEmail = document.getElementById("bkSendEmail").checked;
  }

  try {
    const res = await fetch(`${FUNCTIONS_BASE}/${id ? "adminUpdateBooking" : "adminAddBooking"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("Request failed");

    bookingForm.hidden = true;
    bookingForm.reset();
    document.getElementById("bkSendEmail").checked = true;
    await loadDashboard();
  } catch (err) {
    console.error("Error saving booking:", err);
    alert("Something went wrong saving that booking - please try again.");
  }

  submitBtn.disabled = false;
  submitBtn.textContent = id ? "Save changes" : "Add booking";
});

// =================================================================
// Workshops tab: list, participants, edit, sold out
// =================================================================
const workshopForm = document.getElementById("workshopForm");
const wsCategory = document.getElementById("wsCategory");

function renderWorkshops() {
  const list = document.getElementById("workshopsList");
  list.innerHTML = "";

  allWorkshops.forEach((w) => {
    const label = workshopLabel(w);
    const participants = allBookings.filter((b) => (b.workshop || b.courseDate) === label);

    const card = document.createElement("div");
    card.className = "admin-workshop";
    card.innerHTML = `
      <div class="admin-workshop-header">
        <div>
          <strong>${w.dateLabel}</strong> - ${w.times}
          ${w.soldOut ? '<span class="admin-badge admin-badge-warning">Sold out</span>' : ""}
          ${w.active === false ? '<span class="admin-badge">Inactive</span>' : ""}
        </div>
        <div class="admin-workshop-actions">
          <button class="btn btn-text admin-edit-btn" data-id="${w.id}">Edit</button>
          <button class="btn btn-text admin-participants-btn" data-id="${w.id}">Participants (${participants.length})</button>
          <button class="btn btn-text admin-delete-btn" data-id="${w.id}">Delete</button>
        </div>
      </div>
      <ul class="admin-participants-list" id="participants-${w.id}" hidden>
        ${participants.length
          ? participants.map((p) => `<li>${p.fullName} - ${p.email}</li>`).join("")
          : "<li>No one's booked yet.</li>"}
      </ul>
    `;
    list.appendChild(card);
  });

  list.querySelectorAll(".admin-edit-btn").forEach((btn) =>
    btn.addEventListener("click", () => openWorkshopForm(btn.dataset.id))
  );
  list.querySelectorAll(".admin-participants-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      const el = document.getElementById(`participants-${btn.dataset.id}`);
      el.hidden = !el.hidden;
    })
  );
  list.querySelectorAll(".admin-delete-btn").forEach((btn) =>
    btn.addEventListener("click", () => deleteWorkshop(btn.dataset.id))
  );
}

async function deleteWorkshop(id) {
  if (!confirm("Delete this workshop? This can't be undone.")) return;

  try {
    const res = await fetch(`${FUNCTIONS_BASE}/adminDeleteWorkshop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: currentToken, id }),
    });
    if (!res.ok) throw new Error("Request failed");
    await loadDashboard();
  } catch (err) {
    console.error("Error deleting workshop:", err);
    alert("Something went wrong deleting that workshop - please try again.");
  }
}

function openWorkshopForm(id) {
  const w = id ? allWorkshops.find((x) => x.id === id) : null;

  document.getElementById("wsId").value = w ? w.id || "" : "";
  document.getElementById("wsDateLabel").value = w ? w.dateLabel || "" : "";
  document.getElementById("wsSortDate").value = w ? w.sortDate || "" : "";
  
  
  // Explicit bracket notation with string fallbacks
  document.getElementById("ws1Session").value = w ? (w["1session"] || "") : "";
  document.getElementById("wsTimes").value = w ? w.times || "6:30pm - 8:00pm" : "6:30pm - 8:00pm";
document.getElementById("ws1StartTime").value = w ? (w["1start_time"] || "18:30") : "18:30";
document.getElementById("ws1EndTime").value = w ? (w["1end_time"] || "20:00") : "20:00";
document.getElementById("ws2StartTime").value = w ? (w["2start_time"] || "18:30") : "18:30";
document.getElementById("ws2EndTime").value = w ? (w["2end_time"] || "20:00") : "20:00";
document.getElementById("wsLocation").value = w ? w.location || "🖥️ Live online" : "🖥️ Live online";
  document.getElementById("ws2Session").value = w ? (w["2session"] || "") : "";
  wsCategory.value = w ? w.category || "online" : "online";
  document.getElementById("wsVenueName").value = w ? w.venueName || "" : "";
  document.getElementById("wsVenueAddress").value = w ? w.venueAddress || "" : "";
  document.getElementById("wsPrice").value = w ? w.price || 75 : 75;
  document.getElementById("wsActive").checked = w ? w.active !== false : true;
  document.getElementById("wsSoldOut").checked = w ? Boolean(w.soldOut) : false;

  workshopForm.hidden = false;
  workshopForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

document.getElementById("newWorkshopBtn").addEventListener("click", () => openWorkshopForm(null));
document.getElementById("wsCancelBtn").addEventListener("click", () => {
  workshopForm.hidden = true;
  workshopForm.reset();
});

workshopForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const submitBtn = document.getElementById("wsSubmit");
  submitBtn.disabled = true;
  submitBtn.textContent = "Saving...";

  const payload = {
    token: currentToken,
    id: document.getElementById("wsId").value || undefined,
    dateLabel: document.getElementById("wsDateLabel").value.trim(),
    sortDate: document.getElementById("wsSortDate").value.trim(),
    times: document.getElementById("wsTimes").value.trim(),
    
    // Explicit string trim to avoid passing whitespace/empty values
    "1session": document.getElementById("ws1Session").value.trim(),
    "1start_time": document.getElementById("ws1StartTime").value.trim(),
    "1end_time": document.getElementById("ws1EndTime").value.trim(),
    "2session": document.getElementById("ws2Session").value.trim(),
    "2start_time": document.getElementById("ws2StartTime").value.trim(),
    "2end_time": document.getElementById("ws2EndTime").value.trim(),
    
    category: wsCategory.value,
    location: document.getElementById("wsLocation").value.trim(),
    venueName: document.getElementById("wsVenueName").value.trim(),
    venueAddress: document.getElementById("wsVenueAddress").value.trim(),
    price: Number(document.getElementById("wsPrice").value),
    active: document.getElementById("wsActive").checked,
    soldOut: document.getElementById("wsSoldOut").checked,
  };

  try {
    const res = await fetch(`${FUNCTIONS_BASE}/adminSaveWorkshop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("Request failed");

    workshopForm.hidden = true;
    workshopForm.reset();
    await loadDashboard();
  } catch (err) {
    console.error("Error saving workshop:", err);
    alert("Something went wrong saving the workshop - please try again.");
  }

  submitBtn.disabled = false;
  submitBtn.textContent = "Save workshop";
});
// =================================================================
// VIP Partners tab: table + invite form
// =================================================================
function renderPartners(partners) {
  const tbody = document.querySelector("#partnersTable tbody");
  tbody.innerHTML = "";

  partners.forEach((p) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${p.name}</td>
      <td>${p.email}</td>
      <td>${p.instagramHandle || "—"}</td>
      <td>${p.discountCode || "—"}</td>
      <td>${p.attended ? "Yes" : "No"}</td>
      <td>${p.usageCount}</td>
      <td>${formatCurrency(p.totalEarned)}</td>
      <td>${formatCurrency(p.nextPayoutAmount)}</td>
      <td>
        ${p.attended ? "" : `<button class="btn btn-text admin-attended-btn" data-id="${p.id}">Mark attended</button>`}
        <button class="btn btn-text admin-partner-delete-btn" data-id="${p.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll(".admin-attended-btn").forEach((btn) =>
    btn.addEventListener("click", () => markPartnerAttended(btn.dataset.id, btn))
  );
  tbody.querySelectorAll(".admin-partner-delete-btn").forEach((btn) =>
    btn.addEventListener("click", () => deletePartner(btn.dataset.id))
  );
}

async function deletePartner(id) {
  if (!confirm("Delete this VIP partner? This removes their referral history and payouts too - this can't be undone.")) return;

  try {
    const res = await fetch(`${FUNCTIONS_BASE}/adminDeletePartner`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: currentToken, id }),
    });
    if (!res.ok) throw new Error("Request failed");
    await loadDashboard();
  } catch (err) {
    console.error("Error deleting VIP partner:", err);
    alert("Something went wrong deleting that partner - please try again.");
  }
}

async function markPartnerAttended(id, btn) {
  if (!confirm("Mark this partner as attended? This activates their discount code and emails them their welcome pack.")) return;

  btn.disabled = true;
  btn.textContent = "Sending...";

  try {
    const res = await fetch(`${FUNCTIONS_BASE}/adminMarkPartnerAttended`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: currentToken, id }),
    });
    if (!res.ok) throw new Error("Request failed");
    await loadDashboard();
  } catch (err) {
    console.error("Error marking partner attended:", err);
    alert("Something went wrong marking that partner as attended - please try again.");
    btn.disabled = false;
    btn.textContent = "Mark attended";
  }
}

function renderInvitedPartners(invited) {
  const tbody = document.querySelector("#invitedTable tbody");
  const emptyNote = document.getElementById("invitedEmpty");

  tbody.innerHTML = "";
  emptyNote.hidden = invited.length > 0;

  invited.forEach((i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i.instagramHandle || "—"}</td>
      <td><button class="btn btn-text admin-invited-delete-btn" data-id="${i.id}">Delete</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll(".admin-invited-delete-btn").forEach((btn) =>
    btn.addEventListener("click", () => deleteInvitedPartner(btn.dataset.id))
  );
}

async function deleteInvitedPartner(id) {
  if (!confirm("Remove this invite? They'll no longer be able to sign up as a VIP partner.")) return;

  try {
    const res = await fetch(`${FUNCTIONS_BASE}/adminDeleteInvitedPartner`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: currentToken, id }),
    });
    if (!res.ok) throw new Error("Request failed");
    await loadDashboard();
  } catch (err) {
    console.error("Error deleting invited partner:", err);
    alert("Something went wrong removing that invite - please try again.");
  }
}

const inviteForm = document.getElementById("inviteForm");
const inviteSubmit = document.getElementById("inviteSubmit");
const inviteSuccess = document.getElementById("inviteSuccess");

inviteForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  inviteSubmit.disabled = true;
  inviteSubmit.textContent = "Adding...";
  inviteSuccess.hidden = true;

  const instagramHandle = document.getElementById("inviteHandle").value.trim();

  try {
    const res = await fetch(`${FUNCTIONS_BASE}/adminInvitePartner`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: currentToken, instagramHandle }),
    });
    if (!res.ok) throw new Error("Request failed");

    inviteForm.reset();
    inviteSuccess.hidden = false;
  } catch (err) {
    console.error("Error inviting VIP partner:", err);
    alert("Something went wrong adding that invite - please try again.");
  }

  inviteSubmit.disabled = false;
  inviteSubmit.textContent = "Add to invite list";
});

loadDashboard();
