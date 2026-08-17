const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const Stripe = require("stripe");
const { Resend } = require("resend");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

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
const supabaseServiceRoleKey = defineSecret("SUPABASE_SERVICE_ROLE_KEY");

// Same project the frontend uses (see vip-partner/supabase-client.js) -
// VIP partner data lives here, accessed server-side with the service_role
// key so RLS can stay locked down to anon/authenticated.
const SUPABASE_URL = "https://aezdluescnzwqvdpmdvx.supabase.co";
function getSupabaseAdmin() {
  return createClient(SUPABASE_URL, supabaseServiceRoleKey.value());
}

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
      supabaseServiceRoleKey,
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
  const firstName = fullName.split(" ")[0].replace(/[^a-zA-Z]/g, "") || "Friend";
  const lastName = fullName.split(" ").slice(1).join(" ") || "Booking";

  // Pull course date through from checkout metadata
  const courseDate = session.metadata?.course_date || "your upcoming session";

      try {
        // --- STEP A: Generate Unique Referral Code ---
        const random4Digits = Math.floor(1000 + Math.random() * 9000);
        const referralCode = `${firstName.toUpperCase()}${random4Digits}`;

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
          paymentIntent: session.payment_intent,
          amountTotal: session.amount_total,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // --- STEP C.5: Process referral refund / VIP partner referral ---

try {
  const discountAmount = session.total_details?.amount_discount || 0;

  if (discountAmount > 0) {
    // Retrieve the full session with discount expansion to get the promo code
    const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ["discounts.promotion_code"],
    });

    const usedPromo = fullSession.discounts?.[0]?.promotion_code;
    const usedCode = typeof usedPromo === "object" ? usedPromo.code : null;

    if (usedCode) {
      const referrerQuery = await db
        .collection("bookings")
        .where("referralCode", "==", usedCode)
        .limit(1)
        .get();

      if (!referrerQuery.empty) {
        const referrerDoc = referrerQuery.docs[0];
        const referrerData = referrerDoc.data();

        if (referrerData.paymentIntent) {
          const refund = await stripe.refunds.create({
            payment_intent: referrerData.paymentIntent,
            amount: 1000,
            reason: "requested_by_customer",
          });
          console.log(`Referral refund issued: £10 to ${referrerData.email} (${refund.id}) for code ${usedCode}`);

          await referrerDoc.ref.update({
            referralRefunds: admin.firestore.FieldValue.arrayUnion({
              refundedFor: customerEmail,
              refundId: refund.id,
              amount: 1000,
              date: new Date().toISOString(),
            }),
          });
        } else {
          console.warn(`No paymentIntent on file for referrer with code ${usedCode} — skipped refund.`);
        }
      } else {
        // Not a regular customer's referral code - check whether it belongs
        // to a VIP partner instead, and log the usage in Supabase.
        const supabaseAdmin = getSupabaseAdmin();
        const { data: partner, error: partnerLookupError } = await supabaseAdmin
          .from("partners")
          .select("id, email, discount_code")
          .eq("discount_code", usedCode)
          .maybeSingle();

        if (partnerLookupError) {
          console.error("Error looking up VIP partner by discount code:", partnerLookupError);
        } else if (partner) {
          const { error: referralInsertError } = await supabaseAdmin.from("referrals").insert({
            partner_id: partner.id,
            discount_code: usedCode,
            customer_name: fullName,
            customer_email: customerEmail,
            stripe_session_id: session.id,
          });

          if (referralInsertError) {
            console.error("Error logging VIP partner referral:", referralInsertError);
          } else {
            console.log(`VIP partner referral logged for ${partner.email} (code ${usedCode})`);
          }
        } else {
          console.warn(`Promo code ${usedCode} used but no matching referrer booking or VIP partner found.`);
        }
      }
    } else {
      console.warn("Discount detected but couldn't resolve promotion code from expanded session.");
    }
  }
} catch (refundErr) {
  console.error("Error processing referral refund:", refundErr);
}

        // --- STEP D: Add Contact to Bigin CRM ---
        await createBiginContact(
  firstName,
  lastName,
  customerEmail,
  referralCode,
  courseDate,
  biginClientId.value(),
  biginClientSecret.value(),
  biginRefreshToken.value()
);

        // --- STEP E: Send Confirmation Email via Resend ---
        await resend.emails.send({
  from: "Leo | Real Life Money <leo@reallifemoney.co.uk>",
  to: customerEmail,
  subject: "Booking Confirmed! Here's your referral code 🎉",
  html: `
  <!DOCTYPE html>
  <html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.6; color: #2e2e2e; margin: 0; padding: 0; -webkit-text-size-adjust: 100%; }
      .wrapper { background-color: #eef8eb; padding: 20px 10px; }
      .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 24px; overflow: hidden; border: 1px solid #daecd6; width: 100%; }
      .header { padding: 30px 20px; text-align: center; background-color: #ffffff; }
      .content { padding: 0 25px 40px 25px; }
      h1 { color: #1a1a1a; font-size: 24px; margin-bottom: 10px; text-align: center; }
      .date-box { background: #eef8eb; border: 1px solid #8c52ff; border-radius: 24px; padding: 25px 15px; margin: 25px 0; text-align: center; }
      .code-box { background: #eef8eb; border: 2px dashed #71c558; border-radius: 24px; padding: 25px 15px; margin: 25px 0; text-align: center; }
      .code-value { font-size: 26px; font-weight: bold; letter-spacing: 3px; color: #1a1a1a; background: #ffffff; border-radius: 10px; padding: 12px 16px; margin: 10px 0; display: inline-block; }
      .footer { padding: 30px; text-align: center; font-size: 12px; color: #6b6b6b; background: #f9f9f9; }
      @media only screen and (max-width: 480px) {
        .content { padding: 0 15px 30px 15px; }
        h1 { font-size: 22px; }
        .wrapper { padding: 10px 5px; }
      }
    </style>
  </head>
  <body>
    <div class="wrapper">
      <div class="container">
        <div class="header">
          <img src="https://reallifemoney.co.uk/logo-circle.webp"
               alt="Real Life Money"
               style="width: 80px; height: 80px; background-color: #ffffff; border-radius: 50%; object-fit: cover;">
        </div>

        <div class="content">
          <h1>You're booked, ${firstName}! 🎉</h1>
          <p>Your payment's gone through and your spot is fully confirmed. I'm genuinely looking forward to helping you feel confident with investing.</p>

          <div class="date-box">
            <p style="margin: 0 0 10px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #6b6b6b; font-weight: bold;">Your Workshop</p>
            <p style="margin: 0; color: #8c52ff; font-weight: bold; font-size: 20px;">${courseDate}</p>
          </div>

          <p>You'll receive a payment invoice and receipt from Stripe separately for your records - no action needed there, it's just confirmation of your payment.</p>

          <div class="code-box">
            <p style="margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #6b6b6b; font-weight: bold;">Your Personal Referral Code</p>
            <div class="code-value">${referralCode}</div>
            <p style="margin: 10px 0 0 0; font-size: 14px; color: #2e2e2e;">
              Share this with friends or family - <strong>they get £10 off</strong> their workshop, and <strong>you get £10 back</strong> for every person who books with your code.
            </p>
          </div>

          <p style="margin-top: 30px; font-size: 15px;">I'll be in touch nearer the time with everything you need for the session. If you have any questions in the meantime, just hit reply or send me a WhatsApp at <strong>07939 887950</strong>.</p>

          <p>See you soon!<br><strong>Leo</strong></p>
        </div>

        <div class="footer">
          <p>© 2026 Real Life Money | Bristol, UK</p>
          <p style="font-size: 11px; color: #666; text-align: center;">
            This is an automated booking confirmation from Real Life Money.
          </p>
        </div>
      </div>
    </div>
  </body>
  </html>
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


exports.createCheckoutSession = onRequest(
  { secrets: [stripeSecretKey] },
  async (req, res) => {
    // Basic CORS handling
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      return res.status(204).send("");
    }
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    const stripe = new Stripe(stripeSecretKey.value());

    try {
      const { quantity, name, email, phone, courseDate } = req.body;

      // Clamp quantity to a sane range
      const qty = Math.max(1, Math.min(12, parseInt(quantity, 10) || 1));

      const session = await stripe.checkout.sessions.create({
        ui_mode: "embedded_page",
        mode: "payment",
        line_items: [
          {
            price: "price_1TQ2JGG1bVxXIBBZ82Esf1ur", // TODO: your live £75 workshop Price ID
            quantity: qty,
          },
        ],
        allow_promotion_codes: true,
        customer_email: email,
        metadata: {
          full_name: name,
          phone: phone,
          course_date: courseDate || "",
        },
        return_url: "https://reallifemoney.co.uk/booking-confirmed?session_id={CHECKOUT_SESSION_ID}",
      });

      res.json({ clientSecret: session.client_secret });
    } catch (err) {
      console.error("Error creating checkout session:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

exports.getBookingDetails = onRequest(
  {},
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      return res.status(204).send("");
    }

    const sessionId = req.query.session_id;
    if (!sessionId) {
      return res.status(400).json({ error: "Missing session_id" });
    }

    try {
      const doc = await db.collection("bookings").doc(sessionId).get();

      if (!doc.exists) {
        // Webhook likely hasn't processed yet — tell frontend to retry
        return res.status(202).json({ status: "pending" });
      }

      const data = doc.data();
      res.json({
        status: "complete",
        fullName: data.fullName,
        referralCode: data.referralCode,
        email: data.email,
      });
    } catch (err) {
      console.error("Error fetching booking details:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * HELPER: Create Contact in Bigin CRM via OAuth / REST API
 */
async function createBiginContact(firstName, lastName, email, referralCode, courseDate, clientId, clientSecret, refreshToken, vipPartner = false) {
  try {
    const accessToken = await getBiginAccessToken(clientId, clientSecret, refreshToken);
    if (!accessToken) return;

    const baseUrl = "https://www.zohoapis.eu/bigin/v1/Contacts";
    const headers = {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json",
    };

    async function safeJson(res) {
      const text = await res.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (e) {
        console.error("Bigin response was not valid JSON:", text);
        return null;
      }
    }

    const searchUrl = `${baseUrl}/search?email=${encodeURIComponent(email)}`;
    const searchRes = await fetch(searchUrl, { method: "GET", headers });
    const searchResult = await safeJson(searchRes);
    const existingContact = searchResult?.data?.[0];

    if (existingContact) {
      const existingDescription = existingContact.Description || "";
      const newNote = vipPartner
        ? `\nVIP Partner sign-up. Course date: ${courseDate} (${new Date().toISOString()})`
        : `\nRepeat booking. New Referral Code: ${referralCode} (${new Date().toISOString()})`;

      const updatePayload = {
        data: [
          {
            id: existingContact.id,
            Description: existingDescription + newNote,
            Course: courseDate,
            ...(vipPartner ? { VIP_Partner: "Yes" } : {}),
          },
        ],
      };

      const updateRes = await fetch(baseUrl, {
        method: "PUT",
        headers,
        body: JSON.stringify(updatePayload),
      });
      const updateResult = await safeJson(updateRes);
      console.log("Bigin API Contact Updated:", JSON.stringify(updateResult));
    } else {
      const createPayload = {
        data: [
          {
            First_Name: firstName,
            Last_Name: lastName,
            Email: email,
            Description: vipPartner
              ? `VIP Partner sign-up. Referral Code: ${referralCode}`
              : `Workshop attendee. Unique Referral Code: ${referralCode}`,
            Course: courseDate,
            ...(vipPartner ? { VIP_Partner: "Yes" } : {}),
          },
        ],
      };

      const createRes = await fetch(baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(createPayload),
      });
      const createResult = await safeJson(createRes);
      console.log("Bigin API Contact Created:", JSON.stringify(createResult));
    }
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

exports.getWorkshops = onRequest(
  {},
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");

    if (req.method === "OPTIONS") {
      return res.status(204).send("");
    }

    try {
      const snapshot = await db
        .collection("workshops")
        .where("active", "==", true)
        .orderBy("sortDate", "asc")
        .get();

      const workshops = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      res.json({ workshops });
    } catch (err) {
      console.error("Error fetching workshops:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * VIP PARTNER SIGN-UP
 * Saves the partner to the Supabase `partners` table (RLS-locked, written
 * here with the service_role key), creates a matching Stripe promo code
 * for their discount code, then syncs to Bigin CRM and sends a
 * confirmation email - same idea as the paid checkout flow, but there's
 * no payment involved since partners attend for free.
 */
exports.vipPartnerSignup = onRequest(
  {
    secrets: [
      resendApiKey,
      biginClientId,
      biginClientSecret,
      biginRefreshToken,
      supabaseServiceRoleKey,
      stripeSecretKey,
    ],
  },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      return res.status(204).send("");
    }
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    const resend = new Resend(resendApiKey.value());

    try {
      const { name, email, courseDate, discountCode, instagramHandle } = req.body;

      if (!email || !name) {
        return res.status(400).json({ error: "Missing name or email" });
      }

      const fullName = String(name).trim();
      const firstName = fullName.split(" ")[0].replace(/[^a-zA-Z]/g, "") || "Friend";
      const lastName = fullName.split(" ").slice(1).join(" ") || "Partner";
      const chosenDate = courseDate || "your chosen workshop";
      const emailKey = String(email).trim().toLowerCase();

      // --- Save the partner record in Supabase ---
      const supabaseAdmin = getSupabaseAdmin();
      const { error: upsertError } = await supabaseAdmin.from("partners").upsert(
        {
          name: fullName,
          email: emailKey,
          instagram_handle: instagramHandle || "",
          discount_code: discountCode || "",
          course_date: chosenDate,
          attended: false,
        },
        { onConflict: "email" }
      );

      if (upsertError) {
        console.error("Error saving VIP partner to Supabase:", upsertError);
        return res.status(500).json({ error: upsertError.message });
      }

      // --- Create a live Stripe promo code so followers can use it right
      // away - it stays hidden in the partner's dashboard until attended.
      if (discountCode) {
        try {
          const stripe = new Stripe(stripeSecretKey.value());
          const coupon = await stripe.coupons.create({
            amount_off: 1000, // £10 off in pence
            currency: "gbp",
            duration: "forever",
            name: `VIP Partner Coupon for ${firstName}`,
          });
          await stripe.promotionCodes.create({
            promotion: { type: "coupon", coupon: coupon.id },
            code: discountCode,
          });
        } catch (stripeErr) {
          console.error("Error creating Stripe promo code for VIP partner:", stripeErr);
        }
      }

      // --- Add/update Contact in Bigin CRM, flagged as a VIP Partner ---
      await createBiginContact(
        firstName,
        lastName,
        email,
        discountCode || "",
        chosenDate,
        biginClientId.value(),
        biginClientSecret.value(),
        biginRefreshToken.value(),
        true
      );

      // --- Send confirmation email, bcc'd to Leo ---
      await resend.emails.send({
        from: "Leo | Real Life Money <leo@reallifemoney.co.uk>",
        to: email,
        bcc: "leo@reallifemoney.co.uk",
        subject: "You're a VIP Partner! Here's what's next 🎉",
        html: `
  <!DOCTYPE html>
  <html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.6; color: #2e2e2e; margin: 0; padding: 0; -webkit-text-size-adjust: 100%; }
      .wrapper { background-color: #eef8eb; padding: 20px 10px; }
      .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 24px; overflow: hidden; border: 1px solid #daecd6; width: 100%; }
      .header { padding: 30px 20px; text-align: center; background-color: #ffffff; }
      .content { padding: 0 25px 40px 25px; }
      h1 { color: #1a1a1a; font-size: 24px; margin-bottom: 10px; text-align: center; }
      .date-box { background: #eef8eb; border: 1px solid #8c52ff; border-radius: 24px; padding: 25px 15px; margin: 25px 0; text-align: center; }
      .footer { padding: 30px; text-align: center; font-size: 12px; color: #6b6b6b; background: #f9f9f9; }
      @media only screen and (max-width: 480px) {
        .content { padding: 0 15px 30px 15px; }
        h1 { font-size: 22px; }
        .wrapper { padding: 10px 5px; }
      }
    </style>
  </head>
  <body>
    <div class="wrapper">
      <div class="container">
        <div class="header">
          <img src="https://reallifemoney.co.uk/logo-circle.webp"
               alt="Real Life Money"
               style="width: 80px; height: 80px; background-color: #ffffff; border-radius: 50%; object-fit: cover;">
        </div>

        <div class="content">
          <h1>Welcome to the programme, ${firstName}! 🎉</h1>
          <p>You're officially signed up as a VIP Partner - genuinely excited to have you on board. No payment needed for this bit, you're coming along as my guest.</p>

          <div class="date-box">
            <p style="margin: 0 0 10px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #6b6b6b; font-weight: bold;">Your Workshop</p>
            <p style="margin: 0; color: #8c52ff; font-weight: bold; font-size: 20px;">${chosenDate}</p>
          </div>

          <p>Your personal discount code unlocks once you've attended - I'll send that over separately so your followers can start getting £10 off.</p>

          <p style="margin-top: 30px; font-size: 15px;">I'll be in touch nearer the time with everything you need for the session. If you have any questions in the meantime, just hit reply or send me a WhatsApp at <strong>07939 887950</strong>.</p>

          <p>See you soon!<br><strong>Leo</strong></p>
        </div>

        <div class="footer">
          <p>© 2026 Real Life Money | Bristol, UK</p>
          <p style="font-size: 11px; color: #666; text-align: center;">
            This is an automated VIP Partner sign-up confirmation from Real Life Money.
          </p>
        </div>
      </div>
    </div>
  </body>
  </html>
  `,
      });

      console.log(`VIP Partner signup processed for ${email} (${instagramHandle || "no handle"})`);
      res.json({ success: true });
    } catch (err) {
      console.error("Error processing VIP partner signup:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * Returns the last day of the current calendar month as an ISO date
 * string (YYYY-MM-DD) - partners are paid monthly on this date.
 */
function getNextPayoutDate() {
  const now = new Date();
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return lastDay.toISOString().slice(0, 10);
}

/**
 * Tiered earnings for a given number of successful referrals:
 * £30 for 1-5, £20 for 6-10, £15 for 11+, +£50 bonus at 20, +£100 at 50.
 * Mirrors the calculator shown on the sign-up page (vip-partner.js).
 */
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

/**
 * VIP PARTNER - REQUEST LOGIN LINK
 * Passwordless login: partner submits their email, we generate a
 * short-lived token stored on their Supabase `partners` row and email
 * them a link straight into the dashboard.
 */
exports.vipPartnerRequestLogin = onRequest(
  { secrets: [resendApiKey, supabaseServiceRoleKey] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    try {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: "Missing email" });

      const emailKey = String(email).trim().toLowerCase();
      const supabaseAdmin = getSupabaseAdmin();
      const { data: partner, error } = await supabaseAdmin
        .from("partners")
        .select("email")
        .eq("email", emailKey)
        .maybeSingle();

      if (error) {
        console.error("Error looking up VIP partner for login:", error);
        return res.status(500).json({ error: error.message });
      }

      // Don't reveal whether the email exists - always respond success.
      if (!partner) {
        console.warn(`Login requested for unknown VIP partner email: ${emailKey}`);
        return res.json({ success: true });
      }

      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days

      const { error: updateError } = await supabaseAdmin
        .from("partners")
        .update({ login_token: token, login_token_expiry: expiresAt })
        .eq("email", emailKey);

      if (updateError) {
        console.error("Error saving VIP partner login token:", updateError);
        return res.status(500).json({ error: updateError.message });
      }

      const resend = new Resend(resendApiKey.value());
      const dashboardUrl = `https://reallifemoney.co.uk/vip-partner/dashboard.html?email=${encodeURIComponent(emailKey)}&token=${token}`;

      await resend.emails.send({
        from: "Leo | Real Life Money <leo@reallifemoney.co.uk>",
        to: emailKey,
        subject: "Your VIP Partner dashboard login link",
        html: `
  <!DOCTYPE html>
  <html>
  <head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
  <body style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height:1.6; color:#2e2e2e; background:#eef8eb; padding:20px;">
    <div style="max-width:520px; margin:0 auto; background:#ffffff; border-radius:24px; border:1px solid #daecd6; padding:30px;">
      <h1 style="font-size:22px; text-align:center;">Log in to your VIP Partner dashboard</h1>
      <p>Click the button below to view your referral code, earnings and payout details.</p>
      <p style="text-align:center; margin:30px 0;">
        <a href="${dashboardUrl}" style="background:#8c52ff; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:bold; display:inline-block;">View my dashboard</a>
      </p>
      <p style="font-size:13px; color:#6b6b6b;">This link is valid for 7 days. If you didn't request this, you can ignore this email.</p>
    </div>
  </body>
  </html>
  `,
      });

      res.json({ success: true });
    } catch (err) {
      console.error("Error requesting VIP partner login:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * HELPER: verify a dashboard token against a partner's Supabase row
 */
async function verifyPartnerToken(supabaseAdmin, email, token) {
  if (!email || !token) return { valid: false };
  const emailKey = String(email).trim().toLowerCase();

  const { data: partner, error } = await supabaseAdmin
    .from("partners")
    .select("*")
    .eq("email", emailKey)
    .maybeSingle();

  if (error || !partner) return { valid: false };
  if (partner.login_token !== token || !partner.login_token_expiry || Date.now() > partner.login_token_expiry) {
    return { valid: false };
  }
  return { valid: true, partner };
}

/**
 * VIP PARTNER - DASHBOARD DATA
 * Usage count / total earned are computed live from the `referrals`
 * table so the dashboard always reflects reality; next payout amount
 * subtracts whatever's already been recorded as paid in `payouts`.
 */
exports.vipPartnerDashboard = onRequest(
  { secrets: [supabaseServiceRoleKey] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");

    if (req.method === "OPTIONS") return res.status(204).send("");

    try {
      const { email, token } = req.query;
      const supabaseAdmin = getSupabaseAdmin();
      const { valid, partner } = await verifyPartnerToken(supabaseAdmin, email, token);

      if (!valid) {
        return res.status(401).json({ error: "Invalid or expired login link" });
      }

      const { data: referrals, error: referralsError } = await supabaseAdmin
        .from("referrals")
        .select("customer_name, created_at")
        .eq("partner_id", partner.id)
        .order("created_at", { ascending: false });

      if (referralsError) {
        console.error("Error fetching VIP partner referrals:", referralsError);
        return res.status(500).json({ error: referralsError.message });
      }

      const { data: payouts, error: payoutsError } = await supabaseAdmin
        .from("payouts")
        .select("amount")
        .eq("partner_id", partner.id)
        .eq("paid", true);

      if (payoutsError) {
        console.error("Error fetching VIP partner payouts:", payoutsError);
        return res.status(500).json({ error: payoutsError.message });
      }

      const usageCount = referrals.length;
      const totalEarned = calcEarnings(usageCount);
      const alreadyPaid = (payouts || []).reduce((sum, p) => sum + Number(p.amount || 0), 0);
      const nextPayoutAmount = Math.max(0, totalEarned - alreadyPaid);

      res.json({
        name: partner.name,
        email: partner.email,
        attended: Boolean(partner.attended),
        discountCode: partner.attended ? partner.discount_code || "" : "",
        usageCount,
        totalEarned,
        nextPayoutAmount,
        nextPayoutDate: getNextPayoutDate(),
        bankDetails:
          partner.bank_account_name || partner.bank_sort_code || partner.bank_account_number
            ? {
                accountName: partner.bank_account_name || "",
                sortCode: partner.bank_sort_code || "",
                accountNumber: partner.bank_account_number || "",
              }
            : null,
        referrals: referrals.map((r) => ({
          customerName: r.customer_name || "Anonymous",
          createdAt: r.created_at,
        })),
      });
    } catch (err) {
      console.error("Error fetching VIP partner dashboard:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * VIP PARTNER - UPDATE BANK DETAILS
 */
exports.vipPartnerUpdateBankDetails = onRequest(
  { secrets: [supabaseServiceRoleKey] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    try {
      const { email, token, accountName, sortCode, accountNumber } = req.body;
      const supabaseAdmin = getSupabaseAdmin();
      const { valid, partner } = await verifyPartnerToken(supabaseAdmin, email, token);

      if (!valid) {
        return res.status(401).json({ error: "Invalid or expired login link" });
      }
      if (!accountName || !sortCode || !accountNumber) {
        return res.status(400).json({ error: "Missing bank details" });
      }

      const { error: updateError } = await supabaseAdmin
        .from("partners")
        .update({
          bank_account_name: String(accountName).trim(),
          bank_sort_code: String(sortCode).trim(),
          bank_account_number: String(accountNumber).trim(),
        })
        .eq("id", partner.id);

      if (updateError) {
        console.error("Error updating VIP partner bank details:", updateError);
        return res.status(500).json({ error: updateError.message });
      }

      res.json({ success: true });
    } catch (err) {
      console.error("Error updating VIP partner bank details:", err);
      res.status(500).json({ error: err.message });
    }
  }
);