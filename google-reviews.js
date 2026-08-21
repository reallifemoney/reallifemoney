const REVIEWS_FUNCTION_URL = "https://us-central1-workshop-booking-system-b791e.cloudfunctions.net/getGoogleReviews";

function starString(rating) {
  const full = Math.round(rating);
  return "★".repeat(full) + "☆".repeat(5 - full);
}

function initial(name) {
  return (name || "?").trim().charAt(0).toUpperCase();
}

async function loadReviews() {
  const track = document.getElementById("reviewsTrack");
  const dotsWrap = document.getElementById("reviewsDots");

  try {
    const res = await fetch(REVIEWS_FUNCTION_URL);
    const data = await res.json();

    if (data.overallRating) {
      document.getElementById("reviewsOverallStars").textContent = starString(data.overallRating);
      document.getElementById("reviewsOverallText").textContent =
        `${data.overallRating.toFixed(1)} from ${data.totalReviews} reviews`;
      document.getElementById("reviewsSummary").hidden = false;
    }

    if (!data.reviews || !data.reviews.length) return;

    track.innerHTML = "";
    dotsWrap.innerHTML = "";

    data.reviews.forEach((r, i) => {
      const card = document.createElement("div");
      card.className = "review-card";
      card.innerHTML = `
        <div class="review-card-header">
          ${r.authorPhoto
            ? `<img class="review-avatar" src="${r.authorPhoto}" alt="${r.authorName}">`
            : `<div class="review-avatar-fallback">${initial(r.authorName)}</div>`
          }
          <div>
            <div class="review-author">${r.authorName}</div>
            <div class="review-time">${r.relativeTime}</div>
          </div>
        </div>
        <div class="review-stars">${starString(r.rating)}</div>
        <p class="review-text">${r.text}</p>
      `;
      track.appendChild(card);

      const dot = document.createElement("span");
      dot.addEventListener("click", () => goToReview(i));
      dotsWrap.appendChild(dot);
    });

    renderReviewsPosition();
  } catch (err) {
    console.error("Error loading Google reviews:", err);
  }
}

let currentReview = 0;

function renderReviewsPosition() {
  const track = document.getElementById("reviewsTrack");
  const cards = track.children;
  track.style.transform = `translateX(-${currentReview * 100}%)`;
  Array.from(document.getElementById("reviewsDots").children).forEach((d, i) =>
    d.classList.toggle("active", i === currentReview)
  );
}

function goToReview(i) {
  const track = document.getElementById("reviewsTrack");
  const total = track.children.length;
  currentReview = ((i % total) + total) % total;
  renderReviewsPosition();
}

document.getElementById("reviewsPrev").addEventListener("click", () => goToReview(currentReview - 1));
document.getElementById("reviewsNext").addEventListener("click", () => goToReview(currentReview + 1));

// Auto-advance every 6 seconds
setInterval(() => {
  const track = document.getElementById("reviewsTrack");
  if (track.children.length > 1) goToReview(currentReview + 1);
}, 6000);

loadReviews();
