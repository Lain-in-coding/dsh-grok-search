async page => {
  const origin=/^http:\/\/127\.0\.0\.1:\d+(?=\/|$)/.exec(page.url())?.[0];
  if(!origin)throw new Error('Open the local chat card preview first.');
  const checks=[],errors=[],external=[];
  const check=(name,value)=>{checks.push({name,passed:value===true});if(value!==true)throw new Error(name);};
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  page.on('request',request=>{if(/^https?:/.test(request.url())&&!request.url().startsWith(origin+'/'))external.push(request.url());});
  await page.addInitScript(()=>{
    window.__chatTaskObserver?.disconnect();
    window.__chatLongTasks=[];
    window.__chatTaskObserver=new PerformanceObserver(list=>{for(const task of list.getEntries())window.__chatLongTasks.push(Math.round(task.duration));});
    window.__chatTaskObserver.observe({type:'longtask',buffered:true});
  });
  await page.setViewportSize({width:1440,height:900});
  await page.goto(origin+'/');
  await page.waitForFunction(()=>window.__dsgChatReady);
  const show=async name=>{
    const key=await page.evaluate(name=>window.__dsgChatFixture.show(name),name);
    await page.waitForFunction(key=>document.querySelector('.dsg-chat')?.dataset.dsgSearchCard===key,key);
    return key;
  };
  check('real React matches inspected official host version',await page.evaluate(()=>window.__dsgChatReady.react==='18.3.1'));
  const cases=[['fallback',2],['success',1],['direct',1],['rotation',2],['lastsuccess',5],
    ['allfail',5],['cancelled',1],['batch',4],['partial',2],['long',5],['metadata',2],['planned-fallback',2],
    ['source-only',1],['kernel-batch',4],['kernel-last',5]];
  for(const [scene,count]of cases){
    await show(scene);
    await page.waitForFunction(count=>document.querySelectorAll('.provider-steps .route-node').length===count,count);
    check(`${scene}: all attempted suppliers`,await page.locator('.provider-steps .route-node').count()===count);
    check(`${scene}: correct identity`,await page.locator('.card-name').innerText()==='dsh-grok-search');
    check(`${scene}: route display name`,await page.locator('.ingress').allTextContents().then(rows=>rows.every(row=>row.includes('Grok Search Rs'))));
    check(`${scene}: official logos loaded`,await page.evaluate(()=>[...document.images].every(image=>image.complete&&image.naturalWidth>0)));
    check(`${scene}: chat whale uses a small precomposed image without backdrop blending`,await page.evaluate(()=>
      [...document.querySelectorAll('.logo[data-logo=dsh]')].every(image=>{
        const style=getComputedStyle(image);
        return image.naturalWidth===64&&image.naturalHeight===64&&style.mixBlendMode==='normal'&&style.filter==='none';
      })));
    check(`${scene}: every query stays on one horizontal line`,await page.evaluate(()=>[...document.querySelectorAll('.flow')].every(flow=>{
      const boxes=[...flow.querySelectorAll('.route-node')].map(node=>node.getBoundingClientRect());
      return boxes.every((box,index)=>Math.abs(box.top-boxes[0].top)<1&&(!index||box.left>=boxes[index-1].right));
    })));
    check(`${scene}: every displayed supplier has a visible incoming connector`,await page.evaluate(()=>
      [...document.querySelectorAll('.flow')].every(flow=>{
        const suppliers=flow.querySelectorAll('.provider-steps>.route-node');
        const edges=flow.querySelectorAll('.bridge,.provider-steps>.edge');
        return edges.length===suppliers.length&&[...edges].every(edge=>{
          const box=edge.getBoundingClientRect(),style=getComputedStyle(edge);
          return box.width>0&&box.height>0&&style.visibility==='visible'&&style.display!=='none'&&Number(style.opacity)>0;
        });
      })));
    check(`${scene}: verbose provenance notice removed`,!await page.locator('.card-body').textContent()
      .then(text=>text.includes('仅展示已报告的调用及结果来源；未报告的顺序与耗时不推算。')));
  }
  for(const scene of ['source-only','planned-fallback','partial','kernel-batch','kernel-last']){
    await show(scene);
    await page.waitForFunction(()=>document.querySelector('.source-evidence'));
    check(`${scene}: source associations have an arrowhead without invented transit or latency`,await page.evaluate(()=>
      [...document.querySelectorAll('.source-evidence')].every(node=>{
        const edge=node.previousElementSibling?.matches('.edge')?node.previousElementSibling:node.parentElement.previousElementSibling;
        const head=edge?.querySelector('.wire-head'),track=edge?.querySelector('.wire-track');
        return head&&track&&getComputedStyle(head).display!=='none'&&getComputedStyle(head).visibility==='visible'
          &&getComputedStyle(track).strokeDasharray!=='none'&&!edge.classList.contains('active')
          &&!node.querySelector('.route-note').textContent.includes('秒');
      })));
  }
  await show('metadata');
  await page.waitForFunction(()=>document.querySelector('.answer-summary'));
  check('host metadata remains available',await page.locator('.card-body').textContent().then(text=>
    text.includes('保留宿主原始摘要')&&text.includes('保留来源的正文摘要')&&text.includes('部分搜索结果已截断')));
  check('native URL context-menu props retained',await page.locator('.source-row[data-url-menu=preserved]').count()===1);
  await page.locator('.inspect-btn').click();
  check('native parameter inspector callback used',await page.evaluate(()=>window.__dsgChatFixture.stats().inspected===1));
  await page.locator('.card-toggle').click();
  check('collapsed content inert',await page.locator('.fold').evaluate(element=>element.inert));
  check('collapsed content is clipped to zero height',await page.locator('.fold-inner').evaluate(async element=>{
    await Promise.all(element.parentElement.getAnimations().map(animation=>animation.finished.catch(()=>{})));
    return element.getBoundingClientRect().height<1;
  }));
  await page.locator('.card-toggle').focus();await page.keyboard.press('Enter');
  check('keyboard disclosure works',await page.locator('.card-toggle').getAttribute('aria-expanded')==='true');
  for(const scene of ['expired','unreadable']){
    await show(scene);
    await page.waitForFunction(scene=>document.querySelector('.dsg-tool-attribution')?.textContent.includes(scene==='expired'?'未记录':'暂不可读'),scene);
    check(`${scene}: original result preserved`,await page.locator('[data-native-result]').count()===1);
  }
  await page.evaluate(()=>window.__dsgChatFixture.start());
  await page.waitForFunction(()=>document.querySelectorAll('.provider-steps .route-node').length===5);
  await page.evaluate(()=>{window.__stableRoute=[...document.querySelectorAll('.route-node,.edge')];});
  for(let stage=1;stage<=5;stage++){
    await page.evaluate(index=>window.__dsgChatFixture.advance(index),stage);
    await page.waitForFunction(index=>document.querySelectorAll('.provider-steps [data-result=failed]').length===Math.min(index,4)
      &&(index===5?document.querySelector('.provider-steps [data-result=ok]')?.textContent.includes('Firecrawl')
        :document.querySelectorAll('.provider-steps [data-result=running]').length===1),stage);
    check(`stage ${stage}: nodes retained`,await page.evaluate(()=>window.__stableRoute.every(node=>node.isConnected)));
    check(`stage ${stage}: pending sources not marked failed`,await page.locator('.provider-steps [data-result=failed]').count()===Math.min(stage,4));
  }
  await page.waitForFunction(()=>document.querySelector('.card-body').getAnimations({subtree:true}).length===0);
  check('completed card has no active animations',await page.locator('.card-body').evaluate(element=>element.getAnimations({subtree:true}).length===0));
  check('completed edges keep static arrows without invisible filtered light surfaces',await page.evaluate(()=>
    [...document.querySelectorAll('.edge:not(.active) .wire-flow')].every(path=>getComputedStyle(path).display==='none')));
  const fits=()=>page.evaluate(()=>{
    const root=document.querySelector('.search-card'),box=root.getBoundingClientRect();
    return [...root.querySelectorAll('.flow-scroll,.state,.source-row')].every(node=>{
      const r=node.getBoundingClientRect();return r.left>=box.left-1&&r.right<=box.right+1;
    });
  });
  const horizontal=()=>page.evaluate(()=>[...document.querySelectorAll('.flow')].every(flow=>{
    const nodes=[...flow.querySelectorAll('.route-node')].map(node=>node.getBoundingClientRect());
    return nodes.every((node,index)=>Math.abs(node.top-nodes[0].top)<1&&(!index||node.left>=nodes[index-1].right));
  }));
  let lightWhale=null;
  for(const dark of [false,true]){
    await show('lastsuccess');
    await page.evaluate(dark=>window.__dsgChatFixture.dark(dark),dark);
    await page.waitForFunction(dark=>document.querySelector('.dsg-chat')?.dataset.theme===(dark?'dark':'light'),dark);
    await page.waitForFunction(()=>document.querySelector('.search-card'));
    await page.waitForFunction(()=>[...document.querySelectorAll('.logo[data-logo=dsh]')].every(image=>image.complete&&image.naturalWidth===64));
    const whale=await page.locator('.logo[data-logo=dsh]').first().getAttribute('src');
    if(!dark)lightWhale=whale;
    else check('dark whale selects its prepared asset instead of a filter or blend',whale!==lightWhale
      &&await page.locator('.logo[data-logo=dsh]').first().evaluate(image=>getComputedStyle(image).filter==='none'&&getComputedStyle(image).mixBlendMode==='normal'));
    for(const width of [840,660,600,510,390,320]){
      await page.evaluate(width=>window.__dsgChatFixture.width(width),width);
      check(`${dark?'dark':'light'} ${width}px: no clipping`,await fits());
      check(`${dark?'dark':'light'} ${width}px: no vertical reflow`,await horizontal());
    }
    for(const scene of ['fallback','rotation','batch','long','kernel-batch','kernel-last']){
      await show(scene);
      await page.waitForFunction(()=>document.querySelector('.search-card'));
      for(const width of [660,320]){
        await page.evaluate(width=>window.__dsgChatFixture.width(width),width);
        check(`${dark?'dark':'light'} ${scene} ${width}px: stable layout`,await fits());
        check(`${dark?'dark':'light'} ${scene} ${width}px: horizontal`,await horizontal());
      }
    }
    await show('lastsuccess');
    await page.waitForFunction(()=>document.querySelector('.search-card'));
    await page.evaluate(()=>window.__dsgChatFixture.width(840));
    await page.waitForFunction(()=>document.querySelector('.fold-inner').getAnimations().length===0);
    await page.screenshot({path:`artifacts/chat-card-browser/five-${dark?'dark':'light'}.png`});
    await page.setViewportSize({width:390,height:844});
    check(`${dark?'dark':'light'} mobile: no clipping`,await fits());
    check(`${dark?'dark':'light'} narrow route scroll reaches final supplier`,await page.locator('.flow-scroll').first().evaluate(region=>{
      const before=region.scrollLeft;region.scrollLeft=region.scrollWidth;
      const box=region.getBoundingClientRect(),last=region.querySelector('.provider-steps>.route-node:last-child').getBoundingClientRect();
      const passed=region.scrollLeft>before&&last.right<=box.right+1;
      region.scrollLeft=0;return passed;
    }));
    await page.locator('.flow-scroll').first().focus();await page.keyboard.press('ArrowRight');
    await page.waitForFunction(()=>document.querySelector('.flow-scroll').scrollLeft>0);
    check(`${dark?'dark':'light'} route scroll supports keyboard`,true);
    await page.locator('.flow-scroll').first().evaluate(element=>element.blur());
    await page.waitForFunction(()=>!document.querySelector('.flow-scroll').matches(':focus-visible'));
    await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
    await page.locator('.flow-scroll').first().evaluate(element=>{element.scrollLeft=0;});
    await page.waitForFunction(()=>document.querySelector('.flow-scroll').scrollLeft===0);
    await page.waitForFunction(()=>document.querySelector('.fold-inner').getAnimations().length===0);
    await page.screenshot({path:`artifacts/chat-card-browser/mobile-${dark?'dark':'light'}.png`});
    await page.setViewportSize({width:1440,height:900});
  }
  await page.evaluate(()=>{window.__dsgChatFixture.dark(false);document.documentElement.style.zoom='2';});
  check('200% zoom: no clipped content',await fits());
  check('200% zoom: route remains horizontal',await horizontal());
  await page.locator('.search-card').screenshot({path:'artifacts/chat-card-browser/zoom-card.png'});
  await page.evaluate(()=>document.documentElement.style.zoom='');
  await show('planned-fallback');
  await page.waitForFunction(()=>document.querySelector('.search-card'));
  const stable=await page.evaluate(async()=>{
    await window.__dsgChatFixture.stream({ticks:3,cards:1});
    const before=window.__dsgChatFixture.stats();
    await window.__dsgChatFixture.stream({ticks:90,cards:1,clone:true});
    const after=window.__dsgChatFixture.stats();
    return {renders:after.cardRenders-before.cardRenders,reads:after.reads-before.reads};
  });
  check('unchanged tool card does not rerender for parent streaming',stable.renders===0);
  check('completed streaming card does not resume polling',stable.reads===0);
  await page.evaluate(()=>window.__dsgChatFixture.updateResult());
  await page.waitForFunction(()=>document.querySelector('.source-title')?.textContent==='更新后的来源');
  check('memoization preserves real result updates',await page.locator('.card-body').textContent().then(text=>text.includes('更新后的摘要')&&text.includes('部分搜索结果已截断')));
  await page.waitForFunction(()=>document.querySelector('.fold-inner').getAnimations().length===0);
  const invalidatedAt=await page.evaluate(()=>{
    const reads=window.__dsgChatFixture.stats().reads;
    window.__dsgChatFixture.invalidateTrace();
    document.querySelector('[data-chat-fixture]').firstElementChild.style.transform='translateY(200vh)';
    return reads;
  });
  await page.waitForFunction(()=>document.querySelector('.dsg-chat').dataset.visible==='false');
  await page.evaluate(()=>document.querySelector('[data-chat-fixture]').firstElementChild.style.transform='');
  await page.waitForFunction(()=>document.querySelector('.dsg-tool-attribution')?.textContent==='本次来源未记录');
  check('a remade visible card revalidates cleared evidence',await page.evaluate(reads=>window.__dsgChatFixture.stats().reads>reads,invalidatedAt));
  check('cleared attribution preserves the host original result',await page.locator('[data-native-result]').count()===1);
  await show('publication-race');
  await page.waitForFunction(()=>document.querySelector('.header-right .state')?.textContent==='正在确认结果');
  check('host result cannot prematurely show green success',await page.locator('.header-right .state').getAttribute('data-state')==='running');
  await page.evaluate(()=>window.__dsgChatFixture.settleRace('cancelled'));
  await page.waitForFunction(()=>document.querySelector('.header-right .state')?.textContent==='已取消');
  check('late attribution cancellation stays cancelled',await page.locator('.header-right .state').getAttribute('data-state')==='cancelled');
  await page.evaluate(()=>window.__dsgChatFixture.start());
  await page.waitForFunction(()=>document.querySelector('.provider-steps [data-result=running]'));
  check('live searching retains visible glow paths',await page.evaluate(()=>
    [...document.querySelectorAll('.edge.active .wire-flow')].length>0
    &&[...document.querySelectorAll('.edge.active .wire-flow')].every(path=>getComputedStyle(path).display!=='none')));
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForFunction(()=>document.querySelector('.dsg-chat').dataset.motion==='reduce');
  check('reduced motion disables glow, not semantics',await page.locator('.provider-steps [data-result=running]')
    .evaluate(element=>getComputedStyle(element,'::after').animationName==='none'));
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.locator('.card-toggle').click();
  check('folded body pauses glow',await page.locator('.provider-steps [data-result=running]')
    .evaluate(element=>getComputedStyle(element,'::after').animationPlayState==='paused'));
  await page.evaluate(()=>document.querySelector('[data-chat-fixture]').firstElementChild.style.transform='translateY(200vh)');
  await page.waitForFunction(()=>document.querySelector('.dsg-chat').dataset.visible==='false');
  const hidden=await page.evaluate(()=>window.__dsgChatFixture.stats().reads);
  await page.evaluate(()=>new Promise(done=>setTimeout(done,950)));
  check('hidden card does not poll',await page.evaluate(()=>window.__dsgChatFixture.stats().reads)===hidden);
  await page.evaluate(()=>window.__dsgChatFixture.dispose());
  const unmounted=await page.evaluate(()=>window.__dsgChatFixture.stats().reads);
  await page.evaluate(()=>new Promise(done=>setTimeout(done,950)));
  check('unmounted card releases polling',await page.evaluate(()=>window.__dsgChatFixture.stats().reads)===unmounted);
  check('no browser errors',errors.length===0);
  check('no external requests',external.length===0);
  return {checks:checks.length,passed:checks.filter(row=>row.passed).length,failed:0,errors,external,
    longTasks:await page.evaluate(()=>window.__chatLongTasks)};
}
