// Shows the booking bar once the visitor scrolls, and hides it while the booking/enquiry sections are on screen.
(function(){
  var bar=document.querySelector('.rlm-book');if(!bar)return;
  var t=document.querySelectorAll(bar.dataset.hide||''),seen=new Set(),scrolled=false;
  function update(){bar.classList.toggle('hide',!scrolled||seen.size>0)}
  function onScroll(){scrolled=window.scrollY>280;update()}
  if('IntersectionObserver' in window&&t.length){
    var io=new IntersectionObserver(function(es){
      es.forEach(function(e){e.isIntersecting?seen.add(e.target):seen.delete(e.target)});
      update();
    },{threshold:0.05});
    t.forEach(function(x){io.observe(x)});
  }
  addEventListener('scroll',onScroll,{passive:true});onScroll();
})();
