import { isDeepStrictEqual } from 'node:util';
import { effectiveConfig } from './product-control.mjs';
import { resolveRuntimeConfig } from './product-config.mjs';

const TOOL_MODULE = '@deepseek-ai/dsh-tool-web';
const unwrap = item => typeof item?.get === 'function' ? item.get() : item;
const plain = value => Object.fromEntries(Object.entries(value ?? {})
  .map(([key, item]) => [key, unwrap(item)]));
const target = fiber => fiber?.uid != null && fiber?.runtime?.name === 'tool-web'
  && fiber.entry?.options?.name === TOOL_MODULE && fiber.entry.options.disabled !== true;

/** Check budget candidates without leasing, enabling tools, or publishing effective config. */
export function checkToolBudgetContracts(ctx, budgetMs) {
  let checked = 0;
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers) {
      if (!target(fiber)) continue;
      const effective = effectiveConfig(fiber);
      if (unwrap(effective?.search) === false) continue;
      const currentEffective = plain(effective);
      const before = structuredClone(currentEffective);
      const rawConfig = () => 'effectiveConfig' in fiber ? fiber.config
        : fiber.entry.options.config ?? effectiveConfig(fiber);
      const raw = structuredClone(plain(rawConfig()));
      if (typeof fiber.update !== 'function' || typeof fiber.await !== 'function'
        || !fiber.runtime.Config) throw Object.assign(new Error('Search budget configuration cannot be validated.'), {
        code: 'COMPATIBILITY_BUDGET_UNCONFIRMED',
      });
      // Candidate normalization must not share nested values with live config or its snapshots.
      const candidate = plain(resolveRuntimeConfig(fiber.runtime, { ...structuredClone(before), searchTimeoutMs: budgetMs }));
      if (candidate.searchTimeoutMs !== budgetMs || candidate.search !== before.search
        || candidate.fetch !== before.fetch || candidate.fetchTimeoutMs !== before.fetchTimeoutMs
        || !isDeepStrictEqual(before, structuredClone(plain(effectiveConfig(fiber))))
        || !isDeepStrictEqual(raw, structuredClone(plain(rawConfig())))) {
        throw Object.assign(new Error('The host does not preserve the search budget candidate contract.'), {
          code: 'COMPATIBILITY_BUDGET_UNCONFIRMED',
        });
      }
      checked++;
    }
  }
  return Object.freeze({ checked });
}

/** Runtime-only leases; never edit a profile, enable a tool or patch a method. */
export function createToolBudgetController({ ctx, budgetMs, required, canLease = () => true,
  resolveConfig = resolveRuntimeConfig, onError = () => {} }) {
  const leases = new Map(), own = new Set(), yielded = new WeakSet();
  let releasing = false, serial = Promise.resolve();
  const hook = function (input, next) {
    const modern = typeof input?.resolveConfig === 'function';
    const fiber = modern ? input : this;
    const value = next();
    if (!target(fiber) || releasing || !required() || !canLease() || yielded.has(fiber) || unwrap(value?.search) === false) return value;
    const lease = leases.get(fiber);
    // Active candidate resolution may be a validation-only call. Return the
    // author's candidate; yield ownership only if internal/update commits it.
    if (lease && !own.has(fiber) && fiber.state === 2) return value;
    if (!lease) leases.set(fiber, { raw: structuredClone(plain(modern ? fiber.config : input)),
      before: unwrap(value?.searchTimeoutMs) });
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
  const verifyLease = fiber => {
    if (yielded.has(fiber) || !canLease() || releasing) return;
    if (!target(fiber)) { leases.delete(fiber); return; }
    const effective = effectiveConfig(fiber);
    if (unwrap(effective?.search) === false) { leases.delete(fiber); return; }
    if (fiber.state !== 2 || unwrap(effective?.searchTimeoutMs) !== budgetMs) {
      throw Object.assign(new Error('The host did not apply the search budget lease.'), {
        code: 'COMPATIBILITY_BUDGET_UNCONFIRMED',
      });
    }
  };
  const acquire = async () => {
    for (const runtime of ctx.registry.values()) {
      for (const fiber of [...runtime.fibers]) {
        if (!target(fiber) || yielded.has(fiber) || !required() || !canLease() || releasing) continue;
        const effective = effectiveConfig(fiber);
        if (unwrap(effective?.search) === false) continue;
        const raw = 'effectiveConfig' in fiber ? fiber.config : fiber.entry.options.config ?? plain(effective);
        await refresh(fiber, raw);
        verifyLease(fiber);
      }
    }
  };
  ctx.on('internal/config', hook, { global: true, prepend: true });
  ctx.on('internal/update', updateHook, { global: true, prepend: true });
  ctx.on('internal/plugin', fiber => { if (fiber.uid === null) leases.delete(fiber); }, { global: true });
  const controller = {
    acquire() {
      // A failed refresh must not poison later attempts. Keep its rejected tail
      // observable by release() and the caller; the next acquire recovers it.
      const attempt = serial.then(acquire, acquire);
      serial = attempt;
      attempt.catch(() => {});
      return attempt;
    },
    async release() {
      releasing = true;
      await serial.catch(onError);
      for (const [fiber, lease] of leases) {
        if (!target(fiber)) { leases.delete(fiber); continue; }
        const effective = effectiveConfig(fiber);
        if (unwrap(effective?.search) === false || unwrap(effective?.searchTimeoutMs) !== budgetMs) { leases.delete(fiber); continue; }
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
