import { AsyncLocalStorage } from 'node:async_hooks';
import { isIP } from 'node:net';
import { GrokSearchError } from './errors.mjs';

const PROXY_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'x-real-ip', 'true-client-ip', 'cf-connecting-ip'];
const loopback = address => {
  if (typeof address !== 'string') return false;
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
  return isIP(ipv4) === 4 && Number(ipv4.split('.')[0]) === 127;
};
const deny = (code, message) => { throw new GrokSearchError(code, message); };

// This plugin-local ALS stores immutable socket facts, never keys or a shared
// "secure" bit on browserPeer. A missing HTTP scope fails closed, including
// in-process, websocket or any future carrier with no raw connection proof.
export function createConnectionSecurity() {
  const storage = new AsyncLocalStorage();
  let disposed = false;
  const requireOwner = ctx => {
    if (disposed) deny('SETTINGS_UNAVAILABLE', '插件设置已卸载，请重新启用插件。');
    if (ctx?.invocation?.peer?.principal?.kind !== 'owner') {
      deny('SETTINGS_AUTH_REQUIRED', '当前请求未通过宿主身份验证。');
    }
    ctx.invocation.signal?.throwIfAborted();
  };
  const capabilities = ctx => {
    requireOwner(ctx);
    const current = storage.getStore();
    const secure = current?.encrypted === true;
    const local = current?.loopback === true && current?.proxyHeaders === false;
    return { secretsAllowed: secure || local, transport: secure ? 'https' : local ? 'loopback' : 'restricted',
      reason: secure || local ? null : '请通过本机直连或 HTTPS 查看和保存 Key；远程 HTTP 只显示脱敏状态。' };
  };
  return Object.freeze({
    run(request, _response, next) {
      if (disposed) return next();
      const socket = request?.socket;
      const headers = request?.headers ?? {};
      const facts = Object.freeze({
        encrypted: socket?.encrypted === true,
        loopback: loopback(socket?.remoteAddress) && loopback(socket?.localAddress),
        proxyHeaders: PROXY_HEADERS.some(key => Object.hasOwn(headers, key)),
      });
      return storage.run(facts, next);
    },
    capabilities, requireOwner,
    requireSecret(ctx) {
      if (!capabilities(ctx).secretsAllowed) {
        deny('SETTINGS_SECURE_CONNECTION_REQUIRED', '请通过本机直连或 HTTPS 查看和保存 Key。');
      }
    },
    dispose() { disposed = true; storage.disable(); },
  });
}
