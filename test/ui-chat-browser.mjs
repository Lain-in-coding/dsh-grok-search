/**
 * Synthetic visual states, rendered by the generated candidate factory and
 * React 18.3.1 (the checked host version). No upstream or settings requests.
 * Invoked only by the isolated browser verifier; not shipped in the package.
 */
export async function mountChatCardFixture(logos) {
  const loader = window.__dsgTestRuntime;
  const React = await loader.import('react');
  const { jsx } = await loader.import('react/jsx-runtime');
  const { createRoot } = await loader.import('react-dom/client');
  const client = await loader.import('dsh-grok-search');
  const panel = document.createElement('div');
  panel.dataset.chatFixture = '1';
  Object.assign(panel.style, { position:'fixed',inset:'0',zIndex:'2147483000',overflow:'auto',padding:'32px 16px',background:'#f8f9fc' });
  const target = document.createElement('div');
  Object.assign(target.style,{maxWidth:'840px',margin:'0 auto',fontFamily:'"Segoe UI","Microsoft YaHei",sans-serif'});
  panel.appendChild(target);document.body.appendChild(panel);
  const theme = {current:false,listeners:new Set()};
  const names = ['grok','tavily','exa','tinyfish','firecrawl'];
  const call = (provider,result='ok',extra={}) => ({provider,result,code:result==='failed'?'HTTP_401':'',
    evidence:'dispatch',at:1000,elapsedMs:result==='running'?null:120,keyIndex:provider==='tavily'?0:null,operation:'search',...extra});
  const route = (calls,extra={}) => ({served:calls.findLast(row=>row.result==='ok')?.provider??null,
    outcome:'ok',fallbackUsed:calls.some(row=>row.result==='failed'),code:'',index:0,phase:'done',
    at:1000,elapsedMs:1500,planned:names,callsComplete:true,callsTruncated:false,calls,...extra});
  const urls = [
    {url:'https://example.test/weather',title:'秦皇岛天气预报与气象信息'},
    {url:'https://example.test/wind',title:'沿海风力与海洋天气预报'},
    {url:'https://example.test/travel',title:'秦皇岛旅游与公共出行信息'},
  ];
  let serial=0,reads=0,inspected=0,cardRenders=0,redraw,fail=false,phase='result',trace,queries=['秦皇岛今天天气 海边风力 出行建议'];
  let sources=urls,extraMeta={},key='fixture-0',cardCount=1,streamTick=0;
  const original = () => jsx('div',{'data-native-result':true,children:'原始搜索结果保留'});
  const view = client.__test.toolRouteView({React,jsx,logos,theme,Original:original,remote:{
    async toolCallTrace() {
      reads++;
      if(fail)throw Object.assign(new Error('fixture transport unavailable'),{code:'SETTINGS_UNAVAILABLE'});
      return structuredClone(trace);
    },
  }});
  function useDisclosure() {
    cardRenders++;
    const [expanded,setExpanded]=React.useState(true);
    return {expanded,toggle:()=>setExpanded(value=>!value)};
  }
  const useContextMenu=()=>({getTriggerProps:()=>({'data-url-menu':'preserved'})});
  function Host() {
    const [,setTick]=React.useState(0);redraw=()=>setTick(value=>value+1);
    const argsRaw=JSON.stringify({queries});
    const block=phase==='result'?{kind:'tool-result',callId:key,call:{name:'web_search',argsRaw},
      isError:trace?.state==='failed'||trace?.state==='cancelled',content:[],
      meta:{sources,truncated:false,...extraMeta}}
      :{phase,callId:key,name:'web_search',argsRaw};
    return jsx(React.Fragment,{children:[
      ...Array.from({length:cardCount},(_,index)=>jsx(view.Component,{
        sessionId:'fixture-session',callId:cardCount===1?key:`${key}-${index}`,toolName:'web_search',phase,block,useDisclosure,
        inspect:()=>{inspected++;},useContextMenu,
      },`${key}-${index}`)),
      jsx('p',{'data-stream-output':true,children:'正在逐步整理搜索结果。'.repeat(streamTick%40+1)},'stream'),
    ]});
  }
  const root=createRoot(target);
  const render=()=>redraw?redraw():root.render(jsx(Host,{}));
  const show=name=>{
    serial++;key=`fixture-${serial}`;fail=false;phase='result';sources=urls;extraMeta={};
    queries=['秦皇岛今天天气 海边风力 出行建议'];
    let rows=[route([call('grok','failed',{code:'GROK_STAGE_TIMEOUT'}),call('tavily')],{planned:['grok','tavily']})];
    let state='done';
    if(name==='success')rows=[route([call('grok')],{planned:['grok']})];
    if(name==='direct')rows=[route([call('tavily')],{planned:['tavily']})];
    if(name==='rotation')rows=[route([call('tavily','failed'),call('tavily','ok',{keyIndex:1})],{planned:['tavily']})];
    if(['lastsuccess','allfail','long'].includes(name)){
      rows=[route(names.map((provider,index)=>call(provider,name==='allfail'||index<4?'failed':'ok',{code:index===0?'GROK_STAGE_TIMEOUT':index===2?'HTTP_429':index===3?'HTTP_503':index===4&&name!=='allfail'?'':'HTTP_401'})))];
      if(name==='allfail'){state='failed';rows[0].outcome='failed';sources=[];}
    }
    if(name==='long')queries=['跨来源核对沿海城市的天气、风力、降水、公共交通与出行提醒。'.repeat(12)];
    if(name==='cancelled'){state='cancelled';sources=[];rows=[route([call('grok','cancelled')],{outcome:'cancelled',planned:['grok']})];}
    if(name==='batch'){
      queries=['天气预报','海边风力','景区开放安排'];
      rows=[route([call('grok')]),route([call('grok','failed'),call('tavily')]),route([call('exa')])]
        .map((row,index)=>({...row,index}));
    }
    if(name==='partial')rows=[route([call('exa','ok',{evidence:'source-label',elapsedMs:null}),call('firecrawl','ok',{evidence:'source-label',elapsedMs:null})],{callsComplete:false})];
    if(name==='metadata'){extraMeta={answer:'保留宿主原始摘要',truncated:true};sources=[{...urls[0],snippet:'保留来源的正文摘要',publishedAt:'2026-11-10'}];}
    if(name==='planned-fallback')rows=[route([call('grok','failed',{evidence:'kernel-summary',elapsedMs:null}),
      call('tavily','ok',{evidence:'source-label',elapsedMs:null})],{callsComplete:false})];
    if(name==='source-only')rows=[route([call('tavily','ok',{evidence:'source-label',elapsedMs:null})],{callsComplete:false})];
    if(name==='kernel-batch'){
      queries=['秦皇岛天气 实时','秦皇岛天气预报 今天'];
      rows=queries.map((query,index)=>route([call('grok','failed',{evidence:'kernel-summary',elapsedMs:null}),
        call('tavily','ok',{evidence:'source-label',elapsedMs:null})],{index,callsComplete:false}));
    }
    if(name==='kernel-last')rows=[route(names.map((provider,index)=>call(provider,index<4?'failed':'ok',
      index<4?{}:{evidence:'source-label',elapsedMs:null})),{callsComplete:false})];
    if(name==='publication-race'){state='running';rows=[route([call('tavily','running')],{phase:'search',outcome:'running',planned:['tavily']})];}
    if(name==='expired'||name==='unreadable'){rows=[];state='unknown';fail=name==='unreadable';}
    trace={known:rows.length>0,state,toolName:'web_search',at:1000,elapsedMs:1500,routes:rows};
    render();
    return key;
  };
  const advance = index => {
    phase=index>=5?'result':'start';
    sources=index>=5?urls:[];
    const calls=names.slice(0,Math.min(index+1,5)).map((provider,i)=>call(provider,
      index>=5&&i===4?'ok':i===index?'running':'failed',{code:i<index?'HTTP_401':''}));
    trace={known:true,state:index>=5?'done':'running',toolName:'web_search',at:1000,elapsedMs:index>=5?6000:null,
      routes:[route(calls,{phase:index>=5?'done':'search',outcome:index>=5?'ok':'running',elapsedMs:index>=5?6000:null})]};
    render();
  };
  window.__dsgChatFixture={
    show,advance,
    start(){serial++;key=`fixture-${serial}`;fail=false;advance(0);},
    dark(value){theme.current=value;panel.style.background=value?'#161920':'#f8f9fc';theme.listeners.forEach(fn=>fn());},
    width(value){target.style.maxWidth=`${value}px`;},
    stats:()=>({reads,inspected,cardRenders}),
    updateResult(){sources=[{url:'https://example.test/new',title:'更新后的来源',snippet:'新增来源正文'}];
      extraMeta={answer:'更新后的摘要',truncated:true};queries=['更新后的查询'];render();},
    invalidateTrace(){trace={known:false,state:'unknown',routes:[]};},
    settleRace(state){trace={...trace,state,routes:[route([call('tavily',state)],{outcome:state})]};render();},
    async stream({ticks=180,cards=1,clone=true}={}){
      cardCount=cards;streamTick=0;render();
      await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
      for(let index=0;index<ticks;index++){
        await new Promise(done=>requestAnimationFrame(done));
        streamTick++;
        if(clone)sources=sources.map(source=>({...source}));
        render();
      }
      await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
      return {ticks:streamTick,cards:cardCount,reads};
    },
    async dispose(){root.unmount();panel.remove();await Promise.resolve();},
  };
  show('fallback');
  return {react:React.version,generatedProductionFactory:true};
}
