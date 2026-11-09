import { effectiveConfig } from './product-control.mjs';

const TOOL_MODULE = '@deepseek-ai/dsh-tool-web';
const plain = value => Object.fromEntries(Object.entries(value ?? {})
  .map(([key, item]) => [key, typeof item?.get === 'function' ? item.get() : item]));

/** Runtime-only leases; never edit a profile, enable a tool or patch a method. */
export function createToolBudgetController({ ctx, budgetMs, required, resolveConfig, onError = () => {} }) {
  const leases = new Map(), own = new Set(), yielded = new WeakSet();
  let releasing = false, serial = Promise.resolve();
  const target = fiber => fiber?.uid !== null && fiber?.runtime?.name === 'tool-web'
    && fiber.entry?.options?.name === TOOL_MODULE && fiber.entry.options.disabled !== true;
  const hook = function (input, next) {
    const modern = typeof input?.resolveConfig === 'function';
    const fiber = modern ? input : this;
    const value = next();
    if (!target(fiber) || releasing || !required() || yielded.has(fiber) || value?.search === false) return value;
    const lease = leases.get(fiber);
    // Active candidate resolution may be a validation-only call. Return the
    // author's candidate; yield ownership only if internal/update commits it.
    if (lease && !own.has(fiber) && fiber.state === 2) return value;
    if (!lease) leases.set(fiber, { raw: structuredClone(plain(modern ? fiber.config : input)),
      before: plain(value).searchTimeoutMs });
    const candidate = { ...plain(value), searchTimeoutMs: budgetMs };
    return modern ? resolveConfig(fiber.runtime, candidate) : candidate;
  };
  const updateHook = function (...args) {
    const next = args.at(-1);
    if (leases.has(this) && !own.has(this) && !releasing) {
      yielded.add(this);
      leases.delete(this);
    }
    return next();
  };
  const refresh = async (fiber, raw) => {
    if (!target(fiber)) return;
    own.add(fiber);
    try { await fiber.update(raw, true); await fiber.await?.(); }
    finally { own.delete(fiber); }
  };
  const acquire = async () => {
    for (const runtime of ctx.registry.values()) {
      for (const fiber of [...runtime.fibers]) {
        if (!target(fiber) || yielded.has(fiber) || !required() || releasing) continue;
        if (effectiveConfig(fiber)?.search === false) continue;
        const raw = 'effectiveConfig' in fiber ? fiber.config : fiber.entry.options.config ?? plain(effectiveConfig(fiber));
        await refresh(fiber, raw);
      }
    }
  };
  ctx.on('internal/config', hook, { global: true, prepend: true });
  ctx.on('internal/update', updateHook, { global: true, prepend: true });
  ctx.on('internal/plugin', fiber => { if (fiber.uid === null) leases.delete(fiber); }, { global: true });
  const controller = {
    acquire() { serial = serial.then(acquire); return serial; },
    async release() {
      releasing = true;
      await serial.catch(onError);
      for (const [fiber, lease] of leases) {
        if (!target(fiber) || plain(effectiveConfig(fiber)).searchTimeoutMs !== budgetMs) { leases.delete(fiber); continue; }
        // A later unrelated author edit is retained, and only our live field is restored.
        const raw = 'effectiveConfig' in fiber ? fiber.config : fiber.entry.options.config ?? lease.raw;
        await refresh(fiber, raw);
        leases.delete(fiber);
      }
    },
    snapshot: () => ({ budgetMs, owned: leases.size, releasing }),
  };
  return controller;
}
