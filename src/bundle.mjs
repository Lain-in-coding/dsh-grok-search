import { composeEntries, readProfilePatches } from '@deepseek-ai/dsh-app-boot';
import * as core from './index.mjs';
import * as control from './control.mjs';
import * as recovery from './recovery.mjs';
import * as routeVerifier from './route-verifier.mjs';
import * as settings from './settings-ui.mjs';
import * as program from './program.mjs';
import { createOriginalSearchCounter } from './core/original-search-counter.mjs';
import { createProductStore, normalizeCounterSnapshot, readSelection, PRODUCT_SEARCH_BUNDLE, PRODUCT_PROVIDER_ID }
  from './core/product-control.mjs';
import { createConnectionSecurity } from './core/connection-security.mjs';
import { createPrivatePreferences } from './core/private-preferences.mjs';
import { join } from 'node:path';

export const name = 'dsh-grok-search';
export const inject = ['loader', 'profileContext'];
export const Config = core.Config;
export const ENTRY_ID = 'grok-search';

// The root deliberately does not depend on web. Its scoped config hook survives
// a WebRuntime rebuild and leaves a missing/unavailable Grok provider fail-closed.
export async function apply(ctx, configuration) {
  const store = createProductStore(ctx);
  const preferences = createPrivatePreferences({
    path: join(ctx.profileContext.dir, 'grok-search', 'preferences.json'),
  });
  ctx.provide('grokSearchPreferences', preferences);
  const connectionSecurity = createConnectionSecurity();
  ctx.provide('grokSearchConnectionSecurity', connectionSecurity);
  // Direct Typert calls are ordinary HTTP requests. Keep the raw socket facts
  // in a plugin-local async scope so settings code can never trust browser
  // headers or a client supplied "secure" flag.
  ctx.on('connection/request', function (request, response, next) {
    return connectionSecurity.run(request, response, next);
  }, { global: true, prepend: true });
  ctx.effect(() => () => connectionSecurity.dispose());
  let releaseTask = null;
  const existingCounter = ctx.get('grokSearchOriginalSearchCounter');
  const counter = existingCounter ?? createOriginalSearchCounter(ctx, { holdUntil: () => releaseTask });
  let disabling = false;
  const rootFiber = ctx.fiber;
  const rootEntry = rootFiber.entry;
  // A host-provided counter may report only `{ calls }`; the release receipt is
  // persisted, so every snapshot is normalized to a complete JSON-safe shape.
  const snapshotCounter = () => normalizeCounterSnapshot(
    typeof counter === 'function' ? counter() : counter.snapshot(), 'host-counter');
  const backgroundError = error => ctx.logger?.error?.(error);
  ctx.on('internal/config', function(_raw, next) {
    const value = next();
    if (disabling || this.entry?.options.id !== 'web'
      || this.entry.options.name !== '@deepseek-ai/dsh-web'
      || this.parent?.fiber?.entry === this.entry) return value;
    // Read failures cannot authorize an official fallback.
    let required = true;
    try { required = store.read()?.intent.policy !== 'released'; }
    catch (error) { backgroundError(error); }
    return required ? { ...value, searchProvider: PRODUCT_PROVIDER_ID } : value;
  }, { global: true, prepend: true });

  const explicitDisableReason = () => {
    if (!readSelection(ctx).bundles.includes(PRODUCT_SEARCH_BUNDLE)) return 'native-bundle-disable';
    const desired = composeEntries([readProfilePatches('dsh', ctx.profileContext)])
      .find(row => row.id === ENTRY_ID);
    // HMR can transiently mark a dropped entry disabled. Require a persisted
    // component choice too; ordinary dispose/restart must never grant release.
    if (desired?.disabled === true && rootEntry?.options.disabled === true) return 'native-component-disable';
    return null;
  };
  ctx.on('internal/plugin', fiber => {
    if (fiber !== rootFiber || fiber.uid !== null) return;
    let reason;
    try { reason = explicitDisableReason(); }
    catch (error) { backgroundError(error); return; }
    if (!reason) return;
    disabling = true;
    const owner = ctx.get('grokSearchControl');
    if (!owner) return;
    releaseTask = owner.stop(reason, { unloading: true });
    // An incomplete release resolves (the record intent is already durable),
    // so surface only its stable code; never the route, config or key values.
    releaseTask.then(outcome => {
      if (outcome?.kind === 'released' || outcome?.kind === 'already-released') return;
      ctx.logger?.warn?.('dsh-grok-search release incomplete: %s',
        outcome?.error?.code ?? outcome?.kind ?? 'unknown');
    }, backgroundError);
  }, { global: true, prepend: true });
  // Host teardown awaits this disposer, including the route/completion work.
  // Observers and child effects are still removed by their owning fiber.
  ctx.effect(() => async () => {
    try { if (releaseTask) await releaseTask; }
    finally { if (!existingCounter) counter.dispose(); }
  });
  await ctx.plugin(program, configuration);
  await Promise.all([
    ctx.plugin(routeVerifier, { counter }),
    ctx.plugin(recovery),
    ctx.plugin(core, configuration),
    ctx.plugin(control, { counterSnapshot: snapshotCounter }),
    ctx.plugin(settings),
  ]);
}
