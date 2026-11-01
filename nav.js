(function(){
  if(document.querySelector('.rlm-nav'))return;
  var MENU='<button class="rlm-row" aria-expanded="false">Investing workshops<span class="rlm-chev"></span></button>'
   +'<div class="rlm-sub" hidden>'
   +'<a href="/investing-course" style="--c:#8c52ff">Online</a>'
   +'<a href="/investing-on-tap" style="--c:#ff914d">In the pub</a>'
   +'<a href="/schools" style="--c:#ffde59">Schools</a>'
   +'<a href="/employers" style="--c:#71c558">Workplaces</a></div>'
   +'<hr>'
   +'<a href="/invest-a-long">Invest-a-long</a>'
   +'<a href="/retirement-coaching">1-2-1 coaching</a>'
   +'<a href="/teacher-pension-support">Teacher Pension Support</a>'
   +'<a href="/blog">Blog</a>'
   +'<a href="/about">About me</a>'
   +'<a href="/contact">Contact me</a>';
  function build(){
    if(!document.querySelector('link[href*="family=Lexend"]')){
      var f=document.createElement('link');f.rel='stylesheet';f.href='https://fonts.googleapis.com/css2?family=Lexend:wght@400;500;600;700&display=swap';document.head.appendChild(f);
    }
    var h=document.createElement('div');
    h.className='rlm-nav';
    h.innerHTML='<a class="rlm-brand" href="/"><img src="/logo-nav.png" alt=""><span>Real Life Money</span></a>'
      +'<button class="rlm-burger" aria-label="Open menu" aria-expanded="false"><i></i><i></i><i></i></button>'
      +'<div class="rlm-menu" role="navigation" aria-label="Main" hidden>'+MENU+'</div>';
    var host=document.querySelector('[data-nav-host]');
    if(host)host.appendChild(h);else document.body.insertBefore(h,document.body.firstChild);
    // hide any older fixed/sticky nav bars the page still has
    document.querySelectorAll('nav').forEach(function(n){
      if(h.contains(n))return;
      var p=getComputedStyle(n).position;
      if(p==='fixed'||p==='sticky')n.style.display='none';
    });
    var b=h.querySelector('.rlm-burger'),m=h.querySelector('.rlm-menu'),r=h.querySelector('.rlm-row'),s=h.querySelector('.rlm-sub');
    function shut(){m.hidden=true;b.setAttribute('aria-expanded',false);b.setAttribute('aria-label','Open menu')}
    b.onclick=function(e){e.stopPropagation();var o=m.hidden;m.hidden=!o;b.setAttribute('aria-expanded',o);b.setAttribute('aria-label',o?'Close menu':'Open menu')};
    r.onclick=function(){var o=s.hidden;s.hidden=!o;r.setAttribute('aria-expanded',o)};
    document.addEventListener('click',function(e){if(!m.hidden&&!m.contains(e.target))shut()});
    document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!m.hidden){shut();b.focus()}});
  }
  if(document.body)build();else document.addEventListener('DOMContentLoaded',build);
})();
