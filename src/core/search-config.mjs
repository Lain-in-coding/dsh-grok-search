import { CONFIG_FIELDS } from './shared-config.mjs';

// Internal-only metadata: a host request cannot supply this through JSON.
export const SEARCH_EXECUTION = Symbol('dsh.search.execution');
export const SEARCH_SNAPSHOT = Symbol('dsh.search.snapshot');
export const SEARCH_DIAGNOSTIC = Symbol('dsh.search.diagnostic');

export function searchConfigValues(value) {
  const fields = value?.effective ?? value?.fields ?? value ?? {};
  return Object.fromEntries(Object.entries(fields).map(([key, item]) => [
    key, structuredClone(item && typeof item === 'object' && Object.hasOwn(item, 'value') ? item.value : item),
  ]));
}

export function capturedExecution(value, config) {
  if (!value?.execution) return undefined;
  const execution = structuredClone(value.execution);
  execution.envOverrides = { ...execution.envOverrides };
  for (const [key, spec] of Object.entries(CONFIG_FIELDS)) {
    if (Object.hasOwn(config, key)) execution.envOverrides[spec.env] =
      Array.isArray(config[key]) ? config[key].join(',') : String(config[key]);
  }
  execution.expectedConfigRevision = value.snapshot?.revision;
  return execution;
}
