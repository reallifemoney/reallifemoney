const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const Stripe = require("stripe");
const { Resend } = require("resend");

// Initialize Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();

// Define secrets stored in Firebase
const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");
const resendApiKey = defineSecret("RESEND_API_KEY");
const biginClientId = defineSecret("BIGIN_CLIENT_ID");
const biginClientSecret = defineSecret("BIGIN_CLIENT_SECRET");
const biginRefreshToken = defineSecret("BIGIN_REFRESH_TOKEN");

/**
 * STRIPE WEBHOOK HANDLER
 */
exports.stripeWebhook = onRequest(
  {
    rawBody: true,
    secrets: [
      stripeSecretKey,
      stripeWebhookSecret,
      resendApiKey,
      biginClientId,
      biginClientSecret,
      biginRefreshToken,
    ],
  },
  async (req, res) => {
    // Initialize Stripe and Resend dynamically inside request handler using secrets
    const stripe = new Stripe(stripeSecretKey.value());
    const resend = new Resend(resendApiKey.value());

    const sig = req.headers["stripe-signature"];
    let event;

    try {
      // 1. Verify that the event came directly from Stripe
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        sig,
        stripeWebhookSecret.value()
      );
    } catch (err) {
      console.error(`Webhook Signature Error: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // 2. Process successful checkout payments
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const customerEmail = session.customer_details?.email;
      const fullName = session.customer_details?.name || "Customer";
      const firstName = fullName.split(" ")[0].replace(/[^a-zA-Z]/g, "").toUpperCase() || "FRIEND";
      const lastName = fullName.split(" ").slice(1).join(" ") || "Booking";

      try {
        // --- STEP A: Generate Unique Referral Code ---
        const random4Digits = Math.floor(1000 + Math.random() * 9000);
        const referralCode = `${firstName}${random4Digits}`;

        // --- STEP B: Create Coupon & Promo Code in Stripe ---
        const coupon = await stripe.coupons.create({
          amount_off: 1000, // £10 off in pence
          currency: "gbp",
          duration: "forever",
          name: `Referral Coupon for ${firstName}`,
        });

        await stripe.promotionCodes.create({
  promotion: {
    type: "coupon",
    coupon: coupon.id,
  },
  code: referralCode,
});

        // --- STEP C: Save Record to Firestore ---
        await db.collection("bookings").doc(session.id).set({
          sessionId: session.id,
          email: customerEmail,
          fullName: fullName,
          referralCode: referralCode,
          amountTotal: session.amount_total,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // --- STEP D: Add Contact to Bigin CRM ---
        await createBiginContact(
          firstName,
          lastName,
          customerEmail,
          referralCode,
          biginClientId.value(),
          biginClientSecret.value(),
          biginRefreshToken.value()
        );

        // --- STEP E: Send Confirmation Email via Resend ---
        await resend.emails.send({
          from: "Real Life Money <workshops@reallifemoney.co.uk>",
          to: customerEmail,
          subject: "Booking Confirmed! Here is your unique £10 referral code",
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
              <h2>Thanks for booking your workshop, ${firstName}!</h2>
              <p>Your spot is fully confirmed. We're excited to see you there.</p>
              
              <div style="background: #f4f4f5; border-left: 4px solid #10b981; padding: 16px; margin: 20px 0;">
                <h3 style="margin-top: 0;">Your Personal Referral Code:</h3>
                <p style="font-size: 24px; font-weight: bold; letter-spacing: 2px; color: #059669; margin: 5px 0;">
                  ${referralCode}
                </p>
                <p style="margin-bottom: 0; font-size: 14px;">
                  Share this code with friends or family! When they use it at checkout:
                </p>
                <ul style="font-size: 14px; padding-left: 20px;">
                  <li><strong>They get £10 off</strong> their workshop ticket.</li>
                  <li><strong>You get a £10 refund</strong> back to your card for every person who books!</li>
                </ul>
              </div>
              
              <p>If you have any questions before the session, simply reply to this email.</p>
            </div>
          `,
        });

        console.log(`Successfully processed booking & code ${referralCode} for ${customerEmail}`);
      } catch (error) {
        console.error("Error processing post-payment logic:", error);
      }
    }

    // Acknowledge receipt to Stripe
    res.json({ received: true });
  }
);

/**
 * HELPER: Create Contact in Bigin CRM via OAuth / REST API
 */
async function createBiginContact(firstName, lastName, email, referralCode, clientId, clientSecret, refreshToken) {
  try {
    const accessToken = await getBiginAccessToken(clientId, clientSecret, refreshToken);
    if (!accessToken) return;

    const url = "https://www.zohoapis.eu/bigin/v1/Contacts";

    const payload = {
      data: [
        {
          First_Name: firstName,
          Last_Name: lastName,
          Email: email,
          Description: `Workshop attendee. Unique Referral Code: ${referralCode}`,
        },
      ],
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    console.log("Bigin API Contact Result:", JSON.stringify(result));
  } catch (err) {
    console.error("Failed to push contact to Bigin:", err);
  }
}

/**
 * HELPER: Fetch fresh OAuth access token for Bigin
 */
async function getBiginAccessToken(clientId, clientSecret, refreshToken) {
  if (!clientId || !refreshToken) {
    console.warn("Bigin credentials missing. Skipping CRM sync.");
    return null;
  }

  try {
    const tokenUrl = `https://accounts.zoho.eu/oauth/v2/token?refresh_token=${refreshToken}&client_id=${clientId}&client_secret=${clientSecret}&grant_type=refresh_token`;
    const res = await fetch(tokenUrl, { method: "POST" });
    const data = await res.json();
    return data.access_token;
  } catch (err) {
    console.error("Error generating Bigin Access Token:", err);
    return null;
  }
}