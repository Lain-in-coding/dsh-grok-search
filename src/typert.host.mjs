import { SETTINGS_DESCRIPTORS } from './core/settings-contract.mjs';
import { COMPATIBILITY_DESCRIPTORS } from './core/compatibility-contract.mjs';

const invocations = Object.freeze([...SETTINGS_DESCRIPTORS, ...COMPATIBILITY_DESCRIPTORS]);

export const TYPERT = Object.freeze({
  package: 'dsh-grok-search',
  face: 'host',
  schemas: [],
  invocations,
  model: Object.freeze({ services: [], events: [], objects: [] }),
});

export default TYPERT;

export function clientContribution() {
  return Object.freeze({
    package: 'dsh-grok-search',
    descriptors: invocations.map(descriptor => Object.freeze({
      id: descriptor.id,
      service: descriptor.service,
      namespace: descriptor.namespace,
      method: descriptor.method,
      description: descriptor.description,
      invocation: descriptor.invocation,
      parameters: descriptor.parameters,
      result: descriptor.result,
    })),
  });
}
