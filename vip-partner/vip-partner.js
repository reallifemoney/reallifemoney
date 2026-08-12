// =================================================================
// Shared state / elements
// =================================================================
const entryScreen = document.getElementById("entryScreen");
const entryPanel = document.getElementById("entryPanel");
const entrySuccess = document.getElementById("entrySuccess");
const entrySuccessHandle = document.getElementById("entrySuccessHandle");
const mainApp = document.getElementById("mainApp");
const verifyBar = document.getElementById("verifyBar");
const signupForm = document.getElementById("signupForm");
const handleDisplay = document.getElementById("handleDisplay");

let verifiedHandle = null;
signupForm.classList.add("disabled");

function enterApp() {
  entryScreen.classList.add("fade-out");
  setTimeout(() => {
    entryScreen.hidden = true;
    mainApp.hidden = false;
    mainApp.classList.add("fade-in");
  }, 500);
}

// =================================================================
// Instagram handle lookup - shared by the entry screen and the
// sticky bar. Expects a table `invited_partners` with a column
// `instagram_handle`.
// =================================================================
async function checkHandle(rawHandle) {
  const handle = rawHandle.trim().replace(/^@/, "").toLowerCase();
  if (!handle) return { handle: null, found: false, error: null };

  const { data, error } = await supabaseClient
    .from("invited_partners")
    .select("instagram_handle")
    .ilike("instagram_handle", handle)
    .maybeSingle();

  return { handle, found: Boolean(data), error };
}

function markVerified(handle) {
  verifiedHandle = handle;
  handleDisplay.textContent = handle;
  signupForm.classList.remove("disabled");
  verifyBar.classList.add("hidden");
}

// =================================================================
// Entry screen - verify form
// =================================================================
const entryVerifyForm = document.getElementById("entryVerifyForm");
const entryHandleInput = document.getElementById("entryHandleInput");
const entryVerifyBtn = document.getElementById("entryVerifyBtn");
const entryVerifyError = document.getElementById("entryVerifyError");
const confetti = document.getElementById("confetti");

const CONFETTI_COLORS = ["#8c52ff", "#ff914d", "#ffde59", "#71c558"];

function launchConfetti() {
  confetti.innerHTML = "";
  const pieces = 18;
  for (let i = 0; i < pieces; i++) {
    const dot = document.createElement("span");
    dot.style.left = `${5 + Math.random() * 90}%`;
    dot.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    dot.style.animationDelay = `${Math.random() * 0.3}s`;
    dot.style.transform = `rotate(${Math.random() * 360}deg)`;
    confetti.appendChild(dot);
  }
}

entryVerifyBtn.addEventListener("click", handleEntryVerify);
entryHandleInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleEntryVerify();
});

async function handleEntryVerify() {
  entryVerifyError.textContent = "";
  entryVerifyBtn.disabled = true;
  entryVerifyBtn.textContent = "Checking...";

  const { handle, found, error } = await checkHandle(entryHandleInput.value);

  entryVerifyBtn.disabled = false;
  entryVerifyBtn.textContent = "Verify Instagram handle";

  if (!handle) return;

  if (error) {
    entryVerifyError.textContent = "Something went wrong - try again in a moment.";
    return;
  }
  if (!found) {
    entryVerifyError.textContent = "We couldn't find that handle on the invite list.";
    return;
  }

  markVerified(handle);

  // celebratory hand-off, then into the carousel
  entryPanel.hidden = true;
  entrySuccess.hidden = false;
  entrySuccessHandle.textContent = `@${handle}`;
  launchConfetti();

  setTimeout(enterApp, 2200);
}

document.getElementById("entryGuestBtn").addEventListener("click", () => enterApp());

// =================================================================
// Carousel
// =================================================================
const slides = Array.from(document.querySelectorAll(".slide"));
const dotsWrap = document.getElementById("carouselDots");
let current = 0;

slides.forEach((_, i) => {
  const dot = document.createElement("span");
  dot.addEventListener("click", () => goToSlide(i));
  dotsWrap.appendChild(dot);
});

function renderCarousel() {
  slides.forEach((s, i) => s.classList.toggle("active", i === current));
  Array.from(dotsWrap.children).forEach((d, i) => d.classList.toggle("active", i === current));
}

function goToSlide(i) {
  current = Math.max(0, Math.min(slides.length - 1, i));
  renderCarousel();
  document.querySelector(".carousel-wrap").scrollIntoView({ behavior: "smooth", block: "start" });
}

document.querySelectorAll(".next-slide").forEach(btn =>
  btn.addEventListener("click", () => goToSlide(current + 1))
);
document.getElementById("nextArrow").addEventListener("click", () => goToSlide(current + 1));
document.getElementById("prevArrow").addEventListener("click", () => goToSlide(current - 1));

renderCarousel();

