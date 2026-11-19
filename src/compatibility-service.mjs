import { GrokSearchError } from './core/errors.mjs';
import {
  COMPATIBILITY_DESCRIPTORS, COMPATIBILITY_NAMESPACE, COMPATIBILITY_REMOTE_SERVICE, COMPATIBILITY_REPORT,
} from './core/compatibility-contract.mjs';

export { COMPATIBILITY_DESCRIPTORS } from './core/compatibility-contract.mjs';
export const name = 'dsh-grok-search-compatibility-service';
export const inject = ['grokSearchCompatibility', 'grokSearchConnectionSecurity'];
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';
const publicCodes = new Set([
  'COMPATIBILITY_UNAVAILABLE', 'COMPATIBILITY_RECHECK_FAILED',
  'COMPATIBILITY_REQUEST_INVALID', 'COMPATIBILITY_REPORT_INVALID',
  'COMPATIBILITY_PAIR_MISMATCH', 'COMPATIBILITY_IDENTITY_UNKNOWN', 'COMPATIBILITY_CONFLICT',
  'COMPATIBILITY_STATE_PATH_INVALID', 'COMPATIBILITY_STATE_PATH_UNSAFE', 'COMPATIBILITY_STATE_INVALID',
  'COMPATIBILITY_STATE_READ_FAILED', 'COMPATIBILITY_STATE_WRITE_FAILED', 'COMPATIBILITY_STATE_BUSY',
  'COMPATIBILITY_STATE_FULL', 'COMPATIBILITY_STATE_UNAVAILABLE', 'COMPATIBILITY_STATE_COMMIT_UNCERTAIN',
  'SETTINGS_AUTH_REQUIRED', 'SETTINGS_SECURE_CONNECTION_REQUIRED', 'SETTINGS_UNAVAILABLE',
]);
const fail = code => { throw new GrokSearchError(code, 'Compatibility operation is unavailable or requires a fresh report.'); };

export function createCompatibilityGateway({ Service, RemoteError }) {
  if (typeof Service !== 'function' || typeof RemoteError !== 'function') {
    throw new TypeError('Real host Service and RemoteError constructors are required.');
  }
  const mutate = async (self, method, request) => {
    self._secure();
    if (typeof self.coordinator?.report !== 'function' || typeof self.coordinator?.[method] !== 'function') {
      fail('COMPATIBILITY_UNAVAILABLE');
    }
    const before = await self.coordinator.report();
    if (!COMPATIBILITY_REPORT.create().safeParse(before).success) fail('COMPATIBILITY_REPORT_INVALID');
    if (before.hostVersion === null || before.pluginVersion === null) fail('COMPATIBILITY_IDENTITY_UNKNOWN');
    if (before.hostVersion !== request.hostVersion || before.pluginVersion !== request.pluginVersion) {
      fail('COMPATIBILITY_PAIR_MISMATCH');
    }
    if (before.revision === null || before.revision !== request.expectedRevision) fail('COMPATIBILITY_CONFLICT');
    self._secure();
    await self.coordinator[method](request);
    self._owner();
    return self.coordinator.report();
  };
  class CompatibilityGateway extends Service {
    static provide = COMPATIBILITY_REMOTE_SERVICE;

    constructor(ctx) {
      super(ctx, COMPATIBILITY_REMOTE_SERVICE);
      this.typertRemote = Object.freeze({
        service: this, serviceKey: COMPATIBILITY_REMOTE_SERVICE, namespace: COMPATIBILITY_NAMESPACE,
      });
      this.coordinator = ctx.get?.('grokSearchCompatibility') ?? null;
      this.security = ctx.get?.('grokSearchConnectionSecurity') ?? null;
      this.disposed = false;
      ctx.effect?.(() => () => { this.disposed = true; });
    }

    _owner() {
      if (this.disposed) fail('COMPATIBILITY_UNAVAILABLE');
      if (!this.security?.requireOwner) fail('SETTINGS_SECURE_CONNECTION_REQUIRED');
      this.security.requireOwner(this.ctx);
    }

    _secure() {
      this._owner();
      if (!this.security?.requireSecret) fail('SETTINGS_SECURE_CONNECTION_REQUIRED');
      this.security.requireSecret(this.ctx);
    }

    async compatibilityReport() {
      if (typeof this.coordinator?.report !== 'function') fail('COMPATIBILITY_UNAVAILABLE');
      return this.coordinator.report();
    }

    async recheckCompatibility() {
      this._secure();
      if (typeof this.coordinator?.recheck !== 'function') fail('COMPATIBILITY_UNAVAILABLE');
      await this.coordinator.recheck();
      this._owner();
      return this.coordinator.report();
    }

    async confirmCompatibility(request) {
      return mutate(this, 'confirm', request);
    }

    async acknowledgeCompatibilityNotice(request) {
      return mutate(this, 'acknowledgeNotice', request);
    }
  }

  for (const descriptor of COMPATIBILITY_DESCRIPTORS) {
    const implementation = CompatibilityGateway.prototype[descriptor.method];
    const parameters = descriptor.parameters.map(parameter => parameter.codec.create());
    const result = descriptor.result.create();
    const invoke = async (self, args) => {
      try {
        self._owner();
        if (parameters.some((parser, index) => !parser.safeParse(args[index]).success)) fail('COMPATIBILITY_REQUEST_INVALID');
        const value = await implementation.apply(self, args);
        self._owner();
        if (!result.safeParse(value).success) fail('COMPATIBILITY_REPORT_INVALID');
        return value;
      } catch (error) {
        if (self.ctx.invocation?.signal?.aborted) throw self.ctx.invocation.signal.reason;
        const code = error instanceof GrokSearchError && publicCodes.has(error.code)
          ? error.code : 'COMPATIBILITY_OPERATION_FAILED';
        throw new RemoteError(code, 'Compatibility operation failed; refresh the report and check its status code.', {});
      }
    };
    Object.defineProperty(CompatibilityGateway.prototype, descriptor.method, {
      configurable: true, writable: true,
      // Keep named SRC parameters usable when a host retains older Typert data.
      value: parameters.length ? async function (request) { return invoke(this, [request]); }
        : async function () { return invoke(this, []); },
    });
  }
  Object.defineProperty(CompatibilityGateway.prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(COMPATIBILITY_DESCRIPTORS.map(descriptor => Object.freeze({
        method: descriptor.method, invocation: descriptor.invocation,
      }))),
    }),
  });
  return CompatibilityGateway;
}

export async function apply(ctx) {
  // Missing host peers belong to the optional-module boundary, never a fake Service.
  const { Service } = await import('@deepseek-ai/cordis');
  const { RemoteError } = await import('@deepseek-ai/dsh-typert-protocol');
  await ctx.plugin(createCompatibilityGateway({ Service, RemoteError }));
}
