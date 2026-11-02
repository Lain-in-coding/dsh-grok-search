import { SETTINGS_DESCRIPTORS } from './settings-ui.mjs';

const invocations = SETTINGS_DESCRIPTORS;

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