// =================================================================
// "Read instead" toggle for the problem slide
// =================================================================
document.getElementById("readInsteadBtn").addEventListener("click", () => {
  const frame = document.getElementById("videoFrame");
  frame.innerHTML = `
    <div class="read-instead">
      <p>Most people leave school able to do algebra, but not able to read a payslip, compare a savings account, or understand what a pension actually does for them. That gap isn't a lack of intelligence - it's a lack of anyone ever sitting down and explaining it properly, in plain English, with no jargon and no sales pitch.</p>
      <p>That's the whole reason the workshop exists.</p>
    </div>`;
});

// =================================================================
// Sticky bar verify (guest path - verifying after entering as guest)
// =================================================================
const verifyBtn = document.getElementById("verifyBtn");
const handleInput = document.getElementById("handleInput");
const verifyError = document.getElementById("verifyError");

verifyBtn.addEventListener("click", async () => {
  verifyBtn.disabled = true;
  verifyBtn.textContent = "Checking...";
  verifyError.textContent = "";

  const { handle, found, error } = await checkHandle(handleInput.value);

  verifyBtn.disabled = false;
  verifyBtn.textContent = "Verify";

  if (!handle) return;

  if (error) {
    verifyError.textContent = "Something went wrong - try again in a moment.";
    return;
  }
  if (!found) {
    verifyError.textContent = "We couldn't find that handle on the invite list.";
    return;
  }

  markVerified(handle);
});

// =================================================================
// Earnings slider + chart
// Tiers: £30 for 1-5, £20 for 6-10, £15 for 11+, +£50 bonus at 20,
// +£100 bonus at 50
// =================================================================
function calcEarnings(n) {
  if (n <= 0) return 0;
  let total = 0;
  total += Math.min(n, 5) * 30;
  if (n > 5) total += Math.min(n - 5, 5) * 20;
  if (n > 10) total += (n - 10) * 15;
  if (n >= 20) total += 50;
  if (n >= 50) total += 100;
  return total;
}

const slider = document.getElementById("earningsSlider");
const earningsCount = document.getElementById("earningsCount");
const earningsAmount = document.getElementById("earningsAmount");
const canvas = document.getElementById("earningsChart");
const ctx = canvas.getContext("2d");

const CHART_MAX_N = 50;
const CHART_MAX_VAL = calcEarnings(CHART_MAX_N);

function drawChart(highlightN) {
  const w = canvas.width, h = canvas.height;
  const padL = 10, padR = 10, padT = 16, padB = 10;
  ctx.clearRect(0, 0, w, h);

  const points = [];
  for (let n = 0; n <= CHART_MAX_N; n++) {
    const x = padL + (n / CHART_MAX_N) * (w - padL - padR);
    const y = h - padB - (calcEarnings(n) / CHART_MAX_VAL) * (h - padT - padB);
    points.push([x, y]);
  }

  // filled area
  ctx.beginPath();
  ctx.moveTo(points[0][0], h - padB);
  points.forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.lineTo(points[points.length - 1][0], h - padB);
  ctx.closePath();
  ctx.fillStyle = "rgba(140, 82, 255, 0.10)";
  ctx.fill();

  // line
  ctx.beginPath();
  points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.strokeStyle = "#8c52ff";
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.stroke();

  // milestone markers at 20 and 50
  [20, 50].forEach(n => {
    const x = padL + (n / CHART_MAX_N) * (w - padL - padR);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, h - padB);
    ctx.strokeStyle = "#ffde59";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  });

  // highlighted point
  const hx = padL + (highlightN / CHART_MAX_N) * (w - padL - padR);
  const hy = h - padB - (calcEarnings(highlightN) / CHART_MAX_VAL) * (h - padT - padB);
  ctx.beginPath();
  ctx.arc(hx, hy, 7, 0, Math.PI * 2);
  ctx.fillStyle = "#ff914d";
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
}

function updateEarnings() {
  const n = Number(slider.value);
  earningsCount.textContent = n;
  earningsAmount.textContent = `£${calcEarnings(n).toLocaleString()}`;
  drawChart(n);
}

slider.addEventListener("input", updateEarnings);
updateEarnings();

// =================================================================
// Sign-up form -> Supabase
// Expects a table `partners` with columns:
// name, email, instagram_handle, discount_code, attended (bool)
// =================================================================
signupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!verifiedHandle) return;

  const submitBtn = document.getElementById("signupSubmit");
  submitBtn.disabled = true;
  submitBtn.textContent = "Signing up...";

  const name = document.getElementById("nameInput").value.trim();
  const email = document.getElementById("emailInput").value.trim();
  const discountCode = generateDiscountCode(verifiedHandle);

  const { error } = await supabaseClient.from("partners").insert({
    name,
    email,
    instagram_handle: verifiedHandle,
    discount_code: discountCode,
    attended: false,
  });

  submitBtn.disabled = false;
  submitBtn.textContent = "Sign up - it's free";

  if (error) {
    alert("Something went wrong signing you up - please try again.");
    return;
  }

  signupForm.hidden = true;
  document.getElementById("signupSuccess").hidden = false;
});

function generateDiscountCode(handle) {
  const clean = handle.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 10);
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return `${clean}${suffix}`;
  // Note: the code is stored now but should stay hidden in the UI
  // until `attended` is flipped to true - the dashboard (built later)
  // is where a partner would actually see it.
}
