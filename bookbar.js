// Hides the booking bar while the booking/enquiry sections are on screen.
(function(){
  var bar=document.querySelector('.rlm-book');if(!bar||!('IntersectionObserver' in window))return;
  var t=document.querySelectorAll(bar.dataset.hide||''),seen=new Set();
  if(!t.length)return;
  var io=new IntersectionObserver(function(es){
    es.forEach(function(e){e.isIntersecting?seen.add(e.target):seen.delete(e.target)});
    bar.classList.toggle('hide',seen.size>0);
  },{threshold:0.05});
  t.forEach(function(x){io.observe(x)});
})();
