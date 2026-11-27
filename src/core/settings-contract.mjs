import { createSettingsCodec as codec } from './settings-codec.mjs';
import { MAX_SEARCH_QUERY_CHARS } from './search-query.mjs';

export const REMOTE_SERVICE = 'grokSearchSettings';

const errorSchema = {
  type: 'object',
  properties: { code: { type: ['string', 'null'] }, message: { type: 'string' } },
  required: ['code', 'message'],
  additionalProperties: false,
};
const nullableError = { anyOf: [errorSchema, { type: 'null' }] };
const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const configIdentityProperties = {
  expectedRevision: { type: 'string' },
  configIdentity: { type: 'string', minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' },
};
const capabilitiesSchema = {
  type: 'object',
  properties: {
    secretsAllowed: { type: 'boolean' },
    transport: { type: 'string' },
    reason: nullableString,
  },
  required: ['secretsAllowed', 'transport', 'reason'],
  additionalProperties: false,
};
const configSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    displayPath: { type: 'string' },
    exists: { type: 'boolean' },
    revision: { type: 'string' },
    quotaRevision: { type: 'string' },
    fields: { type: 'object', additionalProperties: true },
    unknownFields: { type: 'array', items: { type: 'string' } },
    error: nullableError,
  },
  required: ['path', 'exists', 'revision', 'fields', 'unknownFields'],
  additionalProperties: false,
};
const programSchema = {
  anyOf: [
    { type: 'null' },
    {
      type: 'object',
      properties: {
        phase: { type: 'string' },
        program: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
        configPath: nullableString,
        error: nullableError,
        canRepair: { type: 'boolean' },
        configuration: { type: 'object', additionalProperties: true },
      },
      required: ['phase', 'program', 'configPath', 'error'],
      additionalProperties: false,
    },
  ],
};
const controlSchema = {
  type: 'object',
  properties: {
    available: { type: 'boolean' },
    phase: { type: 'string' },
    policy: nullableString,
    revision: { type: 'number' },
    canStop: { type: 'boolean' },
    completionCommitted: { type: 'boolean' },
    routeVerified: { type: 'boolean' },
    routeChanged: { type: 'boolean' },
    releaseOperationId: nullableString,
    error: nullableError,
  },
  required: [
    'available', 'phase', 'policy', 'revision', 'canStop', 'completionCommitted',
    'routeVerified', 'routeChanged', 'releaseOperationId', 'error',
  ],
  additionalProperties: false,
};
// Final route of the latest real search: stable codes and provider ids only.
const routeSchema = {
  anyOf: [
    { type: 'null' },
    {
      type: 'object',
      properties: {
        at: { type: 'number' },
        origin: { type: 'string' },
        outcome: { type: 'string' },
        served: nullableString,
        grokCode: nullableString,
        fallbackUsed: { type: 'boolean' },
        resultProviders: { type: 'array', items: { type: 'string' } },
        resultProvidersComplete: { type: 'boolean' },
        provenance: { type: 'string' },
        code: { type: 'string' },
        failures: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['at', 'origin', 'outcome', 'served', 'grokCode', 'fallbackUsed', 'failures'],
      additionalProperties: false,
    },
  ],
};
const pluginSchema = {
  type: 'object',
  properties: {
    budgetMs: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    programConfigured: { type: 'boolean' },
    configSource: { type: 'string' },
  },
  required: ['budgetMs', 'programConfigured', 'configSource'],
  additionalProperties: false,
};
const snapshotJsonSchema = {
  type: 'object',
  properties: {
    control: controlSchema,
    program: programSchema,
    config: configSchema,
    capabilities: capabilitiesSchema,
    route: routeSchema,
    plugin: pluginSchema,
    available: { type: 'boolean' },
    phase: { type: 'string' },
    policy: nullableString,
    revision: { type: 'number' },
    canStop: { type: 'boolean' },
    completionCommitted: { type: 'boolean' },
    routeVerified: { type: 'boolean' },
    routeChanged: { type: 'boolean' },
    releaseOperationId: nullableString,
    error: nullableError,
  },
  required: ['control', 'program', 'config', 'capabilities', 'available', 'phase', 'policy', 'revision',
    'canStop', 'completionCommitted', 'routeVerified', 'routeChanged', 'releaseOperationId', 'error'],
  additionalProperties: false,
};
const saveJsonSchema = {
  type: 'object',
  properties: { config: configSchema },
  required: ['config'],
  additionalProperties: false,
};
const revealJsonSchema = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    value: { type: 'string' },
    source: { type: 'string' },
    readOnly: { type: 'boolean' },
  },
  required: ['key', 'value', 'source', 'readOnly'],
  additionalProperties: false,
};
const prepareJsonSchema = {
  type: 'object',
  properties: {
    phase: { type: 'string' },
    program: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
    configPath: nullableString,
    error: nullableError,
    canRepair: { type: 'boolean' },
    configuration: { type: 'object', additionalProperties: true },
  },
  required: ['phase', 'program', 'configPath', 'error'],
  additionalProperties: false,
};
const openJsonSchema = {
  type: 'object',
  properties: { path: { type: 'string' }, displayPath: { type: 'string' }, opened: { type: 'boolean' },
    exists: { type: 'boolean' }, kind: { type: 'string' } },
  required: ['path', 'opened'],
  additionalProperties: false,
};
const diagnosticsSchema = {
  type: 'array',
  items: { type: 'object', additionalProperties: true },
};
const providerDiagnosisSchema = {
  type: 'object',
  properties: {
    provider: { type: 'string' },
    status: { type: 'string' },
    code: { type: 'string' },
    message: { type: 'string' },
    elapsedMs: { type: 'number' },
    keys: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  required: ['provider', 'status', 'code', 'message'],
  additionalProperties: true,
};
const testSearchSchema = {
  type: 'object',
  properties: {
    sources: { type: 'array', items: { type: 'object', additionalProperties: true } },
    fallbackUsed: { type: 'boolean' },
    provider: nullableString,
  },
  required: ['sources', 'fallbackUsed', 'provider'],
  additionalProperties: false,
};
const preferenceValueSchema = {
  type: 'object',
  properties: { sidebarShortcutEnabled: { type: 'boolean' } },
  additionalProperties: true,
};
const preferencesSchema = {
  type: 'object',
  properties: {
    value: preferenceValueSchema,
    revision: { type: 'string' },
  },
  required: ['value', 'revision'],
  additionalProperties: false,
};
const stopJsonSchema = {
  type: 'object',
  properties: {
    outcome: { type: 'object', additionalProperties: true },
    snapshot: controlSchema,
  },
  required: ['outcome', 'snapshot'],
  additionalProperties: false,
};

export const SETTINGS_DESCRIPTORS = [
  {
    id: 'dsh-grok-search#grokSearchSettings/openSearchLog',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'openSearchLog',
    description: 'Open a bounded server-issued secure history view.',
    invocation: { kind: 'direct' }, parameters: [],
    result: codec('dsh-grok-search/settings#OpenSearchLogResult', {
      type: 'object', properties: { sessionId: { type: 'string' } },
      required: ['sessionId'], additionalProperties: false,
    }),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/previewGithubConnection',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'previewGithubConnection',
    description: 'Test the current GitHub token draft and a public resource without saving credentials or consent.',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec('dsh-grok-search/settings#GithubPreviewRequest', {
      type: 'object', properties: { token: { type: 'string' }, expectedRevision: { type: 'string' },
        configIdentity: { type: 'string' }, operationId: { type: 'string' } },
      required: ['expectedRevision', 'configIdentity', 'operationId'], additionalProperties: false,
    }) }],
    result: codec('dsh-grok-search/settings#GithubPreviewResult', providerDiagnosisSchema),
  },
  ...['readSearchLog', 'clearSearchLog', 'closeSearchLog'].map(method => ({
    id: `dsh-grok-search#grokSearchSettings/${method}`,
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method,
    description: 'Read or clear plugin-owned volatile search history, or close only this secure view.',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json',
      codec: codec(`dsh-grok-search/settings#${method}Request`, {
        type: 'object', properties: { sessionId: { type: 'string' } },
        required: ['sessionId'], additionalProperties: false,
      }) }],
    result: codec(`dsh-grok-search/settings#${method}Result`, {
      type: 'object', properties: {
        records: { type: 'array', items: { type: 'object', additionalProperties: true } },
        closed: { type: 'boolean' },
      }, additionalProperties: false,
    }),
  })),
  {
    id: 'dsh-grok-search#grokSearchSettings/toolCallTrace',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'toolCallTrace',
    description: 'Read bounded provider attempt states and timings for an exact call; no query, response or credentials.',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json',
      codec: codec('dsh-grok-search/settings#ToolCallTraceRequest', {
        type: 'object', properties: { sessionId: { type: 'string' }, callId: { type: 'string' } },
        required: ['sessionId', 'callId'], additionalProperties: false,
      }) }],
    result: codec('dsh-grok-search/settings#ToolCallTraceResult', {
      type: 'object', properties: {
        known: { type: 'boolean' }, state: { type: 'string' }, toolName: { type: 'string' },
        at: { type: 'number' }, elapsedMs: { type: ['number', 'null'] }, routesComplete: { type: 'boolean' },
        routes: { type: 'array', maxItems: 16, items: { type: 'object', properties: {
          served: { type: ['string', 'null'] }, outcome: { type: 'string' },
          fallbackUsed: { type: 'boolean' }, code: { type: 'string' },
          resultProviders: { type: 'array', items: { type: 'string' } }, resultProvidersComplete: { type: 'boolean' },
          index: { type: 'number' }, phase: { type: 'string' }, at: { type: 'number' }, elapsedMs: { type: ['number', 'null'] },
          callsComplete: { type: 'boolean' }, callsTruncated: { type: 'boolean' },
          planned: { type: 'array', items: { type: 'string' } },
          calls: { type: 'array', maxItems: 16, items: { type: 'object', properties: {
            provider: { type: 'string' }, result: { type: 'string' }, code: { type: 'string' },
            keyIndex: { type: ['number', 'null'] }, operation: { type: 'string' }, evidence: { type: 'string' },
            at: { type: 'number' }, elapsedMs: { type: ['number', 'null'] },
          }, required: ['provider', 'result', 'code', 'keyIndex', 'operation', 'evidence', 'at', 'elapsedMs'], additionalProperties: false } },
        }, required: ['served', 'outcome', 'fallbackUsed', 'code', 'index', 'phase', 'at', 'elapsedMs', 'callsComplete', 'callsTruncated', 'calls', 'planned'],
        additionalProperties: false } },
      }, required: ['known', 'state', 'routes'], additionalProperties: false,
    }),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/toolCallRoute',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'toolCallRoute',
    description: 'Return the exact recorded routes for one session tool call; no query text or credentials.',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json',
      codec: codec('dsh-grok-search/settings#ToolCallRouteRequest', {
        type: 'object', properties: { sessionId: { type: 'string' }, callId: { type: 'string' } },
        required: ['sessionId', 'callId'], additionalProperties: false,
      }) }],
    result: codec('dsh-grok-search/settings#ToolCallRouteResult', {
      type: 'object', properties: {
        known: { type: 'boolean' },
        state: { type: 'string' },
        routes: { type: 'array', items: { type: 'object', properties: {
          served: { type: ['string', 'null'] }, outcome: { type: 'string' },
          fallbackUsed: { type: 'boolean' }, code: { type: 'string' },
          resultProviders: { type: 'array', items: { type: 'string' } },
          resultProvidersComplete: { type: 'boolean' },
        }, required: ['served', 'outcome', 'fallbackUsed', 'code'], additionalProperties: false } },
        // Present (false) only when the call made more searches than recorded routes.
        routesComplete: { type: 'boolean' },
      }, required: ['known', 'state', 'routes'], additionalProperties: false,
    }),
  },
  ...['accountQuota', 'previewAccountQuota'].map(method => ({
    id: `dsh-grok-search#grokSearchSettings/${method}`,
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method,
    description: 'Query a saved account or a transient form draft without saving or returning credentials.',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json',
      codec: codec('dsh-grok-search/settings#AccountQuotaRequest', {
        type: 'object', properties: { provider: { type: 'string' }, keyIndex: { type: 'number' },
          expectedRevision: { type: 'string' }, operationId: { type: 'string' }, quotaRevision: { type: 'string' },
          draft: { type: 'object', properties: { baseUrl: { type: 'string' }, apiKey: { type: 'string' } },
            additionalProperties: false } },
        required: ['provider', 'expectedRevision', 'operationId', 'quotaRevision'], additionalProperties: false,
      }) }],
    result: codec('dsh-grok-search/settings#AccountQuotaResult', {
      type: 'object', properties: { supported: { type: 'boolean' },
        value: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] } },
      required: ['supported', 'value'], additionalProperties: false,
    }),
  })),
  {
    id: 'dsh-grok-search#grokSearchSettings/snapshot',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'snapshot',
    description: 'Read redacted Grok shared configuration and current takeover state.',
    invocation: { kind: 'direct' }, parameters: [],
    result: codec('dsh-grok-search/settings#Snapshot', snapshotJsonSchema),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/save',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'save',
    description: 'Save validated changes to the shared Grok configuration with CAS.',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request', wire: 'request', source: 'json',
      codec: codec('dsh-grok-search/settings#SaveRequest', {
        type: 'object',
        properties: { expectedRevision: { type: 'string' }, updates: { type: 'object', additionalProperties: true } },
        required: ['expectedRevision', 'updates'], additionalProperties: false,
      }),
    }],
    result: codec('dsh-grok-search/settings#SaveResult', saveJsonSchema),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/saveWithIdentity',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'saveWithIdentity',
    description: 'Save shared configuration only while its file revision and effective configuration identity still match.',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request', wire: 'request', source: 'json',
      codec: codec('dsh-grok-search/settings#SaveWithIdentityRequest', {
        type: 'object',
        properties: {
          ...configIdentityProperties,
          updates: { type: 'object', additionalProperties: true },
        },
        required: ['expectedRevision', 'configIdentity', 'updates'], additionalProperties: false,
      }),
    }],
    result: codec('dsh-grok-search/settings#SaveResult', saveJsonSchema),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/restoreConfig',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'restoreConfig',
    description: 'Restore one verified configuration history revision with CAS over a secure connection.',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request', wire: 'request', source: 'json',
      codec: codec('dsh-grok-search/settings#RestoreRequest', {
        type: 'object',
        properties: { expectedRevision: { type: 'string' }, revision: { type: 'string' } },
        required: ['expectedRevision', 'revision'], additionalProperties: false,
      }),
    }],
    result: codec('dsh-grok-search/settings#RestoreResult', saveJsonSchema),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/restoreConfigWithIdentity',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'restoreConfigWithIdentity',
    description: 'Restore verified configuration history only for the exact saved target and effective identity.',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request', wire: 'request', source: 'json',
      codec: codec('dsh-grok-search/settings#RestoreWithIdentityRequest', {
        type: 'object',
        properties: { ...configIdentityProperties, revision: { type: 'string' } },
        required: ['expectedRevision', 'configIdentity', 'revision'], additionalProperties: false,
      }),
    }],
    result: codec('dsh-grok-search/settings#RestoreResult', saveJsonSchema),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/reveal',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'reveal',
    description: 'Explicitly reveal one credential over an authenticated secure connection.',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request', wire: 'request', source: 'json',
      codec: codec('dsh-grok-search/settings#RevealRequest', {
        type: 'object', properties: { key: { type: 'string' } },
        required: ['key'], additionalProperties: false,
      }),
    }],
    result: codec('dsh-grok-search/settings#RevealResult', revealJsonSchema),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/revealWithIdentity',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'revealWithIdentity',
    description: 'Reveal one credential only from the configuration target and effective identity the user viewed.',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request', wire: 'request', source: 'json',
      codec: codec('dsh-grok-search/settings#RevealWithIdentityRequest', {
        type: 'object',
        properties: { ...configIdentityProperties, key: { type: 'string' } },
        required: ['expectedRevision', 'configIdentity', 'key'], additionalProperties: false,
      }),
    }],
    result: codec('dsh-grok-search/settings#RevealResult', revealJsonSchema),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/prepareProgram',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'prepareProgram',
    description: 'Discover or prepare the verified private Grok program.',
    invocation: { kind: 'direct' }, parameters: [],
    result: codec('dsh-grok-search/settings#PrepareResult', prepareJsonSchema),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/repairProgram',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'repairProgram',
    description: 'Explicitly repair damaged private program content using a verified version.',
    invocation: { kind: 'direct' }, parameters: [],
    result: codec('dsh-grok-search/settings#PrepareResult', prepareJsonSchema),
  },
  ...['openConfigLocation', 'openConfigLocationWithStatus'].map(method => ({
    id: `dsh-grok-search#grokSearchSettings/${method}`,
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method,
    description: 'Open the shared Grok configuration file or its folder on the local host.',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request', wire: 'request', source: 'json',
      codec: codec('dsh-grok-search/settings#OpenConfigRequest', {
        type: 'object', properties: { kind: { type: 'string' } },
        required: [], additionalProperties: false,
      }),
    }],
    // Keep the old response exact: older hosts may retain its strict codec.
    result: method === 'openConfigLocation'
      ? codec('dsh-grok-search/settings#OpenConfigResult', openJsonSchema)
      : codec('dsh-grok-search/settings#OpenConfigStatusResult', { ...openJsonSchema,
        properties: { ...openJsonSchema.properties, editor: nullableString, fallbackReason: nullableString,
          copyOnly: { type: 'boolean' } } }),
  })),
  {
    id: 'dsh-grok-search#grokSearchSettings/diagnose',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'diagnose',
    description: 'Check every enabled source and every configured key without exposing secrets.',
    invocation: { kind: 'direct' }, parameters: [],
    result: codec('dsh-grok-search/settings#DiagnosticsResult', diagnosticsSchema),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/diagnoseProvider',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'diagnoseProvider',
    description: 'Check one search engine or source (every configured key) with a real request.',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request', wire: 'request', source: 'json',
      codec: codec('dsh-grok-search/settings#DiagnoseProviderRequest', {
        type: 'object', properties: { provider: { type: 'string' }, operationId: { type: 'string' },
          expectedRevision: { type: 'string' }, configIdentity: { type: 'string' } },
        required: ['provider'], additionalProperties: false,
      }),
    }],
    result: codec('dsh-grok-search/settings#ProviderDiagnosis', providerDiagnosisSchema),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/cancelDiagnosis',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'cancelDiagnosis',
    description: 'Cancel only a settings diagnosis owned by this plugin; accepted requests may still be billed upstream.',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request', wire: 'request', source: 'json',
      codec: codec('dsh-grok-search/settings#CancelDiagnosisRequest', {
        type: 'object', properties: { operationId: { type: 'string' } },
        required: ['operationId'], additionalProperties: false,
      }),
    }],
    result: codec('dsh-grok-search/settings#CancelDiagnosisResult', {
      type: 'object', properties: { cancelled: { type: 'boolean' } },
      required: ['cancelled'], additionalProperties: false,
    }),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/testSearch',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'testSearch',
    description: 'Run a real test search and report fallback metadata.',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request', wire: 'request', source: 'json',
      codec: codec('dsh-grok-search/settings#TestSearchRequest', {
        type: 'object', properties: { query: { type: 'string', maxLength: MAX_SEARCH_QUERY_CHARS } },
        required: ['query'], additionalProperties: false,
      }),
    }],
    result: codec('dsh-grok-search/settings#TestSearchResult', testSearchSchema),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/preferences',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'preferences',
    description: 'Read plugin-private route preferences.',
    invocation: { kind: 'direct' }, parameters: [],
    result: codec('dsh-grok-search/settings#PreferencesResult', preferencesSchema),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/savePreferences',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'savePreferences',
    description: 'Save plugin-private route preferences with CAS.',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request', wire: 'request', source: 'json',
      codec: codec('dsh-grok-search/settings#SavePreferencesRequest', {
        type: 'object',
        properties: { expectedRevision: { type: 'string' }, value: preferenceValueSchema },
        required: ['expectedRevision', 'value'], additionalProperties: false,
      }),
    }],
    result: codec('dsh-grok-search/settings#SavePreferencesResult', preferencesSchema),
  },
  // Kept as a compatibility endpoint for older clients. The new UI never
  // renders a separate "stop takeover" action; the native plugin switch is
  // the only user-facing stop control.
  {
    id: 'dsh-grok-search#grokSearchSettings/retryControlRelease',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'retryControlRelease',
    description: 'Retry only a previously requested incomplete release, or read the unchanged current state.',
    invocation: { kind: 'direct' }, parameters: [],
    result: codec('dsh-grok-search/settings#ControlRetryResult', snapshotJsonSchema),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/stop',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'stop',
    description: 'Compatibility endpoint for older clients; native switch is preferred.',
    invocation: { kind: 'direct' }, parameters: [],
    result: codec('dsh-grok-search/settings#StopResult', stopJsonSchema),
  },
];

