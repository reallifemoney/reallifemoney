const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const workshops = [
  {
    active: true,
    category: "online",
    dateLabel: "Tue 1st & 8th September",
    times: "6:30pm – 8:00pm",
    location: "🖥️ Live online",
    price: 75,
    sortDate: "2026-09-01",
    venueName: "",
    venueAddress: "",
  },
  {
    active: true,
    category: "in-person",
    dateLabel: "Tue 15th & 22nd September",
    times: "6:45pm – 8:15pm",
    location: "",
    price: 75,
    sortDate: "2026-09-15",
    venueName: "Brooklands Park Community Centre",
    venueAddress: "2 Clover Wy, Bristol, BS34 8AZ",
  },
  {
    active: true,
    category: "online",
    dateLabel: "Wed 7th & 14th October",
    times: "6:30pm – 8:00pm",
    location: "🖥️ Live online",
    price: 75,
    sortDate: "2026-10-07",
    venueName: "",
    venueAddress: "",
  },
  {
    active: true,
    category: "online",
    dateLabel: "Mon 9th & 16th November",
    times: "6:30pm – 8:00pm",
    location: "🖥️ Live online",
    price: 75,
    sortDate: "2026-11-09",
    venueName: "",
    venueAddress: "",
  },
];

async function seed() {
  for (const workshop of workshops) {
    const ref = await db.collection("workshops").add(workshop);
    console.log(`Added: ${workshop.dateLabel} (${ref.id})`);
  }
  console.log("Done!");
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});