/* Add [data-trust-bar]; use data-guarantee-deadline="session" or "meeting" for one-session services. */
(function(){
  const deadlines = {
    session: 'your session',
    meeting: 'your meeting',
    second: 'your second session'
  };
  document.querySelectorAll('[data-trust-bar]').forEach((host, index) => {
    const deadlineType = host.dataset.guaranteeDeadline || 'second';
    const deadline = deadlines[deadlineType];
    if (!deadline) {
      console.error('Invalid trust bar guarantee deadline:', host.dataset.guaranteeDeadline);
      return;
    }
    const titleId = 'rlm-guarantee-title-' + index;
    const descriptionId = 'rlm-guarantee-description-' + index;
    const dialogId = 'rlm-guarantee-' + index;
    const shield = '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M24 4l16 6v12c0 10-6.5 18.5-16 22C14.5 40.5 8 32 8 22V10l16-6z" fill="#eef8eb" stroke="#1F3A29" stroke-width="3" stroke-linejoin="round"/><path d="M16 24l6 6 11-12" stroke="#71c558" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    host.classList.add('rlm-trust');
    host.setAttribute('role', 'region');
    host.setAttribute('aria-label', 'Why trust Real Life Money');
    host.innerHTML = `
      <div class="rlm-trust-grid">
        <a class="rlm-trust-cell" href="https://www.cii.co.uk/learning/qualifications/diploma-in-regulated-financial-planning-qualification" target="_blank" rel="noopener noreferrer">
          <span class="rlm-trust-cap">Qualified with</span>
          <span class="rlm-trust-logo"><img src="/cii.webp" alt="Chartered Insurance Institute"></span>
          <span class="rlm-trust-sub">Diploma in Regulated Financial Planning</span>
        </a>
        <div class="rlm-trust-cell">
          <span class="rlm-trust-cap">Employed by</span>
          <span class="rlm-trust-logo rlm-trust-pathways"><img src="/pathways.png" alt=""><span>Pathways Trust</span></span>
          <span class="rlm-trust-sub">Full-time teacher</span>
        </div>
        <button class="rlm-trust-cell" type="button" aria-haspopup="dialog" aria-controls="${dialogId}">
          <span class="rlm-trust-cap">My promise</span>
          <span class="rlm-trust-title">${shield}<span>Confidence guarantee</span></span>
          <span class="rlm-trust-sub">Full refund if you're not more confident. <span class="rlm-trust-more">Tap to see how</span></span>
        </button>
        <a class="rlm-trust-cell" href="https://maps.app.goo.gl/HdFMCXXdQW5TEw8s9?g_st=ic" target="_blank" rel="noopener noreferrer">
          <span class="rlm-trust-cap">Happy customers</span>
          <span class="rlm-trust-logo"><img class="rlm-trust-google" src="/google-reviews.png" alt="5.0, excellent on Google, five stars"></span>
          <span class="rlm-trust-sub">5* rated on Google</span>
        </a>
      </div>
      <dialog class="rlm-guarantee" id="${dialogId}" aria-labelledby="${titleId}" aria-describedby="${descriptionId}">
        <div class="rlm-guarantee-pop">
          <button class="rlm-guarantee-close" type="button" aria-label="Close">&times;</button>
          ${shield}
          <h2 id="${titleId}">The Confidence Guarantee</h2>
          <p id="${descriptionId}">If you don't come away feeling more confident about ${deadlineType === 'meeting' ? 'retirement planning' : 'investing'}, you get a full refund. <a href="/contact">Let me know</a> within 14 days after ${deadline}.</p>
          <button class="rlm-guarantee-ok" type="button">Got it</button>
        </div>
      </dialog>`;
    const dialog = host.querySelector('dialog');
    host.querySelector('[aria-haspopup="dialog"]').addEventListener('click', () => dialog.showModal());
    dialog.querySelectorAll('button').forEach(button => button.addEventListener('click', () => dialog.close()));
    dialog.addEventListener('click', event => {
      if (event.target === dialog) dialog.close();
    });
  });
})();
