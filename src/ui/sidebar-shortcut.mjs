// One owner per client connection, shared by the ordinary and shortcut settings pages.
export function createSidebarShortcut({ supported, mount, warn }) {
  const listeners = new Set();
  let binding, transport = true, preferences = null, removeSlots = null, retryTarget = null;
  let stopped = false, ready = false, saving = false, error = null, available = false;
  const enabled = () => preferences?.value?.sidebarShortcutEnabled === true;
  const notify = () => { for (const fn of listeners) { try { fn(); } catch { warn(); } } };
  const hide = () => {
    const remove = removeSlots;
    removeSlots = null;
    try { remove?.(); } catch { warn(); }
  };
  const reconcile = () => {
    const declared = supported();
    if (!declared) warn();
    if (!enabled()) {
      hide();
      available = declared;
    } else if (!removeSlots) {
      available = declared;
      try { removeSlots = mount(notifyAvailability); }
      catch { available = false; warn(); }
    } else if (!declared) available = false;
    notify();
  };
  function notifyAvailability(present) {
    if (stopped) return;
    available = present;
    if (!present) warn();
    notify();
  }
  function accept(result) {
    if (!result || typeof result.revision !== 'string' || !result.value || typeof result.value !== 'object') {
      throw new Error('Invalid preferences snapshot');
    }
    preferences = result;
    ready = true;
    if (error === 'read') error = null;
    reconcile();
  }
  function resetView() {
    preferences = retryTarget = error = null;
    ready = saving = available = false;
    hide();
    notify();
  }
  function bind(remote) {
    if (binding) resetView();
    const owner = { turn: { reads: 0, writes: 0 } };
    const live = turn => !stopped && transport != null && binding === owner && owner.turn === turn;
    const observed = { ...remote,
      async preferences() {
        const turn = owner.turn, id = ++turn.reads;
        const current = () => live(turn) && turn.reads === id && !turn.writes;
        try {
          const result = await remote.preferences();
          if (current()) accept(result);
          return result;
        } catch (cause) {
          if (current()) {
            ready = false;
            error = 'read';
            retryTarget = null;
            notify();
          }
          throw cause;
        }
      },
      async savePreferences(request) {
        const turn = owner.turn;
        turn.writes++;
        ++turn.reads;
        try {
          const result = await remote.savePreferences(request);
          if (live(turn)) {
            // Two page writes can overlap. A delayed CAS receipt must not roll back
            // another observed revision. Re-read only when order is ambiguous.
            if (!preferences || [request.expectedRevision, result.revision].includes(preferences.revision)) accept(result);
            else turn.recheck = true;
          }
          return result;
        } finally {
          ++turn.reads;
          if (--turn.writes === 0 && live(turn) && turn.recheck) {
            turn.recheck = false;
            void refresh();
          }
        }
      },
    };
    owner.remote = observed;
    if (!stopped) {
      binding = owner;
      available = supported();
      void refresh();
    }
    return { remote: observed, dispose: () => { if (binding === owner) { binding = null; resetView(); } } };
  }
  function setTransport(identity) {
    if (stopped || identity === transport) return;
    transport = identity;
    if (!binding) return;
    binding.turn = { reads: 0, writes: 0 };
    resetView();
    if (transport != null) void refresh();
  }
  async function refresh() {
    if (!binding || stopped || transport == null) return;
    try { await binding.remote.preferences(); } catch { /* Read errors are exposed on the switch. */ }
  }
  async function save(target, reread = false) {
    const owner = binding, turn = owner?.turn;
    const current = () => binding === owner && owner.turn === turn && !stopped;
    if (!owner || stopped || saving || !available || (!ready && !reread)) return;
    saving = true;
    retryTarget = target;
    error = null;
    notify();
    try {
      if (reread) await owner.remote.preferences();
      if (!current() || !ready) return;
      if (enabled() !== target) {
        const result = await owner.remote.savePreferences({ expectedRevision: preferences.revision,
          value: { ...preferences.value, sidebarShortcutEnabled: target } });
        if (result.value?.sidebarShortcutEnabled !== target) throw new Error('Preference not applied');
      }
      if (current()) retryTarget = null;
    } catch {
      if (current() && error !== 'read') error = 'save';
    } finally {
      if (current()) { saving = false; notify(); }
    }
  }
  return {
    bind, refresh, setTransport,
    getSnapshot: () => ({ enabled: enabled(), available, ready, saving, error, preferences }),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    toggle: () => save(!enabled()),
    retry: () => retryTarget === null ? refresh() : save(retryTarget, true),
    dispose() { stopped = true; binding = null; resetView(); listeners.clear(); },
  };
}

export function createSidebarTheme(theme, doc, win) {
  const media = win?.matchMedia?.('(prefers-color-scheme: dark)');
  const root = doc?.documentElement, body = doc?.body;
  return {
    dark() {
      if (typeof theme.current === 'boolean') return theme.current;
      if (root?.hasAttribute('data-ds-dark-theme') || body?.hasAttribute('data-ds-dark-theme')) return true;
      if (root?.hasAttribute('data-ds-theme-source')) return false;
      return media?.matches === true;
    },
    subscribe(fn) {
      theme.listeners.add(fn);
      const observer = win?.MutationObserver && new win.MutationObserver(fn);
      const options = { attributes: true, attributeFilter: ['data-ds-dark-theme', 'data-ds-theme-source'] };
      if (root) observer?.observe(root, options);
      if (body) observer?.observe(body, options);
      media?.addEventListener('change', fn);
      return () => {
        theme.listeners.delete(fn);
        observer?.disconnect();
        media?.removeEventListener('change', fn);
      };
    },
  };
}
