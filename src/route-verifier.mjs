import { randomUUID } from 'node:crypto';
import { ControlRecordError } from './core/control-intent-store.mjs';
import { createOriginalSearchCounter } from './core/original-search-counter.mjs';
import {
  PRODUCT_SEARCH_BUNDLE, PRODUCT_RECOVERY_BUNDLE,
  authorFetchProvider, authorSearchProvider, dependenciesPreserved, routeReceipt, webEntry,
} from './core/product-control.mjs';

export const name = 'dsh-grok-search-route-verifier';
export const inject = ['loader', 'profileContext'];
export const ROUTE_COUNTER_SERVICE = 'grokSearchOriginalSearchCounter';

export function apply(ctx, { counter: suppliedCounter = null } = {}) {
  const loadId = randomUUID();
  const injectSnapshot = structuredClone(webEntry(ctx).options.inject ?? null);
  const hostCounter = ctx.get(ROUTE_COUNTER_SERVICE);
  const counter = hostCounter ?? suppliedCounter ?? createOriginalSearchCounter(ctx);
  if (!hostCounter) ctx.provide(ROUTE_COUNTER_SERVICE, counter);
  let disposed = false;
  const state = { phase: 'idle', loadId, lastReceipt: null, error: null };
  const snapshot = () => structuredClone(state);
  const verify = async observation => {
    if (disposed) throw new ControlRecordError('CONTROL_ROUTE_VERIFIER_DISPOSED');
    const expectedSearch = observation && Object.hasOwn(observation, 'authorSearchProvider')
      ? observation.authorSearchProvider : authorSearchProvider(ctx);
    const expectedFetch = observation && Object.hasOwn(observation, 'authorFetchProvider')
      ? observation.authorFetchProvider : authorFetchProvider(ctx);
    const expectedInject = observation?.authorInjectSha256 ?? null;
    const dependencies = expectedInject === null ? dependenciesPreserved(ctx, injectSnapshot) : null;
    const receipt = routeReceipt(ctx, { authorSearchProvider: expectedSearch,
      authorFetchProvider: expectedFetch, expectedInjectSha256: expectedInject,
      dependenciesPreserved: dependencies, routeChanged: observation?.routeChanged === true,
      counterBaseline: observation?.counterBaseline ?? null });
    state.lastReceipt = receipt;
    state.phase = 'verified';
    state.error = null;
    return receipt;
  };
  ctx.provide('grokSearchRouteVerifier', { snapshot, verify, loadId, productBundle: PRODUCT_SEARCH_BUNDLE,
    recoveryBundle: PRODUCT_RECOVERY_BUNDLE });
  ctx.effect(() => () => {
    disposed = true;
    state.phase = 'disposed';
    if (!hostCounter && !suppliedCounter) counter.dispose?.();
  });
}
