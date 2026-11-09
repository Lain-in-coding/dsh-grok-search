window.__ModuleLoader__.load({
  id: 'dsh-grok-search',
  factory: require => {
    const React = require('react');
    const { jsx } = require('react/jsx-runtime');
    const { useEffect, useRef } = React;
    const NS = 'plugins.dshGrokSearch';
    const inject = ['slots', 'locale', 'remote'];
    const LOGOS = __LOGOS__;
    const SOURCE_CHAIN = (__SOURCE_CHAIN_FACTORY__)();
    const ROUTE_CONTROLLER = (__ROUTE_CONTROLLER_FACTORY__);
    const SEARCH_LOG = (__SEARCH_LOG_FACTORY__);
    const QUOTA_VIEW = (__QUOTA_FACTORY__);
    const TOOL_ROUTE_VIEW = (__TOOL_ROUTE_FACTORY__);
    const ROUTE_CSS = __ROUTE_CSS__;
    const ROUTE_CARD = __ROUTE_CARD__;
    const ROUTE_LAYER = __ROUTE_LAYER__;
    const codec = __CODEC_FACTORY__;
    const descriptors = __SETTINGS_DESCRIPTORS__.map(descriptor => ({
      ...descriptor,
      parameters: descriptor.parameters.map(parameter => ({
        ...parameter, codec: codec(parameter.codec.typeSymbol, parameter.codec.jsonSchema),
      })),
      result: codec(descriptor.result.typeSymbol, descriptor.result.jsonSchema),
    }));
    const text = { title: 'Grok 搜索', configure: 'Grok 搜索设置' };
    // Session-only log privacy: survives settings remounts, cleared with the plugin's log.
    const logMemory = { private: false };

    function ProjectLink({ theme }) {
      const element = useRef(null);
      useEffect(() => {
        const shadow = element.current.shadowRoot || element.current.attachShadow({ mode: 'open' });
        // This is our slot content only: no host selectors, global styles or remote calls.
        shadow.innerHTML = `<style>
          :host{display:inline-flex;flex:none;width:24px;height:24px;vertical-align:middle}
          .project{position:relative;display:inline-flex;--focus:#4d6bfe}
          .project[data-theme=dark]{--focus:#9aabff}
          a{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:24px;height:24px;border-radius:6px;text-decoration:none;cursor:pointer}
          img{display:block;width:16px;height:16px;object-fit:contain;opacity:.7;transition:opacity 140ms ease}
          a:hover img,a:focus-visible img{opacity:1}
          a:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
          a:active img{opacity:.85}
          [role=tooltip]{position:absolute;top:calc(100% + 8px);left:50%;z-index:10;transform:translate(-50%,-2px);padding:5px 9px;border:1px solid #ffffff16;border-radius:7px;background:#26282d;color:#f5f6f8;box-shadow:0 4px 12px #0002;font:500 12px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;white-space:nowrap;opacity:0;visibility:hidden;pointer-events:none;transition:opacity 140ms ease,transform 140ms ease,visibility 140ms}
          [role=tooltip]::before{content:"";position:absolute;bottom:100%;left:0;right:0;height:8px}
          .project:not([data-dismissed]):is(:hover,:focus-within) [role=tooltip]{opacity:1;visibility:visible;pointer-events:auto;transform:translate(-50%,0)}
          @media(prefers-reduced-motion:reduce){img,[role=tooltip]{transition:none}}
        </style><span class="project"><a href="https://github.com/Lain-in-coding/dsh-grok-search" target="_blank" rel="noopener noreferrer" aria-label="打开 dsh-grok-search 的 GitHub 项目首页（新窗口）" aria-describedby="project-tip"><img alt="" aria-hidden="true" width="16" height="16" draggable="false"></a><span id="project-tip" role="tooltip">用着还行？给个star</span></span>`;
        const root = shadow.querySelector('.project');
        const image = shadow.querySelector('img');
        const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
        const updateTheme = () => {
          const dark = theme?.current ?? systemTheme.matches;
          root.dataset.theme = dark ? 'dark' : 'light';
          image.src = dark ? LOGOS.githubDark : LOGOS.github;
        };
        const show = () => root.removeAttribute('data-dismissed');
        const dismiss = () => root.setAttribute('data-dismissed', '');
        const keydown = event => { if (event.key === 'Escape' && root.matches(':hover,:focus-within')) dismiss(); };
        root.addEventListener('pointerenter', show);
        root.addEventListener('focusin', show);
        document.addEventListener('keydown', keydown);
        root.addEventListener('click', dismiss);
        theme?.listeners.add(updateTheme);
        systemTheme.addEventListener('change', updateTheme);
        updateTheme();
        return () => {
          theme?.listeners.delete(updateTheme);
          systemTheme.removeEventListener('change', updateTheme);
          root.removeEventListener('pointerenter', show);
          root.removeEventListener('focusin', show);
          document.removeEventListener('keydown', keydown);
          root.removeEventListener('click', dismiss);
          shadow.replaceChildren();
        };
      }, [theme]);
      return jsx('span', { ref: element, 'data-dsg-project': '1' });
    }

    function ProjectBadge({ subject, theme }) {
      return subject?.kind === 'bundle' && subject.pkg?.name === 'dsh-grok-search'
        ? jsx(ProjectLink, { theme }) : null;
    }

    function remoteAdapter(remote) {
      return Object.fromEntries(descriptors.map(({ method }) => [method, async (...args) => {
        let result;
        try {
          result = await remote.grokSearchSettings[method](...args);
        } catch (error) {
          const code = typeof error?.code === 'string' && /^(?:SETTINGS_|SEARCH_LOG_|CONFIG_|gateway[/.])[\w./-]{1,64}$/.test(error.code)
            ? error.code : 'SETTINGS_UNAVAILABLE';
          throw Object.assign(new Error('设置连接不可用，请重新打开插件详情页。'), {
            code,
          });
        }
        if (result?.ok === true) return result.value;
        throw Object.assign(new Error(result?.error?.message || '设置操作失败，请重试。'), {
          code: result?.error?.code || 'SETTINGS_OPERATION_FAILED',
          details: result?.error?.details || {},
        });
      }]));
    }

    function RoutePage({ remote, theme }) {
      const element = useRef(null);
      const memory = useRef({});
      useEffect(() => {
        if (!element.current) return;
        // StrictMode can set up the same element twice. Reuse its ShadowRoot
        // and remove every contribution made by the previous mount.
        const shadow = element.current.shadowRoot || element.current.attachShadow({ mode: 'open' });
        shadow.innerHTML = `<style>${ROUTE_CSS}</style><div class="dsg-surface dsg-root"><div class="route-scroll">${ROUTE_CARD}</div></div>`;
        const root = shadow.querySelector('.dsg-root');
        const layerHost = document.createElement('div');
        layerHost.dataset.dsgLayer = '1';
        Object.assign(layerHost.style, {
          position: 'fixed', top: '0', left: '0', width: '0', height: '0',
          zIndex: '2147483000', pointerEvents: 'none',
        });
        const layerShadow = layerHost.attachShadow({ mode: 'open' });
        layerShadow.innerHTML = `<style>${ROUTE_CSS}</style><div class="dsg-surface dsg-layer">${ROUTE_LAYER}</div>`;
        document.body.appendChild(layerHost);
        const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
        const currentTheme = () => theme?.current === null || theme?.current === undefined ? systemTheme.matches : theme.current;
        const controller = ROUTE_CONTROLLER({
          root, layer: layerShadow.querySelector('.dsg-layer'),
          remote: remoteAdapter(remote), logos: LOGOS, sourceChain: SOURCE_CHAIN, memory: memory.current,
          logMemory,
          createSearchLogView: SEARCH_LOG, createQuotaView: QUOTA_VIEW,
          dark: currentTheme(),
        });
        const updateTheme = () => controller.setTheme(currentTheme());
        theme?.listeners.add(updateTheme);
        systemTheme.addEventListener('change', updateTheme);
        updateTheme();
        return () => {
          theme?.listeners.delete(updateTheme);
          systemTheme.removeEventListener('change', updateTheme);
          controller.dispose();
          layerHost.remove();
          shadow.replaceChildren();
        };
      }, [remote, theme]);
      return jsx('div', {
        ref: element, 'data-dsg-route': '1', style: { width: '100%', minWidth: 0 },
        // rc.1 renders a bordered section even for an empty detail document.
        // Match only the empty document immediately before our own config slot.
        // React owns this light-DOM style; it leaves with the page on unmount.
        children: jsx('style', {
          'data-dsg-empty-detail': '1',
          children: `[data-detail-document]:has(> [role="region"] > :only-child:empty):has(+ [data-plugin-config] > [data-slot="plugins.bundle.config"] > [data-dsg-route="1"]) { display: none; }`,
        }),
      });
    }

    async function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: text, en: text }), 'dsh-grok-search: locale');
      const unmountRemote = await ctx.remote.$mount({ package: 'dsh-grok-search', descriptors });
      const theme = { current: null, listeners: new Set() };
      const themeView = ctx.inject(['theme'], themeCtx => {
        const update = snapshot => {
          theme.current = snapshot.active.colorScheme === 'dark';
          theme.listeners.forEach(listener => listener());
        };
        update(themeCtx.theme.getTheme());
        themeCtx.on('theme/change', update);
        return () => {
          theme.current = null;
          theme.listeners.forEach(listener => listener());
        };
      });
      // The optional theme fiber must never gate a working settings page.
      // Older/no-theme shells use prefers-color-scheme until it is available.
      const ui = ctx.inject(['remote.grokSearchSettings', 'slots', 'locale'], settingsCtx => {
        settingsCtx.slots.inject('plugins.detail.badge', () => settingsCtx.slots.register({
          name: 'plugins.detail.badge',
          id: 'dsh-grok-search-project',
          locale: NS,
          order: 30,
          inject: () => ({ theme }),
        }, ProjectBadge));
        settingsCtx.slots.inject('plugins.bundle.config', () => settingsCtx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-grok-search',
          locale: NS,
          order: 30,
          inject: () => ({ remote: settingsCtx.remote, theme }),
        }, RoutePage));
        settingsCtx.slots.inject('tool.call.toolview', () => {
          let stopped = false, selected = null, wrapper = null, remove = null;
          const refresh = () => {
            if (stopped) return;
            const entry = settingsCtx.slots.entries('tool.call.toolview')
              .find(row => row.options.key === 'web_search' && row.component !== wrapper);
            if (entry === selected) return;
            remove?.(); remove = null; selected = entry;
            // The supported hosts publish a plain WebRow. Never strip another
            // extension's injected props, stores or child-slot authority.
            if (!entry || entry.inject || entry.store || entry.children || entry.select) return;
            wrapper = TOOL_ROUTE_VIEW({ React, jsx, remote: remoteAdapter(settingsCtx.remote),
              Original: entry.component }).Component;
            remove = settingsCtx.slots.register({
              name: 'tool.call.toolview', key: 'web_search', locale: entry.locale,
              priority: (entry.options.priority ?? 0) - 1,
            }, wrapper);
          };
          const unsubscribe = settingsCtx.slots.subscribe('tool.call.toolview', refresh);
          refresh();
          return () => { stopped = true; unsubscribe(); remove?.(); };
        });
      });
      try {
        await ui;
      } catch (error) {
        await ui.dispose();
        await themeView.dispose();
        await unmountRemote();
        throw error;
      }
      return async () => {
        logMemory.private = false;
        await ui.dispose();
        await themeView.dispose();
        await unmountRemote();
      };
    }
    return { NS, inject, apply, __test: Object.freeze({ descriptors, remoteAdapter, sourceChain: SOURCE_CHAIN, toolRouteView: TOOL_ROUTE_VIEW }) };
  },
});
