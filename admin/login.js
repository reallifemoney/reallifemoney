const FUNCTIONS_BASE = "https://us-central1-workshop-booking-system-b791e.cloudfunctions.net";

const loginForm = document.getElementById("loginForm");
const loginSubmit = document.getElementById("loginSubmit");
const loginSuccess = document.getElementById("loginSuccess");
const loginError = document.getElementById("loginError");

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const email = document.getElementById("loginEmailInput").value.trim();
  if (!email) return;

  loginSubmit.disabled = true;
  loginSubmit.textContent = "Sending...";
  loginError.hidden = true;

  try {
    const response = await fetch(`${FUNCTIONS_BASE}/adminRequestLogin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    loginForm.hidden = true;
    loginSuccess.hidden = false;
  } catch (err) {
    console.error("Error requesting admin login link:", err);
    loginError.hidden = false;
    loginSubmit.disabled = false;
    loginSubmit.textContent = "Send me a login link";
  }
});
