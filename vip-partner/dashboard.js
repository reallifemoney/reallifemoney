const FUNCTIONS_BASE = "https://us-central1-workshop-booking-system-b791e.cloudfunctions.net";

const dashLoading = document.getElementById("dashLoading");
const dashInvalid = document.getElementById("dashInvalid");
const dashboard = document.getElementById("dashboard");

// =================================================================
// Resolve the login session: prefer the URL (?email=&token=) since
// that's freshest, falling back to whatever's saved in localStorage
// so a partner doesn't have to click the email link every visit.
// =================================================================
function getSession() {
  const params = new URLSearchParams(window.location.search);
  let email = params.get("email");
  let token = params.get("token");

  if (email && token) {
    localStorage.setItem("vipPartnerEmail", email);
    localStorage.setItem("vipPartnerToken", token);
    // Clean the token out of the URL bar
    window.history.replaceState({}, "", window.location.pathname);
  } else {
    email = localStorage.getItem("vipPartnerEmail");
    token = localStorage.getItem("vipPartnerToken");
  }

  return { email, token };
}

function formatCurrency(n) {
  return `£${Number(n || 0).toLocaleString()}`;
}

function formatDate(isoDate) {
  if (!isoDate) return "—";
  const d = new Date(`${isoDate}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

function formatDateTime(isoString) {
  if (!isoString) return "";
  return new Date(isoString).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function renderReferrals(referrals) {
  const list = document.getElementById("dashReferralsList");
  const emptyNote = document.getElementById("dashReferralsEmpty");

  list.innerHTML = "";
  if (!referrals.length) {
    emptyNote.hidden = false;
    return;
  }
  emptyNote.hidden = true;

  referrals.forEach((r) => {
    const item = document.createElement("li");
    item.className = "dash-referral-item";
    item.innerHTML = `<span>${r.customerName || "Anonymous"}</span><span>${formatDateTime(r.createdAt)}</span>`;
    list.appendChild(item);
  });
}

let currentSession = { email: null, token: null };

async function loadDashboard() {
  const { email, token } = getSession();
  currentSession = { email, token };

  if (!email || !token) {
    showInvalid();
    return;
  }

  try {
    const res = await fetch(`${FUNCTIONS_BASE}/vipPartnerDashboard?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`);
    if (!res.ok) {
      showInvalid();
      return;
    }
    const data = await res.json();
    renderDashboard(data);
  } catch (err) {
    console.error("Error loading VIP partner dashboard:", err);
    showInvalid();
  }
}

function showInvalid() {
  localStorage.removeItem("vipPartnerEmail");
  localStorage.removeItem("vipPartnerToken");
  dashLoading.hidden = true;
  dashInvalid.hidden = false;
}

function renderDashboard(data) {
  document.getElementById("dashName").textContent = (data.name || "Partner").split(" ")[0];

  if (data.attended) {
    document.getElementById("dashCode").textContent = data.discountCode || "—";
    document.getElementById("dashCodeAttended").hidden = false;
    document.getElementById("dashCodeNotAttended").hidden = true;
  } else {
    document.getElementById("dashCodeAttended").hidden = true;
    document.getElementById("dashCodeNotAttended").hidden = false;
  }

  document.getElementById("dashUsageCount").textContent = data.usageCount || 0;
  document.getElementById("dashTotalEarned").textContent = formatCurrency(data.totalEarned);
  document.getElementById("dashNextPayoutAmount").textContent = formatCurrency(data.nextPayoutAmount);
  document.getElementById("dashNextPayoutDate").textContent = formatDate(data.nextPayoutDate);

  renderReferrals(data.referrals || []);

  const bankMissingNote = document.getElementById("dashBankMissingNote");
  const bankSetNote = document.getElementById("dashBankSetNote");

  if (data.bankDetails) {
    bankSetNote.hidden = false;
    bankMissingNote.hidden = true;
    document.getElementById("bankAccountName").value = data.bankDetails.accountName || "";
    document.getElementById("bankSortCode").value = data.bankDetails.sortCode || "";
    document.getElementById("bankAccountNumber").value = data.bankDetails.accountNumber || "";
  } else {
    bankMissingNote.hidden = false;
    bankSetNote.hidden = true;
  }

  dashLoading.hidden = true;
  dashboard.hidden = false;
}

// =================================================================
// Bank details form
// =================================================================
const bankForm = document.getElementById("bankForm");
const bankSubmit = document.getElementById("bankSubmit");
const bankFormSuccess = document.getElementById("bankFormSuccess");

bankForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  bankSubmit.disabled = true;
  bankSubmit.textContent = "Saving...";
  bankFormSuccess.hidden = true;

  const accountName = document.getElementById("bankAccountName").value.trim();
  const sortCode = document.getElementById("bankSortCode").value.trim();
  const accountNumber = document.getElementById("bankAccountNumber").value.trim();

  try {
    const res = await fetch(`${FUNCTIONS_BASE}/vipPartnerUpdateBankDetails`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: currentSession.email,
        token: currentSession.token,
        accountName,
        sortCode,
        accountNumber,
      }),
    });

    if (!res.ok) throw new Error("Request failed");

    document.getElementById("dashBankMissingNote").hidden = true;
    document.getElementById("dashBankSetNote").hidden = false;
    bankFormSuccess.hidden = false;
  } catch (err) {
    console.error("Error saving bank details:", err);
    alert("Something went wrong saving your bank details - please try again.");
  }

  bankSubmit.disabled = false;
  bankSubmit.textContent = "Save bank details";
});

loadDashboard();
