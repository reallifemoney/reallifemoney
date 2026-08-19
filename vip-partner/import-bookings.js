const admin = require('firebase-admin');

// Initialize Firebase Admin (uses default project config or service account)
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

const bookingsData = [
  {
    name: "Marcie Bower",
    email: "marciemiabower@gmail.com",
    workshop: "Tue 1st & 8th September (6:30pm – 8:00pm) — 🖥️ Live online",
    amountPaid: 37.50,
    referralCode: "",
    vipPartner: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  },
  {
    name: "Owen Crossley",
    email: "owencrossley01@gmail.com",
    workshop: "Tue 1st & 8th September (6:30pm – 8:00pm) — 🖥️ Live online",
    amountPaid: 37.50,
    referralCode: "",
    vipPartner: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  },
  {
    name: "Sebastian Sterl",
    email: "sebastiansterl@gmail.com",
    workshop: "Wed 7th & 14th October (6:30pm – 8:00pm) — 🖥️ Live online",
    amountPaid: 37.50,
    referralCode: "",
    vipPartner: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  },
  {
    name: "Katie Kin",
    email: "katie.kinleverett@gmail.com",
    workshop: "Tue 1st & 8th September (6:30pm – 8:00pm) — 🖥️ Live online",
    amountPaid: 37.50,
    referralCode: "",
    vipPartner: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  },
  {
    name: "Ollie Miller",
    email: "oliverjoemiller@outlook.com",
    workshop: "Tue 1st & 8th September (6:30pm – 8:00pm) — 🖥️ Live online",
    amountPaid: 37.50,
    referralCode: "",
    vipPartner: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  },
  {
    name: "Siobhan Hickin",
    email: "siobhan.hickin@gmail.com",
    workshop: "Tue 1st & 8th September (6:30pm – 8:00pm) — 🖥️ Live online",
    amountPaid: 0, // Left at 0 per instructions; update value if needed
    referralCode: "",
    vipPartner: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  },
  {
    name: "Leah Matthews",
    email: "leah-matthews1@hotmail.co.uk",
    workshop: "Tue 1st & 8th September (6:30pm – 8:00pm) — 🖥️ Live online",
    amountPaid: 37.50,
    referralCode: "",
    vipPartner: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  },
  {
    name: "Kirstin Walling",
    email: "kirstinwalling@gmail.com",
    workshop: "Tue 1st & 8th September (6:30pm – 8:00pm) — 🖥️ Live online",
    amountPaid: 37.50,
    referralCode: "",
    vipPartner: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  },
  {
    name: "Kristofor Collins",
    email: "kristoforthemime@gmail.com",
    workshop: "Tue 1st & 8th September (6:30pm – 8:00pm) — 🖥️ Live online",
    amountPaid: 0, // Left at 0 per instructions; update value if needed
    referralCode: "",
    vipPartner: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }
];

async function importBookings() {
  const batch = db.batch();
  const bookingsRef = db.collection('bookings');

  bookingsData.forEach((booking) => {
    const docRef = bookingsRef.doc(); // Generates auto ID
    batch.set(docRef, booking);
  });

  await batch.commit();
  console.log(`Successfully imported ${bookingsData.length} bookings into Firebase!`);
}

importBookings().catch(console.error);