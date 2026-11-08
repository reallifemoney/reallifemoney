(function(){
  if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.remove('fade-up-pending');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0 });
  document.querySelectorAll('.rlm-top-in > h1, .rlm-top-in > .rlm-sub, .rlm-top-in > .rlm-cmp, [data-trust-bar], body > section:not(.rlm-top) > .wrap > *').forEach(element => {
    const rect = element.getBoundingClientRect();
    if (rect.height && rect.top >= window.innerHeight) {
      element.classList.add('fade-up', 'fade-up-pending');
      observer.observe(element);
    }
  });
})();
