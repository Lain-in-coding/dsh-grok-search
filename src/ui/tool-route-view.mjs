/** The approved compact card; host blocks own text/results, the RPC owns attribution only. */
export function createToolRouteView({ React, jsx, remote, Original, logos = {}, theme = null }) {
  const names = { grok: 'Grok', 'grok-sources': '来源未报告', tavily: 'Tavily', exa: 'Exa',
    tinyfish: 'TinyFish', firecrawl: 'Firecrawl', github: 'GitHub API' };
  const describe = (result, phase, isError) => {
    if (!result?.known || !Array.isArray(result.routes) || result.routes.length === 0) {
      return { known: false, tone: 'unknown',
        text: phase === 'preparing' ? '等待搜索调用' : phase === 'start' ? '正在确认搜索通道…' : '本次来源未记录' };
    }
    const sources = [...new Set(result.routes.flatMap(route => Array.isArray(route.resultProviders)
      ? [...route.resultProviders.filter(provider => Object.hasOwn(names, provider) && provider !== 'grok-sources').map(provider => names[provider]),
        ...(route.resultProvidersComplete === true && route.resultProviders.length ? [] : ['来源未报告'])]
      : Object.hasOwn(names, route.served) ? [names[route.served]] : []))];
    const cancelled = result.state === 'cancelled';
    const failed = !cancelled && (isError || result.state === 'failed');
    const running = phase !== 'result' || result.state === 'running';
    const fallback = result.routes.some(route => route.fallbackUsed === true);
    const status = cancelled ? '已取消' : failed ? '搜索失败' : running ? '正在搜索'
      : fallback ? '已回退' : '';
    // A capped call lists only its recorded routes; never present them as every source.
    const text = ['由 dsh-grok-search 执行', sources.join(' / ') || (running ? '等待来源返回' : '来源未报告'),
      result.routesComplete === false ? '其余来源未记录' : '', status]
      .filter(Boolean).join(' · ');
    return { known: true, tone: failed ? 'error' : cancelled ? 'cancelled' : running ? 'running' : 'ok', text };
  };
  const known = value => value?.known === true && Array.isArray(value.routes) && value.routes.length > 0;
  const validIdentity = (value,limit) => typeof value === 'string' && value.length > 0
    && value.length <= limit && !/[\s\u0000-\u001f]/.test(value);
  // One request at a time, no overlapping polling after hiding or phase changes.
  // Results are compared before delivery; no timer increments search elapsed time.
  function watch({ sessionId, callId, phase, onChange }) {
    let active = true, visible = true, timer = null, deadline = null, inFlight = false, attempts = 0, last = '', legacy = false, buffered = null;
    let currentPhase = phase, settled = false;
    const readable = validIdentity(sessionId,128) && validIdentity(callId,512);
    const emit = value => {
      if (!visible) { buffered=value; return; }
      const signature = JSON.stringify(value);
      if (last !== signature) { last = signature; onChange(value); }
    };
    const queue = () => { clearTimeout(timer); timer = null; if (active && visible && !settled) timer = setTimeout(poll, 750); };
    async function poll() {
      if (!active || !visible || inFlight || !readable || currentPhase === 'preparing' || settled) return;
      inFlight = true;
      let timedOut = false;
      deadline = setTimeout(() => {
        deadline = null; timedOut = true; settled = true;
        if (active) emit({ result: null, unreadable: true, code: 'SETTINGS_READ_TIMEOUT' });
        // The underlying read is not cancelled by a UI timeout. Keep its slot
        // occupied until it actually settles; never pile up replacement RPCs.
      }, 4000);
      try {
        let result;
        try {
          result = !legacy && typeof remote.toolCallTrace === 'function'
            ? await remote.toolCallTrace({ sessionId, callId }) : await remote.toolCallRoute({ sessionId, callId });
        } catch (error) {
          if (!active || timedOut) return;
          if (!legacy && /(?:METHOD_NOT_FOUND|method.not.found|method_not_found)/i.test(error?.code ?? '')) {
            legacy = true;
            result = await remote.toolCallRoute({ sessionId, callId });
          } else throw error;
        }
        if (!active || timedOut) return;
        const incomplete = !known(result) || result.state === 'running';
        const retry = incomplete && (currentPhase === 'start' || ++attempts < 3);
        settled = !retry;
        // The host result and the attribution hook are published separately.
        // A terminal host must not keep a stale running snapshot forever.
        emit(settled && known(result) && result.state === 'running'
          ? { result:null, unreadable:true, code:'TOOL_ROUTE_PENDING' }
          : { result, reading: !known(result) && currentPhase === 'result' && retry });
      } catch (error) {
        if (!active || timedOut) return;
        const code = /^[\w./-]{1,80}$/.test(error?.code || '') ? error.code : 'SETTINGS_UNAVAILABLE';
        settled = ++attempts >= 3;
        emit({ result: null, unreadable: true, code });
      } finally {
        clearTimeout(deadline); deadline = null;
        inFlight = false;
        queue();
      }
    }
    return {
      update(next) {
        const resumed=!visible&&next.visible!==false;
        if (next.phase !== currentPhase) { currentPhase = next.phase; settled = false; attempts = 0; }
        // A completed card does not poll continuously, but after being hidden
        // its in-memory evidence may have been cleared or evicted.
        if (resumed && settled) { settled=false;attempts=0; }
        visible = next.visible !== false;
        clearTimeout(timer); timer = null;
        if (visible && buffered) { const value=buffered;buffered=null;emit(value); }
        if (visible) void poll();
      },
      dispose() { active = false; clearTimeout(timer); clearTimeout(deadline); timer = null; deadline = null; buffered=null; },
    };
  }
  const finiteMs = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const duration = value => finiteMs(value) === null ? '—' : `${(value / 1000).toFixed(1)} 秒`;
  const errorText = code => {
    if (/401|grok_auth_error/.test(code)) return '鉴权失败';
    if (/403/.test(code)) return '访问受限';
    if (/429|rate.limit/i.test(code)) return '请求限流';
    if (/TIMEOUT|timeout/.test(code)) return '响应超时';
    if (/50[234]/.test(code)) return '服务不可用';
    if (/EMPTY|empty|NO_RESULTS/.test(code)) return '未返回结果';
    if (/NETWORK|CONNECT|network/.test(code)) return '连接失败';
    if (/BUDGET|OUTPUT_LIMIT/.test(code)) return '达到调用上限';
    return '调用失败';
  };
  const safeUrl = value => {
    if (typeof value !== 'string') return null;
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
    catch { return null; }
  };
  function model(result, props) {
    const phase = props.phase, block = props.block ?? {};
    let args = {};
    try { args = JSON.parse((phase === 'result' ? block.call?.argsRaw : block.argsRaw) ?? '{}'); } catch { /* Keep raw parameters in the native inspector. */ }
    const queries = Array.isArray(args?.queries) ? [...new Set(args.queries.filter(value => typeof value === 'string'))] : [];
    const state = result?.state === 'cancelled' ? 'cancelled'
      : block.isError || result?.state === 'failed' ? 'failed'
        : phase !== 'result' || result?.state === 'running' ? 'running' : 'done';
    const routes = (result?.routes ?? []).slice(0,16).map((route, index) => {
      const counts = new Map();
      const calls = (Array.isArray(route.calls) ? route.calls : []).slice(0,16)
        .filter(call => Object.hasOwn(names, call.provider) && call.provider !== 'grok-sources').map(call => {
          const occurrence = counts.get(call.provider) ?? 0; counts.set(call.provider,occurrence+1);
          return {
          ...call, id: `${call.provider}-${occurrence}`, elapsedMs: finiteMs(call.elapsedMs),
          result: state !== 'running' && call.result === 'running' ? 'unknown'
            : ['ok','failed','cancelled','running'].includes(call.result) ? call.result : 'unknown',
          code: /^[\w.-]{1,64}$/.test(call.code ?? '') ? call.code : '',
          keyIndex: Number.isSafeInteger(call.keyIndex) && call.keyIndex >= 0 && call.keyIndex < 100 ? call.keyIndex : null,
        }; });
      if (!calls.length && route.outcome !== 'running') {
        const providers = Array.isArray(route.resultProviders) ? route.resultProviders
          : route.served && route.served !== 'grok-sources' ? [route.served] : [];
        for (const provider of providers.filter(id => Object.hasOwn(names,id))) calls.push({
          id: `evidence-${provider}`, provider, result: route.outcome === 'ok' ? 'ok' : 'unknown',
          evidence:'source-label', elapsedMs:null, keyIndex:null, code:'',
        });
      }
      const planned = Array.isArray(route.planned) ? [...new Set(route.planned.filter(provider=>Object.hasOwn(names,provider)&&provider!=='grok-sources'))].slice(0,5) : [];
      if(state==='running'&&route.outcome==='running')for(const provider of planned)if(!counts.has(provider)){
        calls.push({id:`${provider}-0`,provider,result:'pending',evidence:'planned',elapsedMs:null,keyIndex:null,code:''});
      }
      return { ...route, index, query: queries[index] ?? `查询 ${index + 1}`, calls,
        partial: calls.some(call => call.evidence === 'source-label' || call.evidence === 'kernel-summary')
          || route.callsTruncated === true || !Array.isArray(route.calls) || phase==='result'&&route.outcome==='running' };
    });
    const sources = Array.isArray(block.meta?.sources) ? block.meta.sources.map(source => {
      const url = safeUrl(source?.url);
      return url ? { url, title: typeof source.title === 'string' && source.title ? source.title : new URL(url).hostname,
        domain: new URL(url).hostname, snippet: typeof source.snippet === 'string' ? source.snippet : '',
        publishedAt: typeof source.publishedAt === 'string' ? source.publishedAt : '' } : null;
    }).filter(Boolean) : [];
    const fallback = routes.some(route => route.fallbackUsed);
    const label = state === 'cancelled' ? '已取消' : state === 'failed' ? '搜索失败'
      : state === 'running' ? phase==='result' ? '正在确认结果' : result?.state === 'done' ? '正在整理结果' : routes.some(route=>route.calls.some(call=>call.result==='failed')) ? '正在切换来源' : '搜索中'
        : fallback ? '已回退' : '已完成';
    return { state, label, routes, sources, queries,
      query: queries.length > 1 ? `${queries.length} 个查询` : queries[0] ?? '网页搜索',
      elapsedMs: finiteMs(result?.elapsedMs), truncated: block.meta?.truncated === true,
      answer: typeof block.meta?.answer === 'string' ? block.meta.answer : '',
      output: Array.isArray(block.content) ? block.content.filter(row=>row?.type==='text'&&typeof row.text==='string').map(row=>row.text).join('\n') : '',
      complete: result?.routesComplete !== false,
    };
  }
  // Host stream snapshots may recreate the block and its arrays on every token.
  // Compare only the fields this card consumes; never stringify full tool output.
  const sameRows = (left, right, fields) => left === right || Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((row,index) => row === right[index]
      || fields.every(field => row?.[field] === right[index]?.[field]));
  function sameBlock(left, right) {
    left??={};right??={};
    return left === right || left.argsRaw === right.argsRaw && left.call?.argsRaw === right.call?.argsRaw
      && left.isError === right.isError && left.meta?.answer === right.meta?.answer
      && left.meta?.truncated === right.meta?.truncated
      && sameRows(left.meta?.sources,right.meta?.sources,['url','title','snippet','publishedAt'])
      && sameRows(left.content,right.content,['type','text']);
  }
  const paths = {
    route:'M7.3 12h3.2m0 0c2.6 0 2.4-6.5 6.5-6.5M10.5 12h6.5M10.5 12c2.6 0 2.4 6.5 6.5 6.5',
    check:'m7 12 3 3 7-7', alert:'M12 7v6m0 4h.01', clock:'M12 7v5l3 2',
    cancel:'m8 8 8 8m0-8-8 8', chevron:'m9 5 7 7-7 7', code:'m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
    external:'M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5',
  };
  function icon(name, extra = '') {
    const children = name === 'spinner' ? [jsx('path',{d:'M20 12a8 8 0 1 1-8-8'},'path')]
      : name === 'route' ? [jsx('path',{d:paths.route},'path'),...[[5,12,2.3],[19,5.5,2],[19,12,2],[19,18.5,2]].map((p,i)=>jsx('circle',{cx:p[0],cy:p[1],r:p[2]},String(i)))]
        : [jsx('path',{d:paths[name] ?? paths.alert},'path'),
          ...(['check','alert','clock','cancel'].includes(name)?[jsx('circle',{cx:12,cy:12,r:9},'circle')]:[])];
    return jsx('svg',{className:`icon ${name==='spinner'?'spinner':''} ${extra}`,viewBox:'0 0 24 24','aria-hidden':true,children});
  }
  const stateIcon = state => state === 'running' ? 'spinner' : state === 'failed' ? 'alert' : state === 'cancelled' ? 'cancel' : ['unknown','pending'].includes(state) ? 'clock' : 'check';
  function Logo({ id, dark }) {
    if(id==='hub')return icon('route');
    const key = id === 'dsh' ? dark ? 'harnessChatDark' : 'harnessChat'
      : dark && ['tavily','exa','github'].includes(id) ? `${id}Dark` : id;
    return logos[key] ? jsx('img',{className:'logo','data-logo':id,src:logos[key],alt:'','aria-hidden':true,draggable:false}) : null;
  }
  function Edge({ id, state, recovery = false, extra = '' }) {
    return jsx('span',{className:`edge ${state==='active'?'active':''} ${extra}`,'data-edge':id,'data-wire':state,
      'data-tone':recovery?'back':'flow','aria-hidden':true,children:jsx('svg',{
        className:'wire-svg wire-horizontal',viewBox:'0 0 26 12',preserveAspectRatio:'none',children:[
          jsx('path',{className:'wire-track',d:'M3 6H22'},'track'),
          jsx('path',{className:'wire-head',d:'m18.5 2.5 3.5 3.5-3.5 3.5'},'head'),
          ...['wire-halo','','wire-tip'].map((name,i)=>jsx('path',{className:`wire-flow ${name}`,pathLength:100,d:'M3 6H22'},String(i))),
        ]})});
  }
  function Node({ id, name, result, note, code, dark, recovery, evidence, animate, ingressActive = false }) {
    const ref=React.useRef(null), previous=React.useRef(null);
    React.useEffect(()=>{
      const before=previous.current;previous.current=result;
      const feedback=!animate?'':before===null&&ingressActive||result==='running'&&before!==result?'receive'
        :before!==null&&before!==result&&result==='failed'?'failed'
          :before!==null&&before!==result&&result==='ok'&&!['dsh','hub'].includes(id)?'success':'';
      if(ref.current){if(feedback)ref.current.dataset.feedback=feedback;else if(before!==result||!animate||['dsh','hub'].includes(id)&&!ingressActive)delete ref.current.dataset.feedback;}
    },[result,animate,ingressActive]);
    return jsx('div',{ref,className:`route-node ${evidence?'source-evidence':''}`,'data-result':result,'data-recovery':String(Boolean(recovery)),
      style:id==='hub'&&ingressActive?{'--arrival-delay':'620ms'}:undefined,
      title:code||undefined,children:[
        jsx('div',{className:'route-name',children:[jsx(Logo,{id,dark},'logo'),jsx('span',{children:name},'name')]},'name'),
        jsx('div',{className:'route-note',children:[...(!['dsh','hub'].includes(id)?[icon(stateIcon(result))]:[]),jsx('span',{children:note},'note')]},'note'),
      ]});
  }
  function Flow({ route, state, dark, animate }) {
    const calls=route.calls, active=state==='running';
    const follows=index=>calls.slice(0,index).some(call=>call.result==='failed');
    const wireState=(call,index)=>!call||call.result==='pending'?'pending':call.evidence==='source-label'?follows(index)?'recovered':'passed':call.result==='running'?'active'
      :call.result==='failed'?'dead':call.result==='ok'?follows(index)?'recovered':'passed':'idle';
    const children=[
      jsx('div',{className:'ingress',children:[
        jsx(Node,{id:'dsh',name:'DSH',result:'ok',note:'发起搜索',dark,animate,ingressActive:active},'dsh'),
        jsx(Edge,{id:'dsh-hub',state:active?'active':'passed'},'dsh-hub'),
        jsx(Node,{id:'hub',name:'Grok Search Rs',result:route.phase==='queued'?'running':'ok',
          note:route.phase==='queued'?'等待执行':'执行搜索路由',dark,animate,ingressActive:active},'hub'),
      ]},'ingress'),
      ...(calls.length?[jsx(Edge,{id:'hub-source',state:wireState(calls[0],0),
        extra:`bridge${calls[0].evidence==='source-label'?' source-link':''}`},'bridge')]:[]),
      jsx('div',{className:'provider-steps',children:calls.flatMap((call,index)=>{
        const repeated=calls.filter(row=>row.provider===call.provider&&row.result!=='pending').length>1;
        const key=call.keyIndex===null||!repeated&&call.keyIndex===0?'':` · Key ${call.keyIndex+1}`;
        const text=call.evidence==='source-label'?'结果来源':call.result==='pending'?'待命':call.result==='running'?'搜索中'
          :call.result==='ok'?'返回结果':call.result==='cancelled'?'已取消':call.result==='unknown'?'状态未报告':errorText(call.code);
        const note=[text,call.elapsedMs===null?'':duration(call.elapsedMs)].filter(Boolean).join(' · ');
        return [
          // A source label establishes attribution, not an observed dispatch.
          // Keep its connector visible and static without inventing transit time.
          ...(index?[jsx(Edge,{id:`source-${index}`,state:wireState(call,index),recovery:follows(index),
            extra:call.evidence==='source-label'?'source-link':''},`edge-${call.id}`)]:[]),
          jsx(Node,{id:call.provider,name:names[call.provider]+key,result:call.result,note,
            code:call.code,dark,recovery:follows(index),evidence:call.evidence==='source-label',animate},call.id),
        ];
      })},'providers'),
    ];
    return jsx('div',{className:'flow-scroll',role:'region',tabIndex:0,
      'aria-label':`查询 ${route.index+1} 的搜索执行链路，可横向滚动`,
      children:jsx('div',{className:'flow','data-terminal':state,children})});
  }
  const fallbackDisclosure = () => {
    const [expanded,setExpanded]=React.useState(true);
    return { expanded,toggle:()=>setExpanded(value=>!value) };
  };
  const fallbackMenu = () => ({ getTriggerProps:()=>({}) });
  function Card({ value, host, dark, visible, reduce }) {
    const disclosure=(host.useDisclosure ?? fallbackDisclosure)();
    const {getTriggerProps}=(host.useContextMenu ?? fallbackMenu)();
    const open=disclosure.expanded, body=React.useRef(null);
    const previousState=React.useRef(value.state);
    const animate=visible&&open&&!reduce;
    // Observe intrinsic content once, not its animated container. Host token
    // updates must not force layout or restart an unchanged size transition.
    React.useEffect(()=>{
      const element=body.current;
      if(!element||!animate)return;
      const container=element.parentElement;
      let previousHeight=null,previousWidth=null,motion=null,frame=null,from=0,to=0,active=true;
      const observer=new ResizeObserver(entries=>{
        const box=entries[0]?.borderBoxSize?.[0],height=box?.blockSize,width=box?.inlineSize;
        if(!active||!Number.isFinite(height))return;
        const before=previousHeight,resized=previousWidth!==null&&Math.abs(previousWidth-width)>1;
        previousHeight=height;previousWidth=width;
        // Window resizing is continuous user input: let the host settle at the
        // new width immediately, without a second animated height competing.
        if(resized){cancelAnimationFrame(frame);frame=null;motion?.cancel();motion=null;return;}
        if(before===null||Math.abs(before-height)<1)return;
        cancelAnimationFrame(frame);
        frame=requestAnimationFrame(()=>{
          frame=null;
          if(!active)return;
          const progress=motion?.effect?.getComputedTiming().progress;
          const current=typeof progress==='number'?from+(to-from)*progress:before;
          motion?.cancel();from=current;to=height;
          const playback=container.animate([{height:`${from}px`},{height:`${to}px`}],
            {duration:240,easing:'cubic-bezier(.2,.75,.25,1)'});
          motion=playback;
          playback.onfinish=()=>{if(motion===playback)motion=null;};
        });
      });
      observer.observe(element,{box:'border-box'});
      return ()=>{active=false;observer.disconnect();cancelAnimationFrame(frame);motion?.cancel();};
    },[animate]);
    React.useEffect(()=>{
      const settled=previousState.current==='running'&&value.state==='done';
      previousState.current=value.state;
      const results=body.current?.querySelector('.results');
      if(!animate)return;
      if(settled&&results)results.dataset.feedback='success';
      return ()=>{if(results)delete results.dataset.feedback;};
    },[value.state,animate]);
    const label=jsx('span',{className:'state','data-state':value.state,role:'status','aria-live':'polite','aria-atomic':true,
      children:[icon(stateIcon(value.state)),jsx('span',{children:value.label},'label')]});
    const sourceNames=[...new Set(value.routes.filter(route=>route.outcome==='ok').flatMap(route=>{
      const providers=Array.isArray(route.resultProviders)?route.resultProviders:[route.served];
      return providers.filter(provider=>Object.hasOwn(names,provider)&&provider!=='grok-sources').map(provider=>names[provider]);
    }))];
    const cause=value.state==='cancelled'?'搜索已停止，未继续请求剩余来源。'
      :value.state==='failed'?'本次搜索未返回可用结果，未回退到官方搜索。'
        :value.routes.some(route=>route.fallbackUsed)&&value.state==='done'?`已静默回退${sourceNames.length?`，结果由 ${sourceNames.join('、')} 提供`:''}。`:'';
    const results=jsx('div',{className:'results',children:[
      jsx('div',{className:'results-heading',children:[jsx('span',{children:'搜索结果'},'title'),
        jsx('span',{className:'results-count',children:value.sources.length?`${value.sources.length} 个引用来源`:''},'count')]},'head'),
      value.answer?jsx('details',{className:'answer-summary',children:[jsx('summary',{children:'搜索摘要'},'title'),jsx('div',{children:value.answer},'content')]},'answer'):null,
      value.state==='running'?jsx('p',{className:'outcome-note',children:'正在等待来源返回结果…'},'waiting')
        :value.sources.length?jsx('div',{className:'source-list',children:value.sources.map((source,index)=>jsx('div',{children:[
          jsx('a',{className:'source-row',href:source.url,target:'_blank',rel:'noopener noreferrer',
            ...getTriggerProps({kind:'url',value:{sessionId:host.sessionId,url:source.url}}),children:[
              jsx('span',{className:'source-num',children:String(index+1)},'number'),
              jsx('span',{className:'source-copy',children:[jsx('span',{className:'source-title',children:source.title},'title'),
                jsx('span',{className:'source-domain',children:source.domain},'domain')]},'copy'),icon('external'),
            ]},'link'),
          source.snippet||source.publishedAt?jsx('details',{className:'source-extra',children:[
            jsx('summary',{children:source.publishedAt||'来源摘要'},'title'),jsx('div',{children:source.snippet},'content'),
          ]},'excerpt'):null,
        ]},`${source.url}-${index}`))},'list')
          :jsx('p',{className:'outcome-note',children:value.state==='cancelled'?'本次未返回搜索结果。':value.output||'本次没有可展示的搜索结果。'},'empty'),
      value.truncated?jsx('p',{className:'outcome-note',children:'部分搜索结果已截断，可缩小查询范围继续搜索。'},'truncated'):null,
    ]});
    return jsx('article',{className:'search-card','data-open':String(open),children:[
      jsx('div',{className:'card-header',children:[
        jsx('button',{className:'card-toggle',type:'button','aria-expanded':open,onClick:disclosure.toggle,children:[
          jsx('span',{className:'plugin-mark',children:icon('route')},'mark'),
          jsx('span',{className:'card-name',children:'dsh-grok-search'},'name'),
          jsx('span',{className:'title-dot',children:'·'},'dot'),jsx('span',{className:'tool-type',children:'网页搜索'},'type'),
          jsx('span',{className:'query-summary',title:value.queries.join('\n'),children:value.query},'query'),
          jsx('span',{className:'header-right',children:[label,jsx('span',{className:'elapsed',children:duration(value.elapsedMs)},'time'),icon('chevron','chevron')]},'right'),
        ]},'toggle'),
        typeof host.inspect==='function'?jsx('button',{className:'inspect-btn',type:'button','aria-label':'查看调用参数与原始结果',
          title:'查看调用参数与原始结果',onClick:host.inspect,children:icon('code')},'inspect'):null,
      ]},'header'),
      jsx('div',{className:'fold',inert:open?undefined:'',children:jsx('div',{className:'fold-inner',children:jsx('div',{className:'card-body',ref:body,children:[
        jsx('div',{className:'section-line',children:[jsx('span',{className:'section-caption',children:'执行过程'},'title'),
          jsx('span',{className:'wire-name',children:[icon('code'),'web_search']},'wire')]},'head'),
        jsx('div',{className:'batch-list',children:value.routes.map(route=>jsx('section',{className:'query-block',children:[
          value.routes.length>1||value.query.length>65?jsx('div',{className:'query-head',children:[
            jsx('span',{className:'query-number',children:String(route.index+1).padStart(2,'0')},'number'),
            jsx('span',{className:'query-text',children:route.query},'query'),
            jsx('span',{className:'state','data-state':route.outcome==='ok'?'done':route.outcome,
              children:[icon(stateIcon(route.outcome==='ok'?'done':route.outcome)),
                route.outcome==='running'?'搜索中':route.outcome==='failed'?'搜索失败':route.outcome==='cancelled'?'已取消':route.fallbackUsed?'已回退':'已完成']},'state'),
          ]},'query'):null,
          jsx(Flow,{route,state:value.state,dark,animate},'flow'),
        ]},String(route.index)))},'routes'),
        !value.complete?jsx('p',{className:'cause',children:[icon('alert'),'部分查询明细已超出记录上限。']},'omitted'):null,
        cause?jsx('p',{className:'cause',children:[icon('alert'),cause]},'cause'):null,
        results,
      ]})})},'fold'),
    ]});
  }
  const MemoCard=typeof React.memo==='function'?React.memo(Card):Card;
  function SearchToolWithRoute(props) {
    const { sessionId, callId, phase, block } = props;
    const identity = JSON.stringify([sessionId, callId]);
    // Only an identity that is actually polled may wait in the reading state.
    const readable = validIdentity(sessionId,128) && validIdentity(callId,512) && phase !== 'preparing';
    const [answer, setAnswer] = React.useState(null);
    const element=React.useRef(null), subscription=React.useRef(null), presentation=React.useRef(null);
    const inspectRef=React.useRef(props.inspect);inspectRef.current=props.inspect;
    const inspect=React.useCallback(()=>inspectRef.current?.(),[]);
    const host=React.useMemo(()=>({sessionId,useDisclosure:props.useDisclosure,useContextMenu:props.useContextMenu,
      inspect:typeof props.inspect==='function'?inspect:undefined}),
    [sessionId,props.useDisclosure,props.useContextMenu,typeof props.inspect,inspect]);
    const [visible,setVisible]=React.useState(false);
    const [dark,setDark]=React.useState(theme?.current ?? false), [reduce,setReduce]=React.useState(false);
    const latest=React.useRef({phase});latest.current={phase};
    React.useEffect(() => {
      let inView=true;
      const update=()=>setVisible(inView&&!document.hidden);
      const observer=new IntersectionObserver(entries=>{inView=entries[0].isIntersecting;update();});
      observer.observe(element.current);
      document.addEventListener('visibilitychange',update);
      const color=matchMedia('(prefers-color-scheme: dark)'), motion=matchMedia('(prefers-reduced-motion: reduce)');
      const updateTheme=()=>setDark(theme?.current ?? color.matches),updateMotion=()=>setReduce(motion.matches);
      theme?.listeners.add(updateTheme);color.addEventListener('change',updateTheme);motion.addEventListener('change',updateMotion);
      updateTheme();updateMotion();
      return ()=>{observer.disconnect();document.removeEventListener('visibilitychange',update);
        theme?.listeners.delete(updateTheme);color.removeEventListener('change',updateTheme);motion.removeEventListener('change',updateMotion);};
    },[]);
    React.useEffect(()=>{
      const current=watch({sessionId,callId,phase:latest.current.phase,
        // Keep the subscription's identity immutable even between a new render
        // and its passive-effect cleanup; a late old reply cannot label a new call.
        onChange:value=>setAnswer({identity,...value})});
      subscription.current=current;
      return ()=>{current.dispose();subscription.current=null;};
    },[remote,sessionId,callId]);
    React.useEffect(()=>{subscription.current?.update({phase,visible});},[phase,visible,sessionId,callId]);
    const matched = answer?.identity === identity;
    const label = readable && (!matched || answer.reading)
      ? { known: false, tone: 'unknown', text: '正在读取本次来源…' }
      : matched && answer.unreadable
        ? { known: false, tone: 'unknown', text: `本次来源暂不可读 · ${answer.code}` }
        : describe(matched ? answer.result : null, phase, block?.isError);
    let value=null;
    if(readable&&matched&&known(answer.result)){
      const before=presentation.current;
      if(!before||before.result!==answer.result||before.phase!==phase||!sameBlock(before.block,block)){
        presentation.current={result:answer.result,phase,block,value:model(answer.result,props)};
      }
      value=presentation.current.value;
    }else presentation.current=null;
    return jsx('div', { ref:element,className:'dsg-chat','data-theme':dark?'dark':'light','data-visible':String(visible),
      'data-motion':reduce?'reduce':'full','data-dsg-search-card':callId,children:value?[
        jsx(MemoCard,{value,host,dark,visible,reduce},'card'),
      ]:[
        jsx(Original, props, 'original'),
        jsx('span', { className: 'dsg-tool-attribution', 'data-tone': label.tone,
        'data-known': String(label.known), role: phase === 'start' ? 'status' : undefined,
        'aria-atomic': phase === 'start' ? 'true' : undefined, children: label.text }, 'attribution'),
      ] });
  }
  return Object.freeze({ Component: SearchToolWithRoute, describe, model, watch });
}
