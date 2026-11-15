import { createSettingsCodec } from './settings-codec.mjs';

export const createCompatibilityCodec = createSettingsCodec;
export const COMPATIBILITY_REMOTE_SERVICE = 'grokSearchCompatibilityRemote';
export const COMPATIBILITY_NAMESPACE = 'grokSearchCompatibility';
export const COMPATIBILITY_PHASES = Object.freeze([
  'initial', 'checking', 'waiting-confirmation', 'ready', 'degraded', 'blocked', 'stopped',
]);
export const COMPATIBILITY_CHANNELS = Object.freeze(['stable', 'rc', 'alpha', 'beta', 'other', 'unknown']);

const integer = '(?:0|[1-9][0-9]*)';
const prerelease = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
export const COMPATIBILITY_VERSION_PATTERN = `^${integer}\\.${integer}\\.${integer}`
  + `(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?![\\s\\S])`;
const versionPattern = new RegExp(COMPATIBILITY_VERSION_PATTERN, 'u');
export const isCompatibilityVersion = value => typeof value === 'string'
  && value.length <= 128 && versionPattern.test(value);

const version = { type: 'string', minLength: 5, maxLength: 128, pattern: COMPATIBILITY_VERSION_PATTERN };
const nullableVersion = { anyOf: [version, { type: 'null' }] };
const revision = { type: 'string', maxLength: 64, pattern: '^(?:missing|[a-f0-9]{64})(?![\\s\\S])' };
const reasonCode = { type: ['string', 'null'], minLength: 1, maxLength: 80, pattern: '^[A-Z][A-Z0-9_]*(?![\\s\\S])' };
const optionalFeature = {
  type: 'object',
  properties: { available: { type: 'boolean' }, code: reasonCode },
  required: ['available', 'code'],
  additionalProperties: false,
};
const mutationProperties = { expectedRevision: revision, hostVersion: version, pluginVersion: version };
const mutationRequired = ['expectedRevision', 'hostVersion', 'pluginVersion'];

export const COMPATIBILITY_MUTATION_REQUEST = createCompatibilityCodec(
  'dsh-grok-search/compatibility#StateMutationRequest',
  { type: 'object', properties: mutationProperties, required: mutationRequired, additionalProperties: false },
);

export const COMPATIBILITY_CONFIRM_REQUEST = createCompatibilityCodec(
  'dsh-grok-search/compatibility#ConfirmRequest',
  {
    type: 'object',
    properties: { ...mutationProperties, acceptRisk: { type: 'boolean', enum: [true] } },
    required: [...mutationRequired, 'acceptRisk'],
    additionalProperties: false,
  },
);

export const COMPATIBILITY_ACKNOWLEDGE_REQUEST = createCompatibilityCodec(
  'dsh-grok-search/compatibility#AcknowledgeNoticeRequest',
  { type: 'object', properties: mutationProperties, required: mutationRequired, additionalProperties: false },
);

export const COMPATIBILITY_REPORT = createCompatibilityCodec(
  'dsh-grok-search/compatibility#Report',
  {
    type: 'object',
    properties: {
      schemaVersion: { type: 'integer', enum: [1] },
      hostVersion: nullableVersion,
      pluginVersion: nullableVersion,
      channel: { type: 'string', enum: [...COMPATIBILITY_CHANNELS] },
      minimumAdmitted: { type: 'boolean' },
      verification: { type: 'string', enum: ['unverified', 'verified'] },
      phase: { type: 'string', enum: [...COMPATIBILITY_PHASES] },
      revision: { anyOf: [revision, { type: 'null' }] },
      confirmationRequired: { type: 'boolean' },
      confirmed: { type: 'boolean' },
      notified: { type: 'boolean' },
      coreReady: { type: 'boolean' },
      code: reasonCode,
      optionalFeatures: {
        type: 'object',
        properties: { settings: optionalFeature, chat: optionalFeature, github: optionalFeature },
        required: ['settings', 'chat', 'github'],
        additionalProperties: false,
      },
    },
    required: [
      'schemaVersion', 'hostVersion', 'pluginVersion', 'channel', 'minimumAdmitted', 'verification',
      'phase', 'revision', 'confirmationRequired', 'confirmed', 'notified', 'coreReady', 'code',
      'optionalFeatures',
    ],
    additionalProperties: false,
  },
);

export const COMPATIBILITY_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: 'dsh-grok-search#grokSearchCompatibilityRemote/compatibilityReport',
    service: COMPATIBILITY_REMOTE_SERVICE,
    namespace: COMPATIBILITY_NAMESPACE,
    method: 'compatibilityReport',
    description: 'Read the current server-verified compatibility report without changing consent.',
    invocation: Object.freeze({ kind: 'direct' }),
    parameters: Object.freeze([]),
    result: COMPATIBILITY_REPORT,
  }),
  Object.freeze({
    id: 'dsh-grok-search#grokSearchCompatibilityRemote/confirmCompatibility',
    service: COMPATIBILITY_REMOTE_SERVICE,
    namespace: COMPATIBILITY_NAMESPACE,
    method: 'confirmCompatibility',
    description: 'Confirm risk for the exact current host and plugin versions without bypassing core safety.',
    invocation: Object.freeze({ kind: 'direct' }),
    parameters: Object.freeze([Object.freeze({
      name: 'request', wire: 'request', source: 'json', codec: COMPATIBILITY_CONFIRM_REQUEST,
    })]),
    result: COMPATIBILITY_REPORT,
  }),
  Object.freeze({
    id: 'dsh-grok-search#grokSearchCompatibilityRemote/acknowledgeCompatibilityNotice',
    service: COMPATIBILITY_REMOTE_SERVICE,
    namespace: COMPATIBILITY_NAMESPACE,
    method: 'acknowledgeCompatibilityNotice',
    description: 'Acknowledge the notice for the exact current host and plugin versions without granting consent.',
    invocation: Object.freeze({ kind: 'direct' }),
    parameters: Object.freeze([Object.freeze({
      name: 'request', wire: 'request', source: 'json', codec: COMPATIBILITY_ACKNOWLEDGE_REQUEST,
    })]),
    result: COMPATIBILITY_REPORT,
  }),
]);
