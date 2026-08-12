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
// Instagram handle verification against Supabase
// Expects a table `invited_partners` with a column `instagram_handle`
// =================================================================
const verifyBar = document.getElementById("verifyBar");
const verifyBtn = document.getElementById("verifyBtn");
const handleInput = document.getElementById("handleInput");
const verifyError = document.getElementById("verifyError");
const signupForm = document.getElementById("signupForm");
const handleDisplay = document.getElementById("handleDisplay");

let verifiedHandle = null;

signupForm.classList.add("disabled");

verifyBtn.addEventListener("click", async () => {
  const handle = handleInput.value.trim().replace(/^@/, "").toLowerCase();
  if (!handle) return;

  verifyBtn.disabled = true;
  verifyBtn.textContent = "Checking...";
  verifyError.textContent = "";

  const { data, error } = await supabaseClient
    .from("invited_partners")
    .select("instagram_handle")
    .ilike("instagram_handle", handle)
    .maybeSingle();

  verifyBtn.disabled = false;
  verifyBtn.textContent = "Verify";

  if (error) {
    verifyError.textContent = "Something went wrong - try again in a moment.";
    return;
  }

  if (!data) {
    verifyError.textContent = "We couldn't find that handle on the invite list.";
    return;
  }

  verifiedHandle = handle;
  handleDisplay.textContent = handle;
  signupForm.classList.remove("disabled");
  verifyBar.classList.add("hidden");
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
