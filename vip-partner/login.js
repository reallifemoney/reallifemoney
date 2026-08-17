const loginForm = document.getElementById("loginForm");
const loginSubmit = document.getElementById("loginSubmit");
const loginSuccess = document.getElementById("loginSuccess");

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const email = document.getElementById("loginEmailInput").value.trim();
  if (!email) return;

  loginSubmit.disabled = true;
  loginSubmit.textContent = "Sending...";

  try {
    await fetch("https://us-central1-workshop-booking-system-b791e.cloudfunctions.net/vipPartnerRequestLogin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
  } catch (err) {
    console.error("Error requesting VIP partner login link:", err);
  }

  loginForm.hidden = true;
  loginSuccess.hidden = false;
});
