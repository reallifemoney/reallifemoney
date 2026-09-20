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

// Sole admin dashboard user - no separate allow-list table needed.
const ADMIN_EMAIL = "leo@reallifemoney.co.uk";

// Same composite label used at checkout/sign-up (course.html,
// vip-partner.js, admin/dashboard.js workshopLabel()) - lets us match
// a booking's free-text courseDate back to a workshop doc's sortDate.
function workshopLabelFor(w) {
  const locationLabel = w.category === "online" ? (w.location || "") : `📍 ${w.venueName || ""}`;
  return `${w.dateLabel} (${w.times}) — ${locationLabel}`;
}

/**
 * HELPER: look up a workshop doc by its composite label (the same
 * string used as a booking's courseDate/workshop field).
 */
async function getWorkshopByLabel(label) {
  if (!label) return null;
  const snap = await db.collection("workshops").get();
  for (const doc of snap.docs) {
    if (workshopLabelFor(doc.data()) === label) return doc.data();
  }
  return null;
}

/**
 * HELPER: look up a workshop's sortDate (YYYY-MM-DD) from its
 * composite label, so VIP partner referrals can record the date the
 * referred customer is actually attending - used to hold off payouts
 * until that date has passed.
 */
async function getWorkshopSortDateForLabel(label) {
  const workshop = await getWorkshopByLabel(label);
  return workshop ? workshop.sortDate || null : null;
}

/**
 * HELPER: pull the session dates/times off a workshop doc, in the
 * shape Bigin CRM expects (same field names as Firestore).
 */
function workshopSessionFields(workshop) {
  if (!workshop) return {};
  return {
    "session_one": workshop["1session"] || "",
    "session_two": workshop["2session"] || "",
    "one_start_time": workshop["1start_time"] || "",
    "two_start_time": workshop["2start_time"] || "",
     "course_times": workshop["times"] || "",
  };
}

/**
 * HELPER: has a workshop date (YYYY-MM-DD) already passed? Referrals
 * with no recorded workshop_date are treated as payable (legacy rows
 * created before this field existed).
 */
