/**
 * The single supplementary-source chain shared with grok-search-rs v0.1.26.
 *
 * Upstream reads `source_providers` (`GROK_SEARCH_SOURCE_PROVIDERS`) and the
 * `*_enabled` switches from the same config.toml/environment. A non-empty
 * list keeps only the named sources, in that order; an empty list means the
 * canonical order. A source is used only when it is listed and enabled.
 *
 * Self-contained (no outer bindings) so the settings client embeds this exact
 * function via `toString()` instead of keeping a second copy of the rules.
 * Errors carry a stable `code`; callers wrap or display them.
 */
export function createSourceChain() {
  const SOURCES = ['tavily', 'exa', 'tinyfish', 'firecrawl'];
  const failWith = (code, message) => { const error = new Error(message); error.code = code; throw error; };
  const envLocked = () => failWith('CONFIG_ENV_OVERRIDE', '这些配置由启动环境提供，不能在插件中覆盖，请先修改环境变量。');
  const item = (fields, key) => {
    const raw = fields?.[key];
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) && Object.hasOwn(raw, 'value')
      ? { value: raw.value, readOnly: raw.readOnly === true } : { value: raw, readOnly: false };
  };
  const listOf = value => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [])
    .map(id => String(id).trim().toLowerCase())
    .filter((id, index, all) => SOURCES.includes(id) && all.indexOf(id) === index);

  /** Effective order and on/off, exactly as grok-search-rs would use them. */
  function view(fields) {
    const list = item(fields, 'source_providers');
    const listed = listOf(list.value);
    const explicit = listed.length > 0;
    const included = explicit ? listed : [...SOURCES];
    const order = [...included, ...SOURCES.filter(id => !included.includes(id))];
    const flags = {}, enabled = {}, flagLocked = {};
    for (const id of SOURCES) {
      const flag = item(fields, `${id}_enabled`);
      flags[id] = flag.value !== false;
      flagLocked[id] = flag.readOnly;
      enabled[id] = flags[id] && included.includes(id);
    }
    return { order, listed: included, explicit, enabled, flags, flagLocked, orderLocked: list.readOnly };
  }

  /**
   * Minimal config updates for one user action, keeping every other source's
   * effective on/off unchanged.
   *   { kind: 'toggle', id, on }  switch one source
   *   { kind: 'order', order }    the full display order after a drag
   * Fields owned by the environment are never written; an action that would
   * need them fails with CONFIG_ENV_OVERRIDE before anything is saved.
   */
  function plan(fields, change) {
    const current = view(fields);
    const updates = {};
    const writeList = list => {
      if (list.length === 0) failWith('SOURCE_CHAIN_EMPTY', '至少保留一个补充来源；如需全部停用，请逐个关闭开关。');
      const unchanged = current.explicit ? list.join() === current.listed.join() : list.join() === SOURCES.join();
      if (unchanged) return;
      if (current.orderLocked) envLocked();
      updates.source_providers = list;
    };
    const writeFlag = (id, on) => {
      if (current.flags[id] === on) return;
      if (current.flagLocked[id]) envLocked();
      updates[`${id}_enabled`] = on;
    };
    if (change?.kind === 'toggle') {
      const { id, on } = change;
      if (!SOURCES.includes(id) || typeof on !== 'boolean') failWith('SOURCE_CHAIN_INVALID', '补充来源开关无效。');
      if (current.enabled[id] === on) return updates;
      if (on) {
        writeFlag(id, true);
        if (!current.listed.includes(id)) writeList([...current.listed, id]);
      } else if (!current.flagLocked[id]) {
        writeFlag(id, false);
      } else {
        // The environment forces this switch on: leaving the list is the only
        // way off that grok-search-rs also honours.
        writeList(current.listed.filter(other => other !== id));
      }
      return updates;
    }
    if (change?.kind === 'order') {
      const order = Array.isArray(change.order) ? change.order : [];
      if (order.length !== SOURCES.length || new Set(order).size !== SOURCES.length
        || order.some(id => !SOURCES.includes(id))) failWith('SOURCE_CHAIN_INVALID', '补充来源顺序无效。');
      if (order.join() === current.order.join()) return updates;
      // A full list keeps the dragged order; a source that was off only by
      // being left out stays off through its own switch instead.
      const list = order.filter(id => current.enabled[id] || !current.flags[id] || !current.flagLocked[id]);
      for (const id of list) if (!current.enabled[id] && current.flags[id]) writeFlag(id, false);
      writeList(list);
      return updates;
    }
    return failWith('SOURCE_CHAIN_INVALID', '未知的补充来源操作。');
  }

  return Object.freeze({ SOURCES: Object.freeze([...SOURCES]), view, plan });
}
