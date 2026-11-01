/* Renders a two-tab toggle card into [data-compare] from window.RLM_COMPARE:
   {title, tabs:[{label, heading, mark, items:[[bold, text], ...], stars}]} */
(function(){
  var cfg=window.RLM_COMPARE,host=document.querySelector('[data-compare]');
  if(!cfg||!host)return;
  var tabs=cfg.tabs;
  host.innerHTML='<div class="rlm-cmp-in">'+(cfg.title?'<h2 class="rlm-cmp-title">'+cfg.title+'</h2>':'')
    +'<div class="rlm-tg" data-s="0"><div class="rlm-thumb"></div>'
    +tabs.map(function(t,i){return '<button type="button" aria-pressed="'+(i===0)+'">'+t.label+'</button>'}).join('')
    +'</div>'
    +tabs.map(function(t,i){
      return '<section class="rlm-card'+(i===0?' show':'')+'" data-t="'+i+'"><h3>'+t.heading+'</h3><ul>'
        +t.items.map(function(x){return '<li><span class="rlm-ic" aria-hidden="true">'+t.mark+'</span><span><b>'+x[0]+'</b>'+(x[1]||'')+'</span></li>'}).join('')
        +'</ul>'+(t.stars?'<div class="rlm-stars"><em aria-hidden="true">★★★★★</em><span><b>5.0 on Google</b> (45 reviews)</span></div>':'')+'</section>';
    }).join('')+'</div>';
  var tg=host.querySelector('.rlm-tg'),bt=tg.querySelectorAll('button'),cs=host.querySelectorAll('.rlm-card');
  bt.forEach(function(b,i){
    b.addEventListener('click',function(){
      tg.dataset.s=i;
      bt.forEach(function(x,j){x.setAttribute('aria-pressed',j===i)});
      cs.forEach(function(c,j){c.classList.toggle('show',j===i)});
    });
  });
})();
