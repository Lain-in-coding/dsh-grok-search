// Run on the local fixture OR an explicitly authorized Desktop acceptance page.
// No reload, upstream requests, saved settings, theme changes or synthetic chat
// data. Restores the observed disclosure and scroll positions even on failure.
// Frame metrics complement long-task counters: GPU stalls may have zero JS
// long tasks. Thresholds are evidence, not a cross-device zero-jank guarantee.
async page => {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/|^dsh-app:\/\/app\//.test(page.url())) {
    throw new Error('Use the local preview or the authorized acceptance window.');
  }
  const result = await page.evaluate(async () => {
    const root = document.querySelector('.dsg-chat'), card = root?.querySelector('.search-card');
    const button = card?.querySelector('.card-toggle');
    if (!button || document.hidden || root.dataset.visible === 'false') throw new Error('A visible search card is required.');
    if (card.querySelector('.header-right .state')?.dataset.state === 'running') throw new Error('Wait for the actual search to finish.');
    const originalOpen = card.dataset.open === 'true';
    const scrolls = new Map();
    for (let node = root; node; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 2) scrolls.set(node, { top: node.scrollTop, left: node.scrollLeft });
    }
    const regions = [...card.querySelectorAll('.flow-scroll')];
    for (const node of regions) scrolls.set(node, { top: node.scrollTop, left: node.scrollLeft });
    const tasks = [], frames = [], observedAnimations = new Set();
    let observer = null, raf = null, pending = null, settleTimer = null;
    const turn = () => new Promise(resolve => requestAnimationFrame(resolve));
    const recordAnimation = event => observedAnimations.add(event.animationName || event.propertyName);
    const settle = async () => {
      await turn();
      // Do not query getAnimations/getComputedStyle on every measured frame:
      // that can itself force compositor/style synchronization in Electron.
      const running = root.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running');
      if (!running.length) return;
      try {
        await Promise.race([
          Promise.all(running.map(animation => animation.finished.catch(() => {}))),
          new Promise((_, reject) => { settleTimer = setTimeout(() => reject(new Error('Card transitions did not settle within two seconds.')), 2000); }),
        ]);
      } finally { clearTimeout(settleTimer); settleTimer = null; }
    };
    const setOpen = async value => {
      if (!card.isConnected || document.hidden) throw new Error('The acceptance card is no longer visible; stop this sample.');
      if ((card.dataset.open === 'true') !== value) button.click();
      await turn(); await settle();
    };
    const sample = async (action, update) => {
      tasks.length = 0; frames.length = 0; observedAnimations.clear();
      let previous = null, started = null;
      const beforeHeight = card.getBoundingClientRect().height;
      await new Promise((resolve, reject) => {
        pending = setTimeout(() => reject(new Error('Frame sampling timed out.')), 6000);
        const step = time => {
          if (!card.isConnected || document.hidden) {
            clearTimeout(pending); pending = null;
            reject(new Error('The acceptance page changed during sampling.'));
            return;
          }
          if (previous !== null) frames.push(time - previous);
          previous = time;
          if (started === null) {
            started = time;
            action?.();
          }
          update?.(Math.min(1, (time - started) / 600));
          if (time - started < 750) raf = requestAnimationFrame(step);
          else { clearTimeout(pending); pending = null; resolve(); }
        };
        raf = requestAnimationFrame(step);
      });
      const sorted = frames.toSorted((a, b) => a - b);
      return {
        frames: frames.length,
        p95Ms: Math.round((sorted[Math.floor(sorted.length * .95)] ?? 0) * 10) / 10,
        maxFrameMs: Math.round((sorted.at(-1) ?? 0) * 10) / 10,
        framesOver50: frames.filter(value => value > 50).length,
        longTasks: [...tasks], animations: [...observedAnimations],
        beforeHeight, afterHeight: card.getBoundingClientRect().height,
      };
    };
    try {
      root.addEventListener('animationstart', recordAnimation);
      root.addEventListener('transitionstart', recordAnimation);
      if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(entry => Math.round(entry.duration * 10) / 10)));
        observer.observe({ type: 'longtask' });
      }
      await setOpen(false);
      const trials = [];
      for (let index = 0; index < 3; index++) {
        trials.push({ action: index === 0 ? 'first-observed-open' : 'repeat-open', ...await sample(() => button.click()) });
        await settle();
        trials.push({ action: 'close', ...await sample(() => button.click()) });
        await settle();
      }
      await setOpen(true);
      const scroller = [...scrolls.keys()].find(node => !regions.includes(node)
        && node.scrollHeight > node.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(node).overflowY));
      if (scroller) {
        const start = scroller.scrollTop, distance = Math.min(160, scroller.scrollHeight - scroller.clientHeight - start);
        trials.push({ action: 'scroll-expanded', ...await sample(null, progress => { scroller.scrollTop = start + distance * Math.sin(progress * Math.PI); }) });
      }
      const region = regions.find(node => node.scrollWidth > node.clientWidth + 2);
      if (region) {
        const start = region.scrollLeft, distance = region.scrollWidth - region.clientWidth;
        trials.push({ action: 'scroll-route', ...await sample(null, progress => { region.scrollLeft = start + distance * Math.sin(progress * Math.PI); }) });
      }
      return {
        fixture: Boolean(window.__dsgChatFixture), viewport: [innerWidth, innerHeight], dpr: devicePixelRatio,
        theme: root.dataset.theme, routes: card.querySelectorAll('.flow').length,
        suppliers: card.querySelectorAll('.provider-steps .route-node').length,
        sources: card.querySelectorAll('.source-row').length, originalOpen,
        whale: [...card.querySelectorAll('.logo[data-logo=dsh]')].map(image => ({
          size: [image.naturalWidth, image.naturalHeight], blend: getComputedStyle(image).mixBlendMode, filter: getComputedStyle(image).filter,
        })),
        trials,
        meetsReferenceBudget: trials.every(trial => trial.p95Ms <= 35 && trial.maxFrameMs <= 100),
        referenceBudget: { p95Ms: 35, maxFrameMs: 100 },
        freshInstallFirstOpen: false,
      };
    } finally {
      observer?.disconnect();
      root.removeEventListener('animationstart', recordAnimation);
      root.removeEventListener('transitionstart', recordAnimation);
      cancelAnimationFrame(raf);
      clearTimeout(pending);
      clearTimeout(settleTimer);
      try {
        if (card.isConnected && (card.dataset.open === 'true') !== originalOpen) {
          button.click();
          if (!document.hidden) { await turn(); await settle(); }
        }
      } finally {
        for (const [node, position] of scrolls) if (node.isConnected) {
          node.scrollTop = position.top; node.scrollLeft = position.left;
        }
      }
    }
  });
  return result;
}