function isWorkshopDatePassed(dateStr) {
  if (!dateStr) return true;
  const today = new Date().toISOString().slice(0, 10);
  return dateStr <= today;
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
  const fullName = session.metadata?.full_name || session.customer_details?.name || "Customer";
  const firstName = fullName.split(" ")[0].replace(/[^a-zA-Z]/g, "") || "Friend";
  const lastName = fullName.split(" ").slice(1).join(" ") || "Booking";

  // Pull course date through from checkout metadata
  const courseDate = session.metadata?.course_date || "your upcoming session";

      try {
        // --- STEP A: Generate Unique Referral Code ---
        const random4Digits = Math.floor(1000 + Math.random() * 9000);
        const referralCode = `${firstName.toUpperCase().slice(0, 4)}${random4Digits}`;

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
          courseDate: courseDate,
          workshop: courseDate,
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
          .select("id, name, email, discount_code")
          .eq("discount_code", usedCode)
          .maybeSingle();

        if (partnerLookupError) {
          console.error("Error looking up VIP partner by discount code:", partnerLookupError);
        } else if (partner) {
          const workshopDate = await getWorkshopSortDateForLabel(courseDate);
          const { error: referralInsertError } = await supabaseAdmin.from("referrals").insert({
            partner_id: partner.id,
            discount_code: usedCode,
            customer_name: fullName,
            customer_email: customerEmail,
            stripe_session_id: session.id,
            workshop_date: workshopDate,
          });

          if (referralInsertError) {
            console.error("Error logging VIP partner referral:", referralInsertError);
          } else {
            console.log(`VIP partner referral logged for ${partner.email} (code ${usedCode})`);
            try {
              const partnerFirstName = String(partner.name || "").trim().split(" ")[0] || "there";
              await resend.emails.send({
                from: "Leo | Real Life Money <leo@reallifemoney.co.uk>",
                to: partner.email,
                bcc: "leo@reallifemoney.co.uk",
                subject: "Someone just used your VIP code! 🎉",
                html: vipPartnerReferralUsedEmailHtml(partnerFirstName),
              });
            } catch (partnerEmailErr) {
              console.error("Error emailing VIP partner about referral use:", partnerEmailErr);
            }
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
        const workshopForBigin = await getWorkshopByLabel(courseDate);
        await createBiginContact(
  firstName,
  lastName,
  customerEmail,
  referralCode,
  courseDate,
  biginClientId.value(),
  biginClientSecret.value(),
  biginRefreshToken.value(),
  false,
  workshopSessionFields(workshopForBigin)
);

        // --- STEP E: Send Confirmation Email via Resend ---
        await resend.emails.send({
  from: "Leo | Real Life Money <leo@reallifemoney.co.uk>",
  to: customerEmail,
  bcc: "leo@reallifemoney.co.uk",
  subject: "Booking Confirmed! Here's your referral code 🎉",
  html: bookingConfirmationEmailHtml(firstName, courseDate, referralCode),
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
 * CASTLE SCHOOL P16 - FREE WORKSHOP SIGN-UP
 * Simple, no-payment sign-up for the Y12/Y13 Castle School workshop.
 * Saves the sign-up and syncs a contact to Bigin CRM (Course = "Castle
 * School", with the fixed workshop dates recorded in the usual
 * session_one/session_two fields).
 */
const CASTLE_P16_CAPACITY = 34;

exports.castleP16SignUp = onRequest(
  { secrets: [resendApiKey, biginClientId, biginClientSecret, biginRefreshToken] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    try {
      const { fullName, yearGroup, email, disclaimerAccepted } = req.body;

      const name = String(fullName || "").trim();
      const year = String(yearGroup || "").trim();
      const schoolEmail = String(email || "").trim().toLowerCase();

      if (!name || !year || !schoolEmail || !disclaimerAccepted) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const existingSnap = await db.collection("castleP16SignUps").get();
      if (existingSnap.size >= CASTLE_P16_CAPACITY) {
        return res.status(409).json({ error: "This workshop is fully booked", soldOut: true });
      }

      const firstName = name.split(" ")[0].replace(/[^a-zA-Z]/g, "") || "Student";
      const lastName = name.split(" ").slice(1).join(" ") || year;

      await db.collection("castleP16SignUps").add({
        fullName: name,
        yearGroup: year,
        email: schoolEmail,
        disclaimerAccepted: !!disclaimerAccepted,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await createBiginContact(
        firstName,
        lastName,
        schoolEmail,
        "",
        "Castle School",
        biginClientId.value(),
        biginClientSecret.value(),
        biginRefreshToken.value(),
        false,
        {
          session_one: "2026-10-08",
          session_two: "2026-10-15",
          one_start_time: "15:30",
          two_start_time: "15:30",
          course_times: "15:30 - 16:30",
        }
      );

      const resend = new Resend(resendApiKey.value());
      await resend.emails.send({
        from: "Leo | Real Life Money <leo@reallifemoney.co.uk>",
        to: schoolEmail,
        bcc: "leo@reallifemoney.co.uk",
        subject: "Castle School investing workshop",
        html: castleP16ConfirmationEmailHtml(firstName, year),
      });

      res.json({ success: true });
    } catch (err) {
      console.error("Error processing Castle School P16 sign-up:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * CASTLE SCHOOL P16 - SOLD OUT STATUS
 * Lets the sign-up page check capacity before rendering the form,
 * so it can show the sold-out / waitlist state straight away.
 */
exports.castleP16Status = onRequest({}, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).send("");

  try {
    const snap = await db.collection("castleP16SignUps").get();
    const count = snap.size;
    res.json({ count, capacity: CASTLE_P16_CAPACITY, soldOut: count >= CASTLE_P16_CAPACITY });
  } catch (err) {
    console.error("Error fetching Castle School P16 status:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * CASTLE SCHOOL P16 - WAITING LIST
 * Once the workshop is full, students can leave their name/email so
 * Leo has a record and can follow up about future sessions. Just
 * saves the entry and emails Leo directly - no CRM sync needed.
 */
exports.castleP16Waitlist = onRequest(
  { secrets: [resendApiKey] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    try {
      const { fullName, email } = req.body;
      const name = String(fullName || "").trim();
      const schoolEmail = String(email || "").trim().toLowerCase();

      if (!name || !schoolEmail) {
        return res.status(400).json({ error: "Missing name or email" });
      }

      await db.collection("castleP16Waitlist").add({
        fullName: name,
        email: schoolEmail,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const resend = new Resend(resendApiKey.value());
      await resend.emails.send({
        from: "Leo | Real Life Money <leo@reallifemoney.co.uk>",
        to: "leo@reallifemoney.co.uk",
        subject: "Castle School P16 waiting list sign-up",
        html: `<p><strong>${name}</strong> (${schoolEmail}) has joined the Castle School P16 waiting list for a future session.</p>`,
      });

      res.json({ success: true });
    } catch (err) {
      console.error("Error processing Castle School P16 waitlist sign-up:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

const POST16_GAME_QUESTIONS = [
  [
    { question: "What does investing usually mean?", options: ["Putting money into something with the aim of growing it", "Spending money on a treat", "Keeping cash in your wallet"], answer: 0 },
    { question: "Which statement about cash is usually true?", options: ["Its value can be reduced by inflation over time", "It always grows faster than investments", "It cannot be used to buy anything"], answer: 0 },
    { question: "Why might someone keep some money in cash?", options: ["For easy access and short-term spending", "Because cash has no value", "To guarantee a high investment return"], answer: 0 },
    { question: "What is inflation?", options: ["A general rise in prices over time", "A guaranteed investment profit", "A type of company share"], answer: 0 },
  ],
  [
    { question: "What is a bond?", options: ["A loan made by an investor to a government or company", "A share in a company", "A bank current account"], answer: 0 },
    { question: "What does a bond issuer generally promise?", options: ["To pay interest and repay the borrowed amount", "To double your money every year", "To give you company ownership"], answer: 0 },
    { question: "Which usually describes bond risk?", options: ["It can vary depending on the issuer's ability to repay", "It is always risk-free", "It is exactly the same as cash"], answer: 0 },
    { question: "What is a coupon in bond investing?", options: ["The interest payment made by a bond", "A discount on a share", "A stock market fee"], answer: 0 },
  ],
  [
    { question: "What is an equity investment?", options: ["A share of ownership in a company", "A loan to a government", "A cash savings account"], answer: 0 },
    { question: "What can happen to the price of a company share?", options: ["It can rise or fall", "It can only rise", "It never changes"], answer: 0 },
    { question: "Which is a commodity?", options: ["Gold", "A company share", "A bond coupon"], answer: 0 },
    { question: "Why might investors spread money across different assets?", options: ["To diversify and avoid relying on one investment", "To guarantee every investment wins", "To avoid learning what they own"], answer: 0 },
  ],
];

function post16GameId() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function post16GameView(data, playerId = "") {
  const section = Number(data.section || 0);
  const questionIndex = Number(data.questionIndex || 0);
  const currentQuestion = data.status === "question" && POST16_GAME_QUESTIONS[section]
    ? POST16_GAME_QUESTIONS[section][questionIndex]
    : null;
  return {
    gameId: data.gameId,
    status: data.status,
    section,
    questionIndex,
    currentQuestion: currentQuestion ? { question: currentQuestion.question, options: currentQuestion.options } : null,
    sectionNames: ["Investing and cash", "Bonds", "Equities and commodities"],
    spin: data.spin || { id: 0, result: null },
    players: Object.entries(data.players || {}).map(([id, player]) => ({
      id,
      name: player.name,
      total: player.total || 0,
      sessionWinnings: player.sessionWinnings || 0,
      choice: player.choice || null,
      answered: player.answered || false,
      isYou: id === playerId,
    })),
  };
}

/**
 * POST-16 INVESTING GAME
 * Admin actions are protected by the existing passwordless admin token.
 * Players use a short game code and receive only the current question/state.
 */
exports.post16Game = onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).send("");

  try {
    const body = req.body || {};
    const action = String(req.query.action || body.action || "");
    const gameId = String(req.query.gameId || body.gameId || "").trim().toUpperCase();

    if (action === "create") {
      if (!(await verifyAdminToken(body.token))) return res.status(401).json({ error: "Invalid or expired admin login link" });
      let id = post16GameId();
      while ((await db.collection("post16Games").doc(id).get()).exists) id = post16GameId();
      await db.collection("post16Games").doc(id).set({
        gameId: id, status: "lobby", section: 0, questionIndex: 0,
        players: {}, spin: { id: 0, result: null }, createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.json({ gameId: id });
    }

    if (!gameId) return res.status(400).json({ error: "Missing game code" });
    const gameRef = db.collection("post16Games").doc(gameId);

    if (action === "state") {
      const snapshot = await gameRef.get();
      if (!snapshot.exists) return res.status(404).json({ error: "Game not found" });
      return res.json(post16GameView(snapshot.data(), String(body.playerId || req.query.playerId || "")));
    }

    if (action === "join") {
      const name = String(body.name || "").trim().slice(0, 40);
      if (!name) return res.status(400).json({ error: "Enter your name" });
      const playerId = crypto.randomBytes(8).toString("hex");
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(gameRef);
        if (!snapshot.exists || snapshot.data().status !== "lobby") throw new Error("This game is not accepting players");
        const data = snapshot.data();
        transaction.update(gameRef, { [`players.${playerId}`]: { name, total: 0, sessionWinnings: 0, choice: null, answered: false } });
      });
      return res.json({ playerId });
    }

    if (action === "answer") {
      const playerId = String(body.playerId || "");
      const answer = Number(body.answer);
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(gameRef);
        if (!snapshot.exists) throw new Error("Game not found");
        const data = snapshot.data();
        const question = POST16_GAME_QUESTIONS[data.section]?.[data.questionIndex];
        const player = data.players?.[playerId];
        if (data.status !== "question" || !question || !player || player.answered) throw new Error("Answer unavailable");
        const correct = answer === question.answer;
        const update = { [`players.${playerId}.answered`]: true };
        if (correct) {
          update[`players.${playerId}.total`] = (player.total || 0) + 100;
          update[`players.${playerId}.sessionWinnings`] = (player.sessionWinnings || 0) + 100;
        }
        transaction.update(gameRef, update);
      });
      return res.json({ success: true });
    }

    if (action === "admin") {
      if (!(await verifyAdminToken(body.token))) return res.status(401).json({ error: "Invalid or expired admin login link" });
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(gameRef);
        if (!snapshot.exists) throw new Error("Game not found");
        const data = snapshot.data();
        const command = String(body.command || "");
        const update = {};
        if (command === "start") {
          update.status = "question";
          update.section = 0;
          update.questionIndex = 0;
        } else if (command === "nextQuestion") {
          const next = Number(data.questionIndex || 0) + 1;
          if (next < 4) {
            update.questionIndex = next;
            for (const id of Object.keys(data.players || {})) {
              update[`players.${id}.answered`] = false;
            }
          } else {
            update.status = "decision";
          }
        } else if (command === "spin") {
          if (data.status !== "decision") throw new Error("The spinner is only available after four questions");
          if (data.spin?.result) throw new Error("The spinner has already been used for this session");
          const result = crypto.randomInt(0, 2) === 0 ? "red" : "green";
          update.spin = { id: (data.spin?.id || 0) + 1, result };
          for (const [id, player] of Object.entries(data.players || {})) {
            if (player.choice === "gamble") {
              update[`players.${id}.total`] = result === "green" ? (player.total || 0) + (player.sessionWinnings || 0) : (player.total || 0) - (player.sessionWinnings || 0);
            }
          }
        } else if (command === "continue") {
          const nextSection = Number(data.section || 0) + 1;
          if (nextSection >= POST16_GAME_QUESTIONS.length) {
            update.status = "finished";
          } else {
            update.status = "question";
            update.section = nextSection;
            update.questionIndex = 0;
            for (const id of Object.keys(data.players || {})) {
              update[`players.${id}.sessionWinnings`] = 0;
              update[`players.${id}.choice`] = null;
              update[`players.${id}.answered`] = false;
            }
          }
        } else if (command === "reset") {
          update.status = "lobby";
          update.section = 0;
          update.questionIndex = 0;
          update.players = {};
          update.spin = { id: (data.spin?.id || 0) + 1, result: null };
        } else {
          throw new Error("Unknown admin command");
        }
        transaction.update(gameRef, update);
      });
      return res.json({ success: true });
    }

    if (action === "choice") {
      const playerId = String(body.playerId || "");
      if (!["bank", "gamble"].includes(body.choice)) return res.status(400).json({ error: "Choose bank or gamble" });
      await gameRef.update({ [`players.${playerId}.choice`]: body.choice });
      return res.json({ success: true });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error("Post-16 game error:", err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * HELPER: HTML for the workshop booking confirmation email (shared by
 * the Stripe webhook and the admin manual-booking endpoint).
 */
function bookingConfirmationEmailHtml(firstName, courseDate, referralCode) {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.6; color: #2e2e2e; margin: 0; padding: 0; -webkit-text-size-adjust: 100%;">
    <div style="background-color: #eef8eb; padding: 20px 10px;">
      <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 24px; overflow: hidden; border: 1px solid #daecd6; width: 100%;">
        <div style="padding: 30px 20px; text-align: center; background-color: #ffffff;">
          <img src="https://reallifemoney.co.uk/logo-circle.webp"
               alt="Real Life Money"
               style="width: 80px; height: 80px; background-color: #ffffff; border-radius: 50%; object-fit: cover;">
        </div>

        <div style="padding: 0 25px 40px 25px;">
          <h1 style="color: #1a1a1a; font-size: 24px; margin-bottom: 10px; text-align: center;">You're booked, ${firstName}! 🎉</h1>
          <p style="margin: 0 0 16px 0;">Your payment's gone through and your spot is fully confirmed. I'm genuinely looking forward to helping you feel confident with investing.</p>

          <div style="background: #eef8eb; border: 1px solid #8c52ff; border-radius: 24px; padding: 25px 15px; margin: 25px 0; text-align: center;">
            <p style="margin: 0 0 10px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #6b6b6b; font-weight: bold;">Your Workshop</p>
            <p style="margin: 0; color: #8c52ff; font-weight: bold; font-size: 20px;">${courseDate}</p>
          </div>

          <p style="margin: 0 0 16px 0;">You'll receive a payment invoice and receipt from Stripe separately for your records - no action needed there, it's just confirmation of your payment.</p>

          <div style="background: #eef8eb; border: 2px dashed #71c558; border-radius: 24px; padding: 25px 15px; margin: 25px 0; text-align: center;">
            <p style="margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #6b6b6b; font-weight: bold;">Your Personal Referral Code</p>
            <div style="font-size: 26px; font-weight: bold; letter-spacing: 3px; color: #1a1a1a; background: #ffffff; border-radius: 10px; padding: 12px 16px; margin: 10px 0; display: inline-block;">${referralCode}</div>
            <p style="margin: 10px 0 0 0; font-size: 14px; color: #2e2e2e;">
              Share this with friends or family - <strong>they get £10 off</strong> their workshop, and <strong>you get £10 back</strong> for every person who books with your code.
            </p>
          </div>

          <p style="margin-top: 30px; font-size: 15px;">I'll be in touch nearer the time with everything you need for the session. If you have any questions in the meantime, just hit reply or send me a WhatsApp at <strong>07939 887950</strong>.</p>

          <p style="margin: 0;">See you soon!<br><strong>Leo</strong></p>
        </div>

        <div style="padding: 30px; text-align: center; font-size: 12px; color: #6b6b6b; background: #f9f9f9;">
          <p style="margin: 0 0 6px 0;">© 2026 Real Life Money | Bristol, UK</p>
          <p style="font-size: 11px; color: #666; text-align: center; margin: 0;">
            This is an automated booking confirmation from Real Life Money.
          </p>
        </div>
      </div>
    </div>
  </body>
  </html>
  `;
}

/**
 * HELPER: Confirmation email for the free Castle School P16 workshop.
 */
function castleP16ConfirmationEmailHtml(firstName, yearGroup) {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.6; color: #2e2e2e; margin: 0; padding: 0; -webkit-text-size-adjust: 100%;">
    <div style="background-color: #eef8eb; padding: 20px 10px;">
      <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 24px; overflow: hidden; border: 1px solid #daecd6; width: 100%;">
        <div style="padding: 30px 20px; text-align: center; background-color: #ffffff;">
          <img src="https://reallifemoney.co.uk/logo-circle.webp" alt="Real Life Money" style="width: 80px; height: 80px; background-color: #ffffff; border-radius: 50%; object-fit: cover;">
        </div>
        <div style="padding: 0 25px 40px 25px;">
          <h1 style="color: #1a1a1a; font-size: 24px; margin-bottom: 10px; text-align: center;">Your place is confirmed, ${firstName}!</h1>
          <p style="margin: 0 0 16px 0;">Thanks so much for signing up. I'm looking forward to helping you learn to invest.</p>
          <div style="background: #eef8eb; border: 1px solid #8c52ff; border-radius: 16px; padding: 20px; margin: 25px 0;">
            <p style="margin: 8px 0;"><strong>School:</strong> Castle School</p>
            <p style="margin: 8px 0;"><strong>Year group:</strong> ${yearGroup}</p>
            <p style="margin: 8px 0;"><strong>Dates:</strong> Thursday 8th and Thursday 15th October 2026</p>
            <p style="margin: 8px 0;"><strong>Time:</strong> 15:30 - 16:30</p>
            <p style="margin: 8px 0;"><strong>Room:</strong> M9</p>
            <p style="margin: 8px 0;"><strong>Session leader:</strong> Mr Dennis</p>
            <p style="margin: 8px 0;"><strong>Cost:</strong> Free</p>
          </div>
          <p style="margin: 0 0 16px 0;">These are two sessions, so please keep both dates free. The workshop is educational and is not financial advice, as covered by the disclaimer you accepted when signing up.</p>
          <p style="margin: 0 0 16px 0;">If you have any questions or can no longer attend, please reply to this email or speak to me at school.</p>
          <p style="margin: 0;">See you soon!<br><br><strong>Mr Dennis</strong></p>
        </div>
        <div style="padding: 30px; text-align: center; font-size: 12px; color: #6b6b6b; background: #f9f9f9;">
          <p style="margin: 0 0 6px 0;">© 2026 Real Life Money | Bristol, UK</p>
          <p style="margin: 0;">This is an automated workshop confirmation from Real Life Money.</p>
        </div>
      </div>
    </div>
  </body>
  </html>
  `;
}

/**
 * HELPER: HTML for the "your VIP code is now live" email, sent when
 * an admin marks a partner as attended.
 */
function vipPartnerAttendedEmailHtml(firstName, discountCode) {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.6; color: #2e2e2e; margin: 0; padding: 0; -webkit-text-size-adjust: 100%;">
    <div style="background-color: #eef8eb; padding: 20px 10px;">
      <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 24px; overflow: hidden; border: 1px solid #daecd6; width: 100%;">
        <div style="padding: 30px 20px; text-align: center; background-color: #ffffff;">
          <img src="https://reallifemoney.co.uk/logo-circle.webp"
               alt="Real Life Money"
               style="width: 80px; height: 80px; background-color: #ffffff; border-radius: 50%; object-fit: cover;">
        </div>

        <div style="padding: 0 25px 40px 25px;">
          <h1 style="color: #1a1a1a; font-size: 24px; margin-bottom: 10px; text-align: center;">You're live, ${firstName}! 🎉</h1>
          <p style="margin: 0 0 16px 0;">Thanks so much for coming along to the workshop - it was great having you there.</p>
          <p style="margin: 0 0 16px 0;">Your VIP Partner discount code is now active, so you can start sharing it with friends, family and followers straight away.</p>

          <div style="background: #eef8eb; border: 2px dashed #71c558; border-radius: 24px; padding: 25px 15px; margin: 25px 0; text-align: center;">
            <p style="margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #6b6b6b; font-weight: bold;">Your Live Discount Code</p>
            <div style="font-size: 26px; font-weight: bold; letter-spacing: 3px; color: #1a1a1a; background: #ffffff; border-radius: 10px; padding: 12px 16px; margin: 10px 0; display: inline-block;">${discountCode}</div>
            <p style="margin: 10px 0 0 0; font-size: 14px; color: #2e2e2e;">Anyone who uses it gets <strong>£10 off</strong> their workshop booking.</p>
          </div>

          <div style="background: #eef8eb; border: 1px solid #8c52ff; border-radius: 24px; padding: 20px; margin: 25px 0;">
            <p style="margin: 0 0 16px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #6b6b6b; font-weight: bold;">What you earn</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding: 6px 0; font-size: 14px;">First 5 code uses:</td><td style="padding: 6px 0; font-size: 14px; text-align: right; color: #8c52ff;"><strong>£30 each</strong></td></tr><tr><td style="padding: 6px 0; font-size: 14px;">Next 5 code uses (6-10):</td><td style="padding: 6px 0; font-size: 14px; text-align: right; color: #8c52ff;"><strong>£20 each</strong></td></tr><tr><td style="padding: 6px 0; font-size: 14px;">Every code use after that:</td><td style="padding: 6px 0; font-size: 14px; text-align: right; color: #8c52ff;"><strong>£15 each</strong></td></tr><tr><td style="padding: 6px 0; font-size: 14px;">20th / 50th uses:</td><td style="padding: 6px 0; font-size: 14px; text-align: right; color: #8c52ff;"><strong>£50 / £100 bonus</strong></td></tr></table>
          </div>

          <div style="background: #eef8eb; border: 1px solid #71c558; border-radius: 24px; padding: 20px; margin: 25px 0; text-align: center;">
            <p style="margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #6b6b6b; font-weight: bold;">Track your code uses &amp; earnings</p>
            <p style="margin: 0; font-size: 14px;">Log in any time to see your dashboard.</p>
            <a href="https://reallifemoney.co.uk/vip-partner/login.html" style="display: inline-block; margin-top: 8px; background: #8c52ff; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 12px; font-weight: bold;">Log in to my dashboard</a>
          </div>

          <div style="background: #f4f0ff; border-radius: 16px; padding: 18px; margin: 25px 0; text-align: center;">
            <p style="margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #6b6b6b; font-weight: bold;">Send your followers here to book</p>
            <a href="https://reallifemoney.co.uk/investing-course" style="color: #8c52ff; font-weight: bold; word-break: break-all;">reallifemoney.co.uk/investing-course</a>
          </div>

          <div style="background: #fff8e6; border: 1px solid #f0d878; border-radius: 16px; padding: 16px 18px; margin: 25px 0; font-size: 14px;">
            📢 <strong>One important thing:</strong> any content you post about Real Life Money (stories, posts, reels) needs to include <strong>ad</strong> in the caption - it's a legal requirement for paid partnerships, so please don't forget it.
          </div>

          <p style="margin-top: 30px; font-size: 15px;">You can track code uses and earnings any time from your partner dashboard. If you've got any questions, just hit reply or send me a WhatsApp at <strong>07939 887950</strong>.</p>

          <p style="margin: 0;">Thanks again - excited to see what you do with it!<br><br><strong>Leo</strong></p>
        </div>

        <div style="padding: 30px; text-align: center; font-size: 12px; color: #6b6b6b; background: #f9f9f9;">
          <p style="margin: 0 0 6px 0;">© 2026 Real Life Money | Bristol, UK</p>
          <p style="font-size: 11px; color: #666; text-align: center; margin: 0;">
            This is an automated VIP Partner update from Real Life Money.
          </p>
        </div>
      </div>
    </div>
  </body>
  </html>
  `;
}

/**
 * HELPER: Create Contact in Bigin CRM via OAuth / REST API
 */
async function createBiginContact(firstName, lastName, email, referralCode, courseDate, clientId, clientSecret, refreshToken, vipPartner = false, workshopFields = {}) {
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
            ...workshopFields,
            ...(vipPartner
              ? { vip_partner: "Yes", vip_code: referralCode }
              : { referral_code: referralCode }),
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
            ...workshopFields,
            ...(vipPartner
              ? { vip_partner: "Yes", vip_code: referralCode }
              : { referral_code: referralCode }),
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
      const { name, email, courseDate, instagramHandle } = req.body;

      if (!email || !name) {
        return res.status(400).json({ error: "Missing name or email" });
      }

      const fullName = String(name).trim();
      const firstName = fullName.split(" ")[0].replace(/[^a-zA-Z]/g, "") || "Friend";
      const lastName = fullName.split(" ").slice(1).join(" ") || "Partner";
      const discountCode = `${firstName.replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 4).padEnd(4, "X")}${Math.floor(1000 + Math.random() * 9000)}`;
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

      // --- Record their own free seat as a booking, so the workshop's
      // participant list / capacity in the admin dashboard includes them ---
      const vipBookingRef = db.collection("bookings").doc(`vip_${Date.now()}`);
      await vipBookingRef.set({
        sessionId: vipBookingRef.id,
        email: emailKey,
        fullName: fullName,
        courseDate: chosenDate,
        workshop: chosenDate,
        referralCode: "",
        paymentIntent: null,
        amountTotal: 0,
        vipPartner: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

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
      const vipWorkshop = await getWorkshopByLabel(chosenDate);
      await createBiginContact(
        firstName,
        lastName,
        email,
        discountCode || "",
        chosenDate,
        biginClientId.value(),
        biginClientSecret.value(),
        biginRefreshToken.value(),
        true,
        workshopSessionFields(vipWorkshop)
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
  </head>
  <body style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.6; color: #2e2e2e; margin: 0; padding: 0; -webkit-text-size-adjust: 100%;">
    <div style="background-color: #eef8eb; padding: 20px 10px;">
      <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 24px; overflow: hidden; border: 1px solid #daecd6; width: 100%;">
        <div style="padding: 30px 20px; text-align: center; background-color: #ffffff;">
          <img src="https://reallifemoney.co.uk/logo-circle.webp"
               alt="Real Life Money"
               style="width: 80px; height: 80px; background-color: #ffffff; border-radius: 50%; object-fit: cover;">
        </div>

        <div style="padding: 0 25px 40px 25px;">
          <h1 style="color: #1a1a1a; font-size: 24px; margin-bottom: 10px; text-align: center;">Welcome to the programme, ${firstName}! 🎉</h1>
          <p style="margin: 0 0 16px 0;">You're officially signed up as a VIP Partner - genuinely excited to have you on board. No payment needed for the workshop, you're coming along as my guest.</p>

          <div style="background: #eef8eb; border: 1px solid #8c52ff; border-radius: 24px; padding: 25px 15px; margin: 25px 0; text-align: center;">
            <p style="margin: 0 0 10px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #6b6b6b; font-weight: bold;">Your Workshop</p>
            <p style="margin: 0; color: #8c52ff; font-weight: bold; font-size: 20px;">${chosenDate}</p>
          </div>

          <p style="margin: 0 0 16px 0;">Your personal discount code unlocks once you've attended - I'll send that over separately so your followers can start getting £10 off.</p>

          <div style="background: #eef8eb; border: 1px solid #8c52ff; border-radius: 24px; padding: 25px 15px; margin: 25px 0; text-align: center;">
            <p style="margin: 0 0 10px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #6b6b6b; font-weight: bold;">Your Partner Dashboard</p>
            <p style="margin: 0 0 16px 0; font-size: 14px;">Track your referral code, sign-ups and earnings any time.</p>
            <a href="https://reallifemoney.co.uk/vip-partner/login.html" style="background:#8c52ff; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:bold; display:inline-block;">Log in to my dashboard</a>
          </div>

          <p style="margin-top: 30px; font-size: 15px;">I'll be in touch nearer the time with everything you need for the session. If you have any questions in the meantime, just hit reply or send me a WhatsApp at <strong>07939 887950</strong>.</p>

          <p style="margin: 0;">See you soon!<br><strong>Leo</strong></p>
        </div>

        <div style="padding: 30px; text-align: center; font-size: 12px; color: #6b6b6b; background: #f9f9f9;">
          <p style="margin: 0 0 6px 0;">© 2026 Real Life Money | Bristol, UK</p>
          <p style="font-size: 11px; color: #666; text-align: center; margin: 0;">
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
 * Returns the last day of NEXT calendar month as an ISO date string
 * (YYYY-MM-DD) - payouts are only run for referrals whose workshop
 * has already passed, so this gives a buffer month to process them.
 */
function getNextPayoutDate() {
  const now = new Date();
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 0));
  return lastDay.toISOString().slice(0, 10);
}

/**
 * HTML for the "someone used your code" email sent to a VIP partner
 * every time a referral is logged - links straight to their dashboard
 * for the full up-to-date picture rather than including numbers here.
 */
function vipPartnerReferralUsedEmailHtml(firstName) {
  return `
  <!DOCTYPE html>
  <html>
  <head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
  <body style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height:1.6; color:#2e2e2e; background:#eef8eb; padding:20px;">
    <div style="max-width:520px; margin:0 auto; background:#ffffff; border-radius:24px; border:1px solid #daecd6; padding:30px;">
      <h1 style="font-size:22px; text-align:center;">Someone just used your code, ${firstName}! 🎉</h1>
      <p>One of your followers has booked a workshop with your discount code - nice work!</p>
      <p style="text-align:center; margin:30px 0;">
        <a href="https://reallifemoney.co.uk/vip-partner/login.html" style="background:#8c52ff; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:bold; display:inline-block;">View my dashboard</a>
      </p>
      <p style="font-size:13px; color:#6b6b6b;">Log in any time to see your full code use history, earnings and next payout.</p>
    </div>
  </body>
  </html>
  `;
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
        .select("created_at, workshop_date")
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

      // Total earned reflects immediately across all referrals; the next
      // payout only counts referrals whose workshop date has passed (so
      // the person's actually attended) minus what's already been paid.
      const usageCount = referrals.length;
      const totalEarned = calcEarnings(usageCount);
      const payableCount = referrals.filter((r) => isWorkshopDatePassed(r.workshop_date)).length;
      const payableEarned = calcEarnings(payableCount);
      const alreadyPaid = (payouts || []).reduce((sum, p) => sum + Number(p.amount || 0), 0);
      const nextPayoutAmount = Math.max(0, payableEarned - alreadyPaid);

      res.json({
        name: partner.name,
        email: partner.email,
        attended: Boolean(partner.attended),
        discountCode: partner.attended ? partner.discount_code || "" : "",
        usageCount,
        totalEarned,
        nextPayoutAmount,
        nextPayoutDate: nextPayoutAmount > 0 ? getNextPayoutDate() : null,
        bankDetails:
          partner.bank_account_name || partner.bank_sort_code || partner.bank_account_number
            ? {
                accountName: partner.bank_account_name || "",
                sortCode: partner.bank_sort_code || "",
                accountNumber: partner.bank_account_number || "",
              }
            : null,
        referrals: referrals.map((r) => ({
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

/**
 * ADMIN DASHBOARD
 * Single admin (leo@reallifemoney.co.uk) - passwordless login same as
 * VIP partners, but the token lives in Firestore (`adminSessions`)
 * instead of a partners row, since there's no admin allow-list table.
 */
exports.adminRequestLogin = onRequest(
  { secrets: [resendApiKey] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    try {
      const { email } = req.body;
      const emailKey = String(email || "").trim().toLowerCase();

      // Don't reveal whether the email matches - always respond success.
      if (emailKey !== ADMIN_EMAIL) {
        console.warn(`Admin login requested for non-admin email: ${emailKey}`);
        return res.json({ success: true });
      }

      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days

      await db.collection("adminSessions").doc(token).set({
        email: ADMIN_EMAIL,
        expiresAt,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const resend = new Resend(resendApiKey.value());
      const dashboardUrl = `https://reallifemoney.co.uk/admin/dashboard.html?token=${token}`;

      await resend.emails.send({
        from: "Leo | Real Life Money <leo@reallifemoney.co.uk>",
        to: ADMIN_EMAIL,
        subject: "Your admin dashboard login link",
        html: `
  <!DOCTYPE html>
  <html>
  <head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
  <body style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height:1.6; color:#2e2e2e; background:#eef8eb; padding:20px;">
    <div style="max-width:520px; margin:0 auto; background:#ffffff; border-radius:24px; border:1px solid #daecd6; padding:30px;">
      <h1 style="font-size:22px; text-align:center;">Log in to the admin dashboard</h1>
      <p style="text-align:center; margin:30px 0;">
        <a href="${dashboardUrl}" style="background:#8c52ff; color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:12px; font-weight:bold; display:inline-block;">Open dashboard</a>
      </p>
      <p style="font-size:13px; color:#6b6b6b;">This link is valid for 7 days.</p>
    </div>
  </body>
  </html>
  `,
      });

      res.json({ success: true });
    } catch (err) {
      console.error("Error requesting admin login:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * HELPER: verify an admin dashboard token against Firestore
 */
async function verifyAdminToken(token) {
  if (!token) return false;
  const doc = await db.collection("adminSessions").doc(String(token)).get();
  if (!doc.exists) return false;
  const data = doc.data();
  if (!data.expiresAt || Date.now() > data.expiresAt) return false;
  return true;
}

/**
 * ADMIN - DASHBOARD DATA
 * Returns everything the dashboard needs in one call: summary totals,
 * recent bookings, all workshops, and all VIP partners with their
 * live usage/earnings (mirrors the partner dashboard's calcEarnings()).
 */
exports.adminDashboard = onRequest(
  { secrets: [supabaseServiceRoleKey] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");

    if (req.method === "OPTIONS") return res.status(204).send("");

    try {
      const { token } = req.query;
      if (!(await verifyAdminToken(token))) {
        return res.status(401).json({ error: "Invalid or expired login link" });
      }

      // --- Bookings (Firestore) ---
      const bookingsSnap = await db
        .collection("bookings")
        .orderBy("createdAt", "desc")
        .limit(1000)
        .get();

      const bookings = bookingsSnap.docs.map((doc) => {
        const b = doc.data();
        return {
          id: doc.id,
          fullName: b.fullName || "",
          email: b.email || "",
          referralCode: b.referralCode || "",
          courseDate: b.courseDate || "",
          workshop: b.workshop || b.courseDate || "",
          amountTotal: b.amountTotal || 0,
          createdAt: b.createdAt ? b.createdAt.toDate().toISOString() : null,
        };
      });

      const totalBookings = bookings.length;
      const totalRevenue = bookings.reduce((sum, b) => sum + (b.amountTotal || 0), 0) / 100;

      // --- Workshops (Firestore) ---
      const workshopsSnap = await db.collection("workshops").orderBy("sortDate", "asc").get();
      const workshops = workshopsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

      // --- Castle School P16 sign-ups (Firestore) ---
      const castleP16Snap = await db.collection("castleP16SignUps").orderBy("createdAt", "desc").get();
      const castleP16SignUps = castleP16Snap.docs.map((doc) => {
        const c = doc.data();
        return {
          id: doc.id,
          fullName: c.fullName || "",
          yearGroup: c.yearGroup || "",
          email: c.email || "",
          createdAt: c.createdAt ? c.createdAt.toDate().toISOString() : null,
        };
      });

      // --- VIP partners (Supabase) ---
      const supabaseAdmin = getSupabaseAdmin();
      const { data: partners, error: partnersError } = await supabaseAdmin
        .from("partners")
        .select("*")
        .order("created_at", { ascending: false });

      if (partnersError) {
        console.error("Error fetching partners for admin dashboard:", partnersError);
        return res.status(500).json({ error: partnersError.message });
      }

      const { data: referrals, error: referralsError } = await supabaseAdmin
        .from("referrals")
        .select("partner_id, workshop_date");

      if (referralsError) {
        console.error("Error fetching referrals for admin dashboard:", referralsError);
        return res.status(500).json({ error: referralsError.message });
      }

      const { data: payouts, error: payoutsError } = await supabaseAdmin
        .from("payouts")
        .select("partner_id, amount")
        .eq("paid", true);

      if (payoutsError) {
        console.error("Error fetching payouts for admin dashboard:", payoutsError);
        return res.status(500).json({ error: payoutsError.message });
      }

      const { data: invitedPartnersRaw, error: invitedError } = await supabaseAdmin
        .from("invited_partners")
        .select("*");

      if (invitedError) {
        console.error("Error fetching invited partners for admin dashboard:", invitedError);
        return res.status(500).json({ error: invitedError.message });
      }

      const invitedPartners = (invitedPartnersRaw || []).map((i) => ({
        id: i.id,
        instagramHandle: i.instagram_handle || "",
        createdAt: i.created_at || null,
      }));

      const usageByPartner = {};
      const payableByPartner = {};
      (referrals || []).forEach((r) => {
        usageByPartner[r.partner_id] = (usageByPartner[r.partner_id] || 0) + 1;
        if (isWorkshopDatePassed(r.workshop_date)) {
          payableByPartner[r.partner_id] = (payableByPartner[r.partner_id] || 0) + 1;
        }
      });
      const paidByPartner = {};
      (payouts || []).forEach((p) => {
        paidByPartner[p.partner_id] = (paidByPartner[p.partner_id] || 0) + Number(p.amount || 0);
      });

      const vipPartners = (partners || []).map((p) => {
        const usageCount = usageByPartner[p.id] || 0;
        const totalEarned = calcEarnings(usageCount);
        const payableEarned = calcEarnings(payableByPartner[p.id] || 0);
        const alreadyPaid = paidByPartner[p.id] || 0;
        const nextPayoutAmount = Math.max(0, payableEarned - alreadyPaid);
        return {
          id: p.id,
          name: p.name,
          email: p.email,
          instagramHandle: p.instagram_handle || "",
          discountCode: p.discount_code || "",
          courseDate: p.course_date || "",
          attended: Boolean(p.attended),
          usageCount,
          totalEarned,
          nextPayoutAmount,
          nextPayoutDate: nextPayoutAmount > 0 ? getNextPayoutDate() : null,
          createdAt: p.created_at,
        };
      });

      res.json({
        summary: {
          totalBookings,
          totalRevenue,
          totalVipPartners: vipPartners.length,
        },
        bookings,
        workshops,
        castleP16SignUps,
        vipPartners,
        invitedPartners,
      });
    } catch (err) {
      console.error("Error fetching admin dashboard:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * ADMIN - ADD / EDIT / MARK SOLD OUT A WORKSHOP
 * Pass an `id` to update an existing workshop doc, omit it to create a
 * new one. Same fields the site's getWorkshops endpoint reads.
 */
exports.adminSaveWorkshop = onRequest(
  {},
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    try {
      const { token, id, ...fields } = req.body;
      if (!(await verifyAdminToken(token))) {
        return res.status(401).json({ error: "Invalid or expired login link" });
      }

      const workshop = {
        dateLabel: String(fields.dateLabel || "").trim(),
        times: String(fields.times || "").trim(),
        category: fields.category === "in-person" ? "in-person" : "online",
        location: String(fields.location || "").trim(),
        venueName: String(fields.venueName || "").trim(),
        venueAddress: String(fields.venueAddress || "").trim(),
        price: Number(fields.price) || 0,
        sortDate: String(fields.sortDate || "").trim(),
        active: fields.active !== false,
        soldOut: Boolean(fields.soldOut),
        "1session": String(fields["1session"] || "").trim(),
        "2session": String(fields["2session"] || "").trim(),
        "1start_time": String(fields["1start_time"] || "").trim(),
        "1end_time": String(fields["1end_time"] || "").trim(),
        "2start_time": String(fields["2start_time"] || "").trim(),
        "2end_time": String(fields["2end_time"] || "").trim(),
      };

      if (!workshop.dateLabel || !workshop.sortDate) {
        return res.status(400).json({ error: "Missing dateLabel or sortDate" });
      }

      if (id) {
        await db.collection("workshops").doc(String(id)).set(workshop, { merge: true });
      } else {
        await db.collection("workshops").add(workshop);
      }

      res.json({ success: true });
    } catch (err) {
      console.error("Error saving workshop:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * ADMIN - DELETE A WORKSHOP
 */
exports.adminDeleteWorkshop = onRequest(
  {},
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    try {
      const { token, id } = req.body;
      if (!(await verifyAdminToken(token))) {
        return res.status(401).json({ error: "Invalid or expired login link" });
      }
      if (!id) return res.status(400).json({ error: "Missing id" });

      await db.collection("workshops").doc(String(id)).delete();

      res.json({ success: true });
    } catch (err) {
      console.error("Error deleting workshop:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * ADMIN - INVITE A NEW VIP PARTNER (Instagram allow-list)
 */
exports.adminInvitePartner = onRequest(
  { secrets: [supabaseServiceRoleKey] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    try {
      const { token, instagramHandle } = req.body;
      if (!(await verifyAdminToken(token))) {
        return res.status(401).json({ error: "Invalid or expired login link" });
      }

      const handle = String(instagramHandle || "").trim().replace(/^@/, "").toLowerCase();
      if (!handle) return res.status(400).json({ error: "Missing Instagram handle" });

      const supabaseAdmin = getSupabaseAdmin();
      const { error } = await supabaseAdmin.from("invited_partners").insert({ instagram_handle: handle });

      if (error) {
        console.error("Error inviting VIP partner:", error);
        return res.status(500).json({ error: error.message });
      }

      res.json({ success: true });
    } catch (err) {
      console.error("Error inviting VIP partner:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * ADMIN - DELETE AN INVITED PARTNER (Instagram allow-list)
 */
exports.adminDeleteInvitedPartner = onRequest(
  { secrets: [supabaseServiceRoleKey] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    try {
      const { token, id } = req.body;
      if (!(await verifyAdminToken(token))) {
        return res.status(401).json({ error: "Invalid or expired login link" });
      }
      if (!id) return res.status(400).json({ error: "Missing id" });

      const supabaseAdmin = getSupabaseAdmin();
      const { error } = await supabaseAdmin.from("invited_partners").delete().eq("id", id);

      if (error) {
        console.error("Error deleting invited VIP partner:", error);
        return res.status(500).json({ error: error.message });
      }

      res.json({ success: true });
    } catch (err) {
      console.error("Error deleting invited VIP partner:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * ADMIN - MARK A VIP PARTNER AS ATTENDED
 * Flips `attended` to true on their Supabase row (this is what makes
 * their discount code visible/usable per the signup flow) and emails
 * them their now-live code plus the earnings tiers, booking link and
 * the #ad disclosure reminder.
 */
exports.adminMarkPartnerAttended = onRequest(
  { secrets: [supabaseServiceRoleKey, resendApiKey] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    try {
      const { token, id } = req.body;
      if (!(await verifyAdminToken(token))) {
        return res.status(401).json({ error: "Invalid or expired login link" });
      }
      if (!id) return res.status(400).json({ error: "Missing id" });

      const supabaseAdmin = getSupabaseAdmin();
      const { data: partner, error: fetchError } = await supabaseAdmin
        .from("partners")
        .select("*")
        .eq("id", id)
        .maybeSingle();

      if (fetchError) {
        console.error("Error fetching VIP partner:", fetchError);
        return res.status(500).json({ error: fetchError.message });
      }
      if (!partner) return res.status(404).json({ error: "Partner not found" });

      const { error: updateError } = await supabaseAdmin
        .from("partners")
        .update({ attended: true })
        .eq("id", id);

      if (updateError) {
        console.error("Error marking VIP partner attended:", updateError);
        return res.status(500).json({ error: updateError.message });
      }

      const firstName = String(partner.name || "").trim().split(" ")[0] || "there";
      const resend = new Resend(resendApiKey.value());
      await resend.emails.send({
        from: "Leo | Real Life Money <leo@reallifemoney.co.uk>",
        to: partner.email,
        bcc: "leo@reallifemoney.co.uk",
        subject: "Your VIP discount code is live! 🎉",
        html: vipPartnerAttendedEmailHtml(firstName, partner.discount_code || ""),
      });

      res.json({ success: true });
    } catch (err) {
      console.error("Error marking VIP partner attended:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * ADMIN - MANUALLY ADD A BOOKING
 * Lets Leo record a booking taken outside Stripe (e.g. bank transfer,
 * in person) without needing to open Firestore directly. Mirrors the
 * Stripe webhook's booking logic: generates a referral code, saves the
 * booking, syncs the contact to Bigin, and optionally emails the
 * confirmation (bcc'd to Leo).
 */
exports.adminAddBooking = onRequest(
  { secrets: [resendApiKey, biginClientId, biginClientSecret, biginRefreshToken] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    try {
      const { token, fullName, email, courseDate, amountTotal, sendEmail } = req.body;
      if (!(await verifyAdminToken(token))) {
        return res.status(401).json({ error: "Invalid or expired login link" });
      }

      const name = String(fullName || "").trim();
      const customerEmail = String(email || "").trim().toLowerCase();
      if (!name || !customerEmail) {
        return res.status(400).json({ error: "Missing name or email" });
      }

      const firstName = name.split(" ")[0].replace(/[^a-zA-Z]/g, "") || "Friend";
      const lastName = name.split(" ").slice(1).join(" ") || "Booking";
      const chosenDate = String(courseDate || "").trim() || "your upcoming session";
      const amount = Math.round(Number(amountTotal) * 100) || 0;

      const random4Digits = Math.floor(1000 + Math.random() * 9000);
      const referralCode = `${firstName.toUpperCase().slice(0, 4)}${random4Digits}`;

      const bookingRef = db.collection("bookings").doc(`manual_${Date.now()}`);
      await bookingRef.set({
        sessionId: bookingRef.id,
        email: customerEmail,
        fullName: name,
        courseDate: chosenDate,
        workshop: chosenDate,
        referralCode: referralCode,
        paymentIntent: null,
        amountTotal: amount,
        manualEntry: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const manualWorkshop = await getWorkshopByLabel(chosenDate);
      await createBiginContact(
        firstName,
        lastName,
        customerEmail,
        referralCode,
        chosenDate,
        biginClientId.value(),
        biginClientSecret.value(),
        biginRefreshToken.value(),
        false,
        workshopSessionFields(manualWorkshop)
      );

      if (sendEmail !== false) {
        const resend = new Resend(resendApiKey.value());
        await resend.emails.send({
          from: "Leo | Real Life Money <leo@reallifemoney.co.uk>",
          to: customerEmail,
          bcc: "leo@reallifemoney.co.uk",
          subject: "Booking Confirmed! Here's your referral code 🎉",
          html: bookingConfirmationEmailHtml(firstName, chosenDate, referralCode),
        });
      }

      res.json({ success: true, referralCode });
    } catch (err) {
      console.error("Error adding manual booking:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * ADMIN - EDIT AN EXISTING BOOKING
 * Updates the editable fields on a booking doc - referral code, Bigin
 * sync and email are only handled on creation, not here.
 */
exports.adminUpdateBooking = onRequest(
  {},
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    try {
      const { token, id, fullName, email, courseDate, amountTotal, referralCode } = req.body;
      if (!(await verifyAdminToken(token))) {
        return res.status(401).json({ error: "Invalid or expired login link" });
      }
      if (!id) return res.status(400).json({ error: "Missing id" });

      const name = String(fullName || "").trim();
      const customerEmail = String(email || "").trim().toLowerCase();
      if (!name || !customerEmail) {
        return res.status(400).json({ error: "Missing name or email" });
      }

      const chosenDate = String(courseDate || "").trim() || "your upcoming session";

      await db.collection("bookings").doc(String(id)).set(
        {
          fullName: name,
          email: customerEmail,
          courseDate: chosenDate,
          workshop: chosenDate,
          referralCode: String(referralCode || "").trim(),
          amountTotal: Math.round(Number(amountTotal) * 100) || 0,
        },
        { merge: true }
      );

      res.json({ success: true });
    } catch (err) {
      console.error("Error updating booking:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * ADMIN - DELETE A BOOKING
 */
exports.adminDeleteBooking = onRequest(
  {},
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    try {
      const { token, id } = req.body;
      if (!(await verifyAdminToken(token))) {
        return res.status(401).json({ error: "Invalid or expired login link" });
      }
      if (!id) return res.status(400).json({ error: "Missing id" });

      await db.collection("bookings").doc(String(id)).delete();

      res.json({ success: true });
    } catch (err) {
      console.error("Error deleting booking:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * ADMIN - ADD A CASTLE SCHOOL P16 SIGN-UP MANUALLY
 */
exports.adminAddCastleP16 = onRequest({}, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const { token, fullName, yearGroup, email } = req.body;
    if (!(await verifyAdminToken(token))) {
      return res.status(401).json({ error: "Invalid or expired login link" });
    }

    const name = String(fullName || "").trim();
    const year = String(yearGroup || "").trim();
    const schoolEmail = String(email || "").trim().toLowerCase();
    if (!name || !schoolEmail) {
      return res.status(400).json({ error: "Missing name or email" });
    }

    await db.collection("castleP16SignUps").add({
      fullName: name,
      yearGroup: year,
      email: schoolEmail,
      disclaimerAccepted: true,
      manualEntry: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Error adding Castle School P16 sign-up:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * ADMIN - EDIT A CASTLE SCHOOL P16 SIGN-UP
 */
exports.adminUpdateCastleP16 = onRequest({}, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const { token, id, fullName, yearGroup, email } = req.body;
    if (!(await verifyAdminToken(token))) {
      return res.status(401).json({ error: "Invalid or expired login link" });
    }
    if (!id) return res.status(400).json({ error: "Missing id" });

    const name = String(fullName || "").trim();
    const year = String(yearGroup || "").trim();
    const schoolEmail = String(email || "").trim().toLowerCase();
    if (!name || !schoolEmail) {
      return res.status(400).json({ error: "Missing name or email" });
    }

    await db.collection("castleP16SignUps").doc(String(id)).set(
      { fullName: name, yearGroup: year, email: schoolEmail },
      { merge: true }
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Error updating Castle School P16 sign-up:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * ADMIN - DELETE A CASTLE SCHOOL P16 SIGN-UP
 */
exports.adminDeleteCastleP16 = onRequest({}, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const { token, id } = req.body;
    if (!(await verifyAdminToken(token))) {
      return res.status(401).json({ error: "Invalid or expired login link" });
    }
    if (!id) return res.status(400).json({ error: "Missing id" });

    await db.collection("castleP16SignUps").doc(String(id)).delete();

    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting Castle School P16 sign-up:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * ADMIN - DELETE A VIP PARTNER
 * Removing the partner row also cascades to their `referrals` and
 * `payouts` rows (FK on delete cascade in supabase-schema.sql).
 */
exports.adminDeletePartner = onRequest(
  { secrets: [supabaseServiceRoleKey] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    try {
      const { token, id } = req.body;
      if (!(await verifyAdminToken(token))) {
        return res.status(401).json({ error: "Invalid or expired login link" });
      }
      if (!id) return res.status(400).json({ error: "Missing id" });

      const supabaseAdmin = getSupabaseAdmin();
      const { error } = await supabaseAdmin.from("partners").delete().eq("id", id);

      if (error) {
        console.error("Error deleting VIP partner:", error);
        return res.status(500).json({ error: error.message });
      }

      res.json({ success: true });
    } catch (err) {
      console.error("Error deleting VIP partner:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Add this alongside your other functions. Requires the same
// GOOGLE_PLACES_API_KEY secret as before, plus your existing
// SUPABASE_SERVICE_ROLE_KEY secret (already bound elsewhere).

const googlePlacesApiKey = defineSecret("GOOGLE_PLACES_API_KEY");
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

exports.getGoogleReviews = onRequest(
  { secrets: [googlePlacesApiKey, supabaseServiceRoleKey] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");

    if (req.method === "OPTIONS") return res.status(204).send("");

    const PLACE_ID = "ChIJY_JkPDaQcUgRqATPd0cAOh4"; // from the Place ID Finder
    const supabaseAdmin = getSupabaseAdmin();

    try {
      // --- Check the cache first ---
      const { data: cached } = await supabaseAdmin
        .from("google_reviews_cache")
        .select("data, fetched_at")
        .eq("id", "main")
        .maybeSingle();

      const cacheAge = cached ? Date.now() - new Date(cached.fetched_at).getTime() : Infinity;

      if (cached && cacheAge < CACHE_MAX_AGE_MS) {
        return res.json(cached.data);
      }

      // --- Cache missing or stale - fetch fresh from Google ---
      const response = await fetch(
        `https://places.googleapis.com/v1/places/${PLACE_ID}`,
        {
          headers: {
            "X-Goog-Api-Key": googlePlacesApiKey.value(),
            "X-Goog-FieldMask": "reviews,rating,userRatingCount",
          },
        }
      );

      if (!response.ok) {
        const errText = await response.text();
        console.error("Places API error:", errText);

        // If Google fails but we have ANY cached copy (even stale),
        // serve that rather than a broken carousel.
        if (cached) return res.json(cached.data);
        return res.status(500).json({ error: "Failed to fetch reviews" });
      }

      const raw = await response.json();

      const payload = {
        overallRating: raw.rating || 0,
        totalReviews: raw.userRatingCount || 0,
        reviews: (raw.reviews || []).map((r) => ({
          authorName: r.authorAttribution?.displayName || "Anonymous",
          authorPhoto: r.authorAttribution?.photoUri || "",
          rating: r.rating || 0,
          text: r.text?.text || "",
          relativeTime: r.relativePublishTimeDescription || "",
        })),
      };

      // --- Update the cache for next time ---
      await supabaseAdmin
        .from("google_reviews_cache")
        .upsert({ id: "main", data: payload, fetched_at: new Date().toISOString() });

      res.json(payload);
    } catch (err) {
      console.error("Error fetching Google reviews:", err);
      res.status(500).json({ error: err.message });
    }
  }
);