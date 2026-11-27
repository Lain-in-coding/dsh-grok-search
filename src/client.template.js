// Browser ESM entry; the historical filename is used by preview fingerprints.
import { createSettingsCodec as codec } from './core/settings-codec.mjs';
import { createSourceChain } from './core/source-chain.mjs';
import { createRouteController as ROUTE_CONTROLLER } from './ui/route-controller.mjs';
import { createSearchLogView as SEARCH_LOG } from './ui/search-log-view.mjs';
import { createQuotaView as QUOTA_VIEW } from './ui/quota-view.mjs';
import { createToolRouteView as TOOL_ROUTE_VIEW } from './ui/tool-route-view.mjs';
import { createCompatibilityView as COMPATIBILITY_VIEW } from './ui/compatibility-view.mjs';
import { attachSharedStyles } from './ui/shared-styles.mjs';
import { createSidebarShortcut, createSidebarTheme } from './ui/sidebar-shortcut.mjs';
import { LOGOS, TOOL_ROUTE_CSS, ROUTE_CSS, ROUTE_CARD, ROUTE_LAYER, SETTINGS_DESCRIPTORS, COMPATIBILITY_DESCRIPTORS } from 'dsh:client-data';

window.__ModuleLoader__.load({
  id: 'dsh-grok-search',
  factory: require => {
    const React = require('react');
    const { jsx } = require('react/jsx-runtime');
    const { useEffect, useRef } = React;
    const NS = 'plugins.dshGrokSearch';
    const inject = ['slots', 'locale', 'remote'];
    const SOURCE_CHAIN = createSourceChain();
    const hydrate = input => input.map(descriptor => ({
      ...descriptor,
      parameters: descriptor.parameters.map(parameter => ({
        ...parameter, codec: codec(parameter.codec.typeSymbol, parameter.codec.jsonSchema),
      })),
      result: codec(descriptor.result.typeSymbol, descriptor.result.jsonSchema),
    }));
    const descriptors = hydrate(SETTINGS_DESCRIPTORS);
    const compatibilityDescriptors = hydrate(COMPATIBILITY_DESCRIPTORS);
    const allDescriptors = [...descriptors, ...compatibilityDescriptors];
    const compatibilityParser = compatibilityDescriptors.find(row => row.method === 'compatibilityReport').result.create();
    const text = { title: 'Grok 搜索', configure: 'Grok 搜索设置', panel: '网页搜索' };
    // Session-only log privacy: survives settings remounts, cleared with the plugin's log.
    const logMemory = { private: false };
    const compatibilityMemory = {};

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
        </style><span class="project"><a href="https://github.com/Lain-in-coding/dsh-grok-search" target="_blank" rel="noopener noreferrer" aria-label="打开 dsh-grok-search 的 GitHub 项目首页（新窗口）" aria-describedby="project-tip"><img alt="" aria-hidden="true" width="16" height="16" draggable="false"></a><span id="project-tip" role="tooltip">用着还行？给个 star</span></span>`;
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

    function remoteAdapter(remote, methods = descriptors) {
      return Object.fromEntries(methods.map(({ method, namespace }) => [method, async (...args) => {
        let result;
        try {
          result = await remote[namespace][method](...args);
        } catch (error) {
          const code = typeof error?.code === 'string' && /^(?:COMPATIBILITY_|SETTINGS_|SEARCH_LOG_|CONFIG_|gateway[/.])[\w./-]{1,64}$/.test(error.code)
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

    // Group the live elements before binding them. The ordinary detail keeps
    // its original DOM, scroll container and tab order.
    function frameShortcut(root) {
      const intro = root.querySelector('.plugin-intro'), card = root.querySelector('#routeCard');
      const frame = document.createElement('div');
      frame.className = 'shortcut-workbench';
      intro.before(frame);
      frame.append(intro, card);
      const live = card.querySelector('#stage'), viewport = document.createElement('div');
      viewport.id = 'stageViewport';
      viewport.tabIndex = 0;
      viewport.setAttribute('role', 'region');
      viewport.setAttribute('aria-label', '搜索路由图，较窄时可横向滚动');
      live.before(viewport);
      viewport.append(live, card.querySelector('#historyStage'));
    }

    function RoutePage({ connection, theme, panel = false }) {
      const element = useRef(null);
      const memory = useRef({});
      useEffect(() => {
        if (!element.current) return;
        // StrictMode can set up the same element twice. Reuse its ShadowRoot
        // and remove every contribution made by the previous mount.
        const shadow = element.current.shadowRoot || element.current.attachShadow({ mode: 'open' });
        shadow.innerHTML = `<div class="dsg-surface${panel ? ' dsg-shortcut' : ''}"><div data-dsg-compatibility></div><div data-dsg-settings></div><div class="note" data-dsg-settings-unavailable role="status"></div></div>`;
        const detachMainStyle = attachSharedStyles(shadow, ROUTE_CSS);
        const surface = shadow.querySelector('.dsg-surface');
        const settingsRoot = shadow.querySelector('[data-dsg-settings]');
        const unavailable = shadow.querySelector('[data-dsg-settings-unavailable]');
        const appearance = createSidebarTheme(theme ?? { listeners: new Set() }, element.current.ownerDocument, window);
        let controller = null, layerHost = null, detachLayerStyle = null, mountedRemote = null;
        const removeSettings = () => {
          try { controller?.dispose(); }
          finally {
            controller = null;
            mountedRemote = null;
            detachLayerStyle?.(); detachLayerStyle = null;
            layerHost?.remove(); layerHost = null;
            settingsRoot.replaceChildren();
          }
        };
        const syncSettings = () => {
          // The actual settings service owns availability, not a potentially
          // delayed or failed compatibility report.
          const available = connection.settings;
          if (available && mountedRemote === connection.settings) return;
          try {
            removeSettings();
            unavailable.hidden = Boolean(available);
            unavailable.textContent = available ? '' : '完整设置当前不可用；兼容性状态独立显示。核心搜索按服务端检查结果运行。';
            if (!available) return;
            settingsRoot.innerHTML = `<div class="dsg-root"><div class="route-scroll">${ROUTE_CARD}</div></div>`;
            if (panel) frameShortcut(settingsRoot);
            layerHost = document.createElement('div');
            layerHost.dataset.dsgLayer = '1';
            Object.assign(layerHost.style, {
              position: 'fixed', top: '0', left: '0', width: '0', height: '0',
              zIndex: '2147483000', pointerEvents: 'none',
            });
            const layerShadow = layerHost.attachShadow({ mode: 'open' });
            layerShadow.innerHTML = `<div class="dsg-surface dsg-layer">${ROUTE_LAYER}</div>`;
            detachLayerStyle = attachSharedStyles(layerShadow, ROUTE_CSS);
            document.body.appendChild(layerHost);
            controller = ROUTE_CONTROLLER({
              root: settingsRoot.querySelector('.dsg-root'), layer: layerShadow.querySelector('.dsg-layer'),
              remote: connection.settings, sidebar: connection.sidebar, logos: LOGOS, sourceChain: SOURCE_CHAIN, memory: memory.current, logMemory,
              createSearchLogView: SEARCH_LOG, createQuotaView: QUOTA_VIEW, dark: appearance.dark(),
            });
            mountedRemote = connection.settings;
          } catch {
            try { removeSettings(); } catch { /* The unavailable view still survives cleanup failure. */ }
            unavailable.hidden = false;
            unavailable.textContent = '完整设置界面暂不可用；兼容性状态与核心搜索独立运行。';
          }
        };
        const compatibility = COMPATIBILITY_VIEW({
          root: shadow.querySelector('[data-dsg-compatibility]'), remote: connection.compatibility,
          parseReport: value => compatibilityParser.parse(value), memory: compatibilityMemory,
        });
        const updateTheme = () => {
          const dark = appearance.dark();
          surface.dataset.theme = dark ? 'dark' : 'light';
          controller?.setTheme(dark);
        };
        const updateConnection = () => {
          compatibility.bind(connection.compatibility);
          syncSettings();
          updateTheme();
        };
        connection.listeners.add(updateConnection);
        const unbindTheme = appearance.subscribe(updateTheme);
        updateConnection();
        return () => {
          connection.listeners.delete(updateConnection);
          unbindTheme();
          compatibility.dispose();
          try { removeSettings(); }
          finally { detachMainStyle(); shadow.replaceChildren(); }
        };
      }, [connection, theme, panel]);
      return jsx('div', {
        ref: element, 'data-dsg-route': '1', 'data-dsg-shortcut-panel': panel || undefined,
        style: { width: '100%', minWidth: 0, ...(panel ? { height: '100%', overflowY: 'auto' } : {}) },
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
      let stopped = false;
      const cleanups = new Set(), reported = new Set();
      const connection = { settings: null, compatibility: null, sidebar: null, listeners: new Set() };
      const transportListeners = new Set();
      let transport = true, generation = 0, connectionOwner;
      const unavailable = feature => {
        if (reported.has(feature)) return;
        reported.add(feature);
        ctx.logger?.warn?.(`DSH_CLIENT_${feature.toUpperCase()}_UNAVAILABLE: optional client integration is unavailable; backend state is unchanged.`);
      };
      const own = cleanup => {
        if (typeof cleanup !== 'function') return () => {};
        let active = true;
        const dispose = () => {
          if (!active) return;
          active = false;
          cleanups.delete(dispose);
          try {
            const result = cleanup();
            return result?.catch ? result.catch(() => unavailable('cleanup')) : result;
          } catch { unavailable('cleanup'); }
        };
        cleanups.add(dispose);
        return dispose;
      };
      const stop = async () => {
        if (stopped) return;
        stopped = true;
        connection.settings = connection.compatibility = null;
        publish();
        connection.listeners.clear();
        generation++;
        connection.sidebar?.dispose();
        logMemory.private = false;
        for (const dispose of [...cleanups].reverse()) await dispose();
      };
      if (typeof ctx.slots?.inject !== 'function' || typeof ctx.slots?.register !== 'function'
        || typeof ctx.locale?.register !== 'function' || typeof ctx.remote?.$mount !== 'function'
        || typeof ctx.inject !== 'function' || typeof ctx.effect !== 'function') {
        unavailable('base');
        return stop;
      }
      function publish() {
        for (const listener of connection.listeners) {
          try { listener(); } catch { unavailable('settings'); }
        }
      }
      const bind = (key, value) => {
        connection[key] = value;
        publish();
        return () => { if (connection[key] === value) { connection[key] = null; publish(); } };
      };
      const whileConnected = (remote, attach) => {
        let detach;
        const sync = () => {
          detach?.();
          detach = null;
          if (stopped || transport == null) return;
          const owner = generation;
          let active = true;
          const check = () => {
            if (!active || generation !== owner) throw Object.assign(new Error('设置连接已变化。'), { code: 'SETTINGS_UNAVAILABLE' });
          };
          const scoped = Object.fromEntries(Object.entries(remote).map(([method, call]) => [method, async (...args) => {
            check();
            try { return await call(...args); } finally { check(); }
          }]));
          const remove = attach(scoped);
          detach = () => { try { remove(); } finally { active = false; } };
        };
        sync();
        transportListeners.add(sync);
        return () => { transportListeners.delete(sync); detach?.(); };
      };
      const optional = (feature, names, setup) => {
        try {
          const fiber = ctx.inject(names, child => {
            if (stopped) return;
            try { return own(setup(child)); } catch { unavailable(feature); }
          });
          own(() => fiber?.dispose?.());
          Promise.resolve(fiber).catch(() => unavailable(feature));
        } catch { unavailable(feature); }
      };
      const slot = (owner, name, feature, setup) => {
        let active = true, subscription;
        const contributions = new Set();
        const dispose = own(() => {
          active = false;
          try {
            if (typeof subscription === 'function') subscription();
            else subscription?.dispose?.();
          } finally {
            for (const remove of contributions) remove();
            contributions.clear();
          }
        });
        try {
          subscription = owner.slots.inject(name, () => {
            if (stopped || !active) return;
            // The slot may become available later, outside apply()'s call stack.
            try {
              const remove = own(setup());
              contributions.add(remove);
              return () => { contributions.delete(remove); return remove(); };
            } catch { unavailable(feature); }
          });
          Promise.resolve(subscription).catch(() => unavailable(feature));
        } catch { dispose(); unavailable(feature); }
        return dispose;
      };
      try {
        own(await ctx.remote.$mount({ package: 'dsh-grok-search', descriptors: allDescriptors }));
        ctx.effect(() => own(ctx.locale.register(NS, { zh: text,
          en: { ...text, panel: 'Web search' } })), 'dsh-grok-search: locale');
      } catch {
        unavailable('base');
        await stop();
        return stop;
      }
      try {
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {};
          try {
            const style = document.createElement('style');
            style.dataset.dsgChatStyle = '1';
            style.textContent = TOOL_ROUTE_CSS;
            document.head.appendChild(style);
            return own(() => style.remove());
          } catch { unavailable('chat'); return () => {}; }
        }, 'dsh-grok-search: chat card styles');
      } catch { unavailable('chat'); }
      const theme = { current: null, listeners: new Set() };
      const sidebarTheme = createSidebarTheme(theme, globalThis.document, globalThis.window);
      function SidebarIcon({ size = 16, active }) {
        const dark = React.useSyncExternalStore(sidebarTheme.subscribe, sidebarTheme.dark);
        return jsx('img', {
          'data-dsg-sidebar-icon': '1', 'data-active': active === true, alt: '', draggable: false,
          src: dark ? LOGOS.sidebarDark : LOGOS.sidebarLight, width: size, height: size,
          style: { display: 'block', objectFit: 'contain', flex: 'none', width: `${size}px`, height: `${size}px` },
        });
      }
      const panelId = 'dsh-grok-search.web-search';
      const label = () => ctx.locale.bind?.(NS)('panel') ?? text.panel;
      const supported = () => {
        try { return Boolean(ctx.slots.spec?.('main') && ctx.slots.spec('sidebar.panellist')); }
        catch { return false; }
      };
      const shortcut = createSidebarShortcut({
        supported, warn: () => unavailable('sidebar'),
        mount: capability => {
          // Watch declarations, not panel entries. A nested declaration may disappear
          // and return independently, so register the pair only while both exist.
          let active = true;
          const cancel = slot(ctx, 'main', 'sidebar', () =>
            slot(ctx, 'sidebar.panellist', 'sidebar', () => {
              let main, sidebar;
              try {
                main = ctx.slots.register({ name: 'main', key: panelId, locale: NS,
                  inject: () => ({ connection, theme, panel: true }) }, RoutePage);
                sidebar = ctx.slots.register({ name: 'sidebar.panellist', id: panelId, order: 30,
                  label, locale: NS }, SidebarIcon);
                capability(true);
              } catch {
                main?.();
                capability(false);
                return;
              }
              return () => {
                try { sidebar(); } finally { main(); }
                if (active && !stopped) capability(false);
              };
            }));
          return () => { active = false; cancel(); };
        },
      });
      connection.sidebar = shortcut;
      const setTransport = (next, newOwner = false) => {
        if (stopped || (!newOwner && next === transport)) return;
        transport = next;
        generation++;
        shortcut.setTransport(next == null ? null : generation);
        for (const listener of transportListeners) {
          try { listener(); } catch { unavailable('connection'); }
        }
      };
      optional('connection', ['connection'], child => {
        const store = child.connection?.generation;
        if (!store?.subscribe || !store.getSnapshot) return;
        const update = () => { if (connectionOwner === update) setTransport(store.getSnapshot()); };
        const unsubscribe = store.subscribe(update);
        connectionOwner = update;
        setTransport(store.getSnapshot(), true);
        return () => {
          try { unsubscribe(); } finally {
            if (connectionOwner === update) { connectionOwner = null; setTransport(true, true); }
          }
        };
      });
      const focus = () => { void shortcut.refresh(); };
      window.addEventListener?.('focus', focus);
      own(() => window.removeEventListener?.('focus', focus));
      optional('theme', ['theme'], themeCtx => {
        const update = snapshot => {
          try {
            theme.current = snapshot.active.colorScheme === 'dark';
            theme.listeners.forEach(listener => listener());
          } catch { unavailable('theme'); }
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
      slot(ctx, 'plugins.detail.badge', 'badge', () => ctx.slots.register({
        name: 'plugins.detail.badge', id: 'dsh-grok-search-project', locale: NS, order: 30,
        inject: () => ({ theme }),
      }, ProjectBadge));
      slot(ctx, 'plugins.bundle.config', 'settings', () => ctx.slots.register({
        name: 'plugins.bundle.config', key: 'dsh-grok-search', locale: NS, order: 30,
        inject: () => ({ connection, theme }),
      }, RoutePage));
      optional('compatibility', ['remote.grokSearchCompatibility'], child =>
        whileConnected(remoteAdapter(child.remote, compatibilityDescriptors), remote => bind('compatibility', remote)));
      const attachSettings = (settingsCtx, remote) => {
        const unbind = bind('settings', remote);
        const removeSlot = slot(settingsCtx, 'tool.call.toolview', 'chat', () => {
          let stopped = false, selected = null, wrapper = null, remove = null;
          const refresh = () => {
            if (stopped) return;
            try {
              const entry = settingsCtx.slots.entries('tool.call.toolview')
                .find(row => row.options.key === 'web_search' && row.component !== wrapper);
              if (entry === selected) return;
              remove?.(); remove = null; selected = entry;
              // Do not replace another extension's injected props or authority.
              if (!entry || entry.inject || entry.store || entry.children || entry.select) return;
              wrapper = TOOL_ROUTE_VIEW({ React, jsx, remote,
                Original: entry.component, logos: LOGOS, theme }).Component;
              remove = settingsCtx.slots.register({
                name: 'tool.call.toolview', key: 'web_search', locale: entry.locale,
                priority: (entry.options.priority ?? 0) - 1,
              }, wrapper);
            } catch { unavailable('chat'); }
          };
          const unsubscribe = settingsCtx.slots.subscribe('tool.call.toolview', refresh);
          refresh();
          return () => { stopped = true; unsubscribe(); remove?.(); };
        });
        return () => { try { removeSlot(); } finally { unbind(); } };
      };
      optional('settings', ['remote.grokSearchSettings'], settingsCtx => {
        const binding = shortcut.bind(remoteAdapter(settingsCtx.remote));
        const detach = whileConnected(binding.remote, remote => attachSettings(settingsCtx, remote));
        return () => { try { detach(); } finally { binding.dispose(); } };
      });
      return stop;
    }
    return { NS, inject, apply, __test: Object.freeze({
      descriptors, compatibilityDescriptors, allDescriptors, remoteAdapter, RoutePage,
      compatibilityView: COMPATIBILITY_VIEW, sourceChain: SOURCE_CHAIN, toolRouteView: TOOL_ROUTE_VIEW,
      routeController: ROUTE_CONTROLLER, searchLogView: SEARCH_LOG, quotaView: QUOTA_VIEW,
      LOGOS, TOOL_ROUTE_CSS, ROUTE_CSS, ROUTE_CARD, ROUTE_LAYER,
    }) };
  },
});
