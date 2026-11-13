async page => {
  const origin=/^http:\/\/127\.0\.0\.1:\d+(?=\/|$)/.exec(page.url())?.[0];
  if(!origin)throw new Error('Open the local chat card preview first.');
  await page.addInitScript(()=>{
    const counters={cardMeasurements:0,heightAnimations:0,longTasks:[],frames:[]};
    window.__chatPerf=counters;
    const measure=Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect=function(...args){
      if(this.classList?.contains('card-body'))counters.cardMeasurements++;
      return Reflect.apply(measure,this,args);
    };
    const animate=Element.prototype.animate;
    Element.prototype.animate=function(keyframes,...args){
      if(this.classList?.contains('card-body')||this.classList?.contains('fold-inner'))counters.heightAnimations++;
      return Reflect.apply(animate,this,[keyframes,...args]);
    };
    new PerformanceObserver(list=>{
      for(const task of list.getEntries())counters.longTasks.push(Math.round(task.duration*100)/100);
    }).observe({type:'longtask'});
  });
  await page.setViewportSize({width:1440,height:1000});
  const results=[];
  for(const cards of [1,8]){
    await page.goto(origin+'/');
    await page.waitForFunction(()=>window.__dsgChatReady);
    await page.evaluate(()=>window.__dsgChatFixture.show('planned-fallback'));
    await page.waitForFunction(()=>document.querySelector('.search-card'));
    await page.evaluate(cards=>window.__dsgChatFixture.stream({ticks:3,cards}),cards);
    await page.waitForFunction(()=>document.querySelectorAll('.search-card').length===document.querySelectorAll('[data-dsg-search-card]').length);
    const result=await page.evaluate(async cards=>{
      const counters=window.__chatPerf;
      counters.cardMeasurements=0;counters.heightAnimations=0;counters.longTasks=[];counters.frames=[];
      let previous=null,frame;
      const tick=time=>{if(previous!==null)counters.frames.push(time-previous);previous=time;frame=requestAnimationFrame(tick);};
      frame=requestAnimationFrame(tick);
      const before=window.__dsgChatFixture.stats(),started=performance.now();
      const stream=await window.__dsgChatFixture.stream({ticks:180,cards,clone:true});
      cancelAnimationFrame(frame);
      const sorted=counters.frames.toSorted((a,b)=>a-b);
      const result={cards,ticks:stream.ticks,durationMs:Math.round(performance.now()-started),
        cardMeasurements:counters.cardMeasurements,heightAnimations:counters.heightAnimations,
        longTasks:counters.longTasks,frameP95Ms:Math.round((sorted[Math.floor(sorted.length*.95)]??0)*100)/100,
        maxFrameMs:Math.round((sorted.at(-1)??0)*100)/100,
        addedReads:window.__dsgChatFixture.stats().reads-before.reads,
        cardRenders:window.__dsgChatFixture.stats().cardRenders-before.cardRenders};
      return result;
    },cards);
    results.push(result);
  }
  return {syntheticStreaming:true,react:await page.evaluate(()=>window.__dsgChatReady.react),results};
}
