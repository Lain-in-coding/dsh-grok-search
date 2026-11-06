/** A small provenance ribbon beside the host's unchanged web_search result view. */
export function createToolRouteView({ React, jsx, remote, Original }) {
  const names = { grok: 'Grok', 'grok-sources': '来源未报告', tavily: 'Tavily', exa: 'Exa',
    tinyfish: 'TinyFish', firecrawl: 'Firecrawl' };
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
  const styles = `
    [data-dsg-search-card]{min-width:0;display:flex;flex-direction:column}
    [data-dsg-search-card] .dsg-tool-attribution{display:flex;align-items:center;gap:6px;min-height:22px;
      margin:1px 0 3px 20px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5;
      color:var(--dsw-alias-label-secondary,#545a66);overflow-wrap:anywhere}
    [data-dsg-search-card] .dsg-tool-attribution::before{content:"";width:5px;height:5px;border-radius:50%;
      flex:none;background:var(--dsw-alias-label-caption,#878d98)}
    [data-dsg-search-card] .dsg-tool-attribution[data-tone=ok]::before,
    [data-dsg-search-card] .dsg-tool-attribution[data-tone=running]::before{background:var(--dsw-alias-brand-primary,#4d6bfe)}
    [data-dsg-search-card] .dsg-tool-attribution[data-tone=error]{color:var(--dsw-alias-state-error-primary,#b32429)}
    [data-dsg-search-card] .dsg-tool-attribution[data-tone=error]::before{background:currentColor}
    [data-dsg-search-card] .dsg-tool-attribution[data-tone=cancelled]{color:var(--dsw-alias-state-warn-label,#8c5a00)}
  `;
  function SearchToolWithRoute(props) {
    const { sessionId, callId, phase, block } = props;
    const identity = JSON.stringify([sessionId, callId, phase, block?.isError === true]);
    // Only an identity that is actually polled may wait in the reading state.
    const readable = typeof sessionId === 'string' && typeof callId === 'string' && phase !== 'preparing';
    const [answer, setAnswer] = React.useState(null);
    React.useEffect(() => {
      let active = true, timer = null, attempts = 0;
      const poll = async () => {
        try {
          const result = await remote.toolCallRoute({ sessionId, callId });
          if (!active) return;
          // Only mounted running calls poll. Settled calls retry a brief publication race.
          const retry = phase === 'start' || (!result.known && phase === 'result' && ++attempts < 3);
          // A start-phase miss keeps its own wording; a settled miss waits for the last retry.
          setAnswer({ identity, result, reading: !result.known && phase === 'result' && retry });
          if (retry) timer = setTimeout(poll, 750);
        } catch {
          if (active) setAnswer({ identity, result: null, unreadable: true });
        }
      };
      if (readable) void poll();
      return () => { active = false; clearTimeout(timer); };
    }, [remote, identity, sessionId, callId, phase]);
    const matched = answer?.identity === identity;
    const label = readable && (!matched || answer.reading)
      ? { known: false, tone: 'unknown', text: '正在读取本次来源…' }
      : matched && answer.unreadable
        ? { known: false, tone: 'unknown', text: '本次来源暂不可读' }
        : describe(matched ? answer.result : null, phase, block?.isError);
    return jsx('div', { 'data-dsg-search-card': callId, children: [
      jsx('style', { children: styles }, 'style'),
      jsx(Original, props, 'original'),
      jsx('span', { className: 'dsg-tool-attribution', 'data-tone': label.tone,
        'data-known': String(label.known), role: phase === 'start' ? 'status' : undefined,
        'aria-atomic': phase === 'start' ? 'true' : undefined, children: label.text }, 'attribution'),
    ] });
  }
  return Object.freeze({ Component: SearchToolWithRoute, describe });
}
