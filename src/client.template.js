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

    function remoteAdapter(remote) {
      return Object.fromEntries(descriptors.map(({ method }) => [method, async (...args) => {
        let result;
        try {
          result = await remote.grokSearchSettings[method](...args);
        } catch (error) {
          throw Object.assign(new Error('设置连接不可用，请重新打开插件详情页。'), {
            code: 'SETTINGS_UNAVAILABLE',
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
        const controller = ROUTE_CONTROLLER({
          root, layer: layerShadow.querySelector('.dsg-layer'),
          remote: remoteAdapter(remote), logos: LOGOS, sourceChain: SOURCE_CHAIN, memory: memory.current,
        });
        const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
        const updateTheme = () => controller.setTheme(theme?.current === null || theme?.current === undefined
          ? systemTheme.matches : theme.current);
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
      return jsx('div', { ref: element, 'data-dsg-route': '1', style: { width: '100%', minWidth: 0 } });
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
        settingsCtx.slots.inject('plugins.bundle.config', () => settingsCtx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-grok-search',
          locale: NS,
          order: 30,
          inject: () => ({ remote: settingsCtx.remote, theme }),
        }, RoutePage));
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
        await ui.dispose();
        await themeView.dispose();
        await unmountRemote();
      };
    }
    return { NS, inject, apply, __test: Object.freeze({ descriptors, sourceChain: SOURCE_CHAIN }) };
  },
});
