import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtempTracked as mkdtempSync } from './helpers/temp-fixture.mjs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runMcpSearch, executionEnvironment } from '../src/core/mcp-search.mjs';
import { GrokSearchError } from '../src/core/errors.mjs';
import { createGrokProvider } from '../src/provider.mjs';

// The installed, pinned product SDK is also a valid offline protocol runtime.
// A missing optional override must not silently skip the whole protocol gate.
const runtimeRoot = process.env.DSH_TEST_RUNTIME_ROOT ?? fileURLToPath(new URL('../', import.meta.url));
const realSdk = () => import(pathToFileURL(join(runtimeRoot, 'node_modules', '@modelcontextprotocol', 'client', 'dist', 'index.mjs')).href);
const fixture = fileURLToPath(new URL('../fixtures/mcp/grok-server.mjs', import.meta.url));
const sourceFixture = fileURLToPath(new URL('../fixtures/internal-candidate/mcp-sources.mjs', import.meta.url));
const executable = process.env.DSH_TEST_NODE ?? process.execPath;
const configPath = join(tmpdir(), 'dsh-internal-unread-config.toml');
const integration = test;
const options = (mode = 'structured', extra = {}) => {
  const deadline = performance.now() + 4_000;
  return { executable, executableArgs: [fixture, mode], configPath,
    request: { query: '中文协议查询🙂', maxResults: 5 }, remainingMs: () => deadline - performance.now(),
    sdkFactory: realSdk, envOverrides: { FIXTURE_EXPECT_CONFIG: configPath,
      ...(process.versions.electron && executable === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, ...extra };
};
function checkReaped(diagnostic) {
  assert.equal(diagnostic.exited, true);
  assert.ok(Number.isSafeInteger(diagnostic.childPid));
  assert.throws(() => process.kill(diagnostic.childPid, 0), error => error.code === 'ESRCH');
}

test('预先取消保留调用方原因且不加载 SDK', async () => {
  const reason = new Error('用户预先取消'); const controller = new AbortController(); controller.abort(reason);
  let loaded = false;
  await assert.rejects(runMcpSearch(options('structured', { signal: controller.signal, sdkFactory: () => { loaded = true; throw new Error('不应加载'); } })), error => error === reason);
  assert.equal(loaded, false);
});

test('SDK 加载阶段也受统一工作截止时间约束', async () => {
  const deadline = performance.now() + 30;
  await assert.rejects(runMcpSearch(options('structured', { remainingMs: () => deadline - performance.now(), sdkFactory: () => new Promise(() => {}) })), error => error.code === 'GROK_TIMEOUT' && error.diagnostic.childPid === null);
});

test('子进程只继承白名单，配置路径覆盖冲突环境项', () => {
  const original = process.env.INTERNAL_PARENT_SECRET;
  process.env.INTERNAL_PARENT_SECRET = '不应传递';
  try {
    const env = executionEnvironment({ GROK_SEARCH_CONFIG: '旧路径' }, configPath);
    assert.equal(env.INTERNAL_PARENT_SECRET, undefined);
    assert.equal(env.GROK_SEARCH_CONFIG, configPath);
  } finally { if (original === undefined) delete process.env.INTERNAL_PARENT_SECRET; else process.env.INTERNAL_PARENT_SECRET = original; }
});

const diagnosticOnlyEnvironment = {
  GROK_SEARCH_EXTRA_SOURCES: '0', GROK_SEARCH_FALLBACK_SOURCES: '0',
  TAVILY_ENABLED: 'false', EXA_ENABLED: 'false', TINYFISH_ENABLED: 'false', FIRECRAWL_ENABLED: 'false',
};
const normalEnvironment = {
  GROK_SEARCH_EXTRA_SOURCES: '3', GROK_SEARCH_FALLBACK_SOURCES: '5',
  TAVILY_ENABLED: 'true', EXA_ENABLED: 'true', TINYFISH_ENABLED: 'true', FIRECRAWL_ENABLED: 'true',
};
const parentFlags = () => Object.fromEntries(Object.keys(normalEnvironment).map(key => [key, process.env[key]]));
const exited = pid => assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');

test('独立 Grok 诊断只关闭本次进程的补充与回退，不修改调用方环境', async () => {
  const parent = parentFlags();
  const configured = options('diagnostic-environment');
  const envOverrides = Object.freeze({ ...configured.envOverrides, ...normalEnvironment,
    ...(process.platform === 'win32' ? { tavily_enabled: 'true' } : {}) });
  const result = await runMcpSearch({ ...configured, envOverrides,
    request: { ...configured.request, testPrimary: true } });
  assert.deepEqual(JSON.parse(result.content).diagnosticEnvironment, diagnosticOnlyEnvironment);
  assert.equal(envOverrides.TAVILY_ENABLED, 'true');
  assert.deepEqual(parentFlags(), parent);
  checkReaped(result.diagnostic);
});

test('诊断与正常搜索串行切换同一会话所有者，等待在途请求并恢复原补充设置', async () => {
  const parent = parentFlags();
  const directory = mkdtempSync(join(tmpdir(), 'dsh-primary-diagnostic-'));
  const selectedConfig = join(directory, 'config.toml');
  const config = 'default_extra_sources = 3\nfallback_sources = 5\ntavily_enabled = true\n';
  writeFileSync(selectedConfig, config);
  const configured = options('diagnostic-environment');
  const envOverrides = Object.freeze({ ...configured.envOverrides, ...normalEnvironment });
  const provider = createGrokProvider({
    configuration: { executable, executableArgs: [fixture, 'diagnostic-environment'],
      configPath: selectedConfig, envOverrides },
    sdkFactory: realSdk,
  });
  const query = (query, testPrimary = false, signal) => provider.provider.search({ query, testPrimary }, signal);
  try {
    const first = JSON.parse((await query('normal')).content);
    assert.deepEqual(first.diagnosticEnvironment, normalEnvironment);
    const pendingNormal = query('hold-before-diagnosis');
    const pendingDiagnostic = query('primary-only', true);
    const [normal, diagnostic] = await Promise.all([pendingNormal, pendingDiagnostic]);
    assert.equal(JSON.parse(normal.content).childPid, first.childPid, 'in-flight normal search is not restarted');
    const checked = JSON.parse(diagnostic.content);
    assert.deepEqual(checked.diagnosticEnvironment, diagnosticOnlyEnvironment);
    assert.notEqual(checked.childPid, first.childPid);
    exited(first.childPid);
    const repeated = JSON.parse((await query('another-primary-only', true)).content);
    assert.equal(repeated.childPid, checked.childPid, 'same diagnostic identity reuses the connection');
    const restored = JSON.parse((await query('normal-again')).content);
    assert.deepEqual(restored.diagnosticEnvironment, normalEnvironment);
    assert.notEqual(restored.childPid, checked.childPid);
    exited(checked.childPid);
    assert.equal(JSON.parse((await query('normal-reused')).content).childPid, restored.childPid);

    const held = query('hold-before-diagnosis');
    const controller = new AbortController(), reason = new Error('cancel queued diagnostic');
    const cancelled = query('cancelled-primary-only', true, controller.signal);
    const rejection = assert.rejects(cancelled, error => error === reason);
    controller.abort(reason);
    await rejection;
    assert.equal(JSON.parse((await held).content).childPid, restored.childPid);
    assert.equal(JSON.parse((await query('after-cancel')).content).childPid, restored.childPid,
      'cancelled queued diagnosis does not retire the normal connection');
    assert.equal(readFileSync(selectedConfig, 'utf8'), config);
    assert.equal(envOverrides.GROK_SEARCH_FALLBACK_SOURCES, '5');
    assert.deepEqual(parentFlags(), parent);
  } finally { await provider.dispose(); }
  assert.equal(provider.snapshot().session.connected, false);
});

for (const mode of ['structured', 'text-json', 'fragmented', 'coalesced', 'fallback', 'stderr', 'ignore-eof']) {
  integration(`真实 SDK：${mode} 响应与进程回收`, async () => {
    const result = await runMcpSearch(options(mode));
    const content = JSON.parse(result.content);
    assert.equal(content.query, '中文协议查询🙂');
    assert.equal(content.initialized, true);
    assert.equal(content.configSelected, true);
    assert.equal(result.sources.length, 1);
    assert.equal(result.diagnostic.serverVersion, '0.1.26-fixture');
    assert.equal(result.diagnostic.fallbackUsed, mode === 'fallback');
    if (mode === 'stderr') assert.ok(result.diagnostic.stderrBytes > 200_000);
    assert.ok(!JSON.stringify(result).includes('never-retain-this-secret'));
    checkReaped(result.diagnostic);
  });
}
for (const provider of ['tavily', 'exa', 'tinyfish', 'firecrawl']) {
  integration(`真实 SDK：内部 ${provider} 回退保留非枚举来源标签与脱敏归属`, async () => {
    const result = await runMcpSearch(options('attribution-' + provider));
    assert.equal(result.sources[0].provider, `${provider}_fallback`);
    assert.deepEqual(result.diagnostic.sourceProvenance, {
      resultProviders: [provider], resultProvidersComplete: true,
      fallbackProviders: [provider], enrichmentProviders: [],
    });
    assert.doesNotMatch(JSON.stringify(result), /_fallback|sourceProvenance|provider/);
    checkReaped(result.diagnostic);
  });
}
for (const [mode, code] of [['empty-sources', 'grok_sources_empty'],
  ['invalid-sources', 'grok_sources_empty'], ['long-sources', 'OUTPUT_LIMIT']]) {
  integration(`真实 SDK：${mode} 不把无可核验引用的结果当成功`, async () => {
    for (const testPrimary of [false, true]) {
      const configured = options(mode, { maxChars: 100 });
      await assert.rejects(runMcpSearch({ ...configured,
        request: { ...configured.request, testPrimary } }), error => {
        assert.equal(error.code, code);
        checkReaped(error.diagnostic);
        return true;
      });
    }
  });
}
integration('真实 SDK：主动要求零条引用仍保留成功语义', async () => {
  const configured = options('structured');
  const result = await runMcpSearch({ ...configured, request: { ...configured.request, maxResults: 0 } });
  assert.deepEqual(result.sources, []);
  assert.equal(JSON.parse(result.content).initialized, true);
  checkReaped(result.diagnostic);
});
for (const [mode, code] of [
  ['init-error', 'GROK_MCP_ERROR'], ['init-empty-spoof', 'GROK_MCP_ERROR'],
  ['rpc-error', 'GROK_MCP_ERROR'], ['tool-error', 'GROK_TOOL_ERROR'],
  ['rpc-empty-sources', 'grok_sources_empty'], ['rpc-empty-budget', 'grok_sources_empty'],
  ['rpc-empty-auth', 'grok_auth_error'], ['rpc-empty-unknown', 'GROK_MCP_ERROR'],
  ['rpc-empty-spoof', 'GROK_MCP_ERROR'], ['rpc-empty-wrong-code', 'GROK_MCP_ERROR'],
  ['rpc-empty-no-prefix', 'GROK_MCP_ERROR'],
  ['malformed-result', 'GROK_INVALID_RESULT'], ['init-exit', 'GROK_CHILD_EXIT'], ['call-exit', 'GROK_CHILD_EXIT'],
  ['stdout-limit', 'GROK_STDOUT_LIMIT'], ['invalid-frame', 'GROK_PROTOCOL_ERROR'], ['invalid-json', 'GROK_PROTOCOL_ERROR'],
]) {
  integration(`真实 SDK：${mode} 明确报错并回收`, async () => {
    await assert.rejects(runMcpSearch(options(mode, { maxMessageBytes: 16_384 })), error => {
      assert.equal(error.code, code);
      assert.ok(!String(error.stack).includes('never-retain-this-secret'));
      assert.ok(!JSON.stringify(error).includes('never-retain-this-secret'));
      checkReaped(error.diagnostic);
      return true;
    });
  });
}
for (const mode of ['init-hang', 'call-hang']) {
  integration(`真实 SDK：${mode} 总截止后回收`, async () => {
    const deadline = performance.now() + 200;
    await assert.rejects(runMcpSearch(options(mode, { remainingMs: () => deadline - performance.now() })), error => {
      assert.equal(error.code, 'GROK_TIMEOUT'); checkReaped(error.diagnostic); return true;
    });
  });
}
integration('真实 SDK：查询中取消保留原因并等待进程退出', async () => {
  const controller = new AbortController(); const reason = new Error('用户在运行中取消');
  const timer = setTimeout(() => controller.abort(reason), 300);
  try {
    await assert.rejects(runMcpSearch(options('cancel', { signal: controller.signal })), error => { assert.equal(error, reason); checkReaped(error.diagnostic); return true; });
  } finally { clearTimeout(timer); }
});
integration('真实 SDK：程序启动失败不留下未知进程', async () => {
  await assert.rejects(runMcpSearch(options('structured', { executable: join(tmpdir(), 'does-not-exist-dsh-grok.exe') })), error => error.code === 'GROK_PROCESS_ERROR' && error.diagnostic.exited && error.diagnostic.childPid === null);
});
for (const mode of ['sources', 'source-rpc-error', 'source-tool-error']) {
  integration(`真实 SDK：同进程来源补取 ${mode}`, async () => {
    const result = await runMcpSearch(options('structured', { executableArgs: [sourceFixture, mode] }));
    assert.equal(result.sources.length, mode === 'sources' ? 3 : 1);
    assert.equal(result.diagnostic.sourceRecovery, mode === 'sources' ? 'completed' : 'partial');
    assert.equal(result.truncated, true);
    checkReaped(result.diagnostic);
  });
}
integration('真实 SDK：来源补取中取消必须报错，不能返回部分成功', async () => {
  const controller = new AbortController(); const reason = new Error('补取中取消');
  const timer = setTimeout(() => controller.abort(reason), 300);
  try {
    await assert.rejects(runMcpSearch(options('structured', { executableArgs: [sourceFixture, 'source-hang'], signal: controller.signal })), error => { assert.equal(error, reason); checkReaped(error.diagnostic); return true; });
  } finally { clearTimeout(timer); }
});
integration('真实 SDK：分页补取来源标签进入同一结果，主搜引用和补充回退可同时确认', async () => {
  const result = await runMcpSearch(options('structured', { executableArgs: [sourceFixture, 'source-attribution'] }));
  assert.equal(result.diagnostic.sourceRecovery, 'completed');
  assert.deepEqual(result.sources.map(source => source.provider), ['grok_responses', 'tavily_fallback', 'tavily_fallback']);
  assert.deepEqual(result.diagnostic.sourceProvenance, {
    resultProviders: ['grok', 'tavily'], resultProvidersComplete: true,
    fallbackProviders: ['tavily'], enrichmentProviders: [],
  });
  assert.equal(result.diagnostic.fallbackUsed, true);
  assert.doesNotMatch(JSON.stringify(result), /provider|tavily_fallback/);
  checkReaped(result.diagnostic);
});
integration('真实 SDK：合并帧总量超过单消息上限时仍按各消息分别检查', async () => {
  const result = await runMcpSearch(options('structured', { executableArgs: [sourceFixture, 'large-coalesced'], maxMessageBytes: 2_048 }));
  assert.equal(result.sources.length, 1);
  assert.ok(result.diagnostic.stdoutBytes > 2_048);
  checkReaped(result.diagnostic);
});

const primaryData = (overrides = {}) => ({ schemaVersion: 1, provider: 'grok', protocol: 'responses',
  stage: 'response', httpStatus: 502, reason: 'upstream_error', ...overrides });
const primaryMessage = 'provider error: web_search returned no sources: grok_provider_error, and the fallback source budget is 0 (GROK_SEARCH_FALLBACK_SOURCES). never-retain-this-secret';
function primaryErrorOptions(data, { rpc = {}, ...extra } = {}) {
  const configured = options('primary-error', extra);
  return { ...configured, envOverrides: { ...configured.envOverrides,
    FIXTURE_RPC_ERROR: JSON.stringify({ code: -32001, message: primaryMessage, data, ...rpc }) } };
}
function checkSafeFailure(error) {
  assert.doesNotMatch(JSON.stringify([error, error.message, error.stack, error.diagnostic]), /never-retain-this-secret|Authorization|Bearer/);
  checkReaped(error.diagnostic);
}

integration('原请求 502 不被后续 doctor 404 替换，搜索与独立诊断都只发一次请求', async () => {
  for (const testPrimary of [false, true]) {
    const callsPath = join(mkdtempSync(join(tmpdir(), 'dsh-primary-error-')), 'calls.log');
    const configured = primaryErrorOptions(primaryData(), { request: { query: 'diagnosis', testPrimary } });
    await assert.rejects(runMcpSearch({ ...configured,
      envOverrides: { ...configured.envOverrides, FIXTURE_CALL_LOG: callsPath } }), error => {
      assert.equal(error.code, 'HTTP_502');
      assert.deepEqual(error.details, { ...primaryData(), evidence: 'primary-request' });
      checkSafeFailure(error);
      return true;
    });
    assert.equal(readFileSync(callsPath, 'utf8'), 'web_search\n');
  }
});

integration('旧后端缺少结构化诊断时保留通用错误且不追加请求', async () => {
  const callsPath = join(mkdtempSync(join(tmpdir(), 'dsh-legacy-error-')), 'calls.log');
  const configured = primaryErrorOptions(undefined, { request: { query: 'diagnosis', testPrimary: true } });
  await assert.rejects(runMcpSearch({ ...configured,
    envOverrides: { ...configured.envOverrides, FIXTURE_CALL_LOG: callsPath } }), error => {
    assert.equal(error.code, 'grok_provider_error');
    assert.equal(error.details, undefined);
    checkSafeFailure(error);
    return true;
  });
  assert.equal(readFileSync(callsPath, 'utf8'), 'web_search\n');
});

integration('结构化 404/422 使用原始原因和 HTTP 状态，界面文案不猜测路径或协议', async t => {
  for (const [overrides, message] of [
    [{ httpStatus: 404, reason: 'model_not_found', upstreamCode: 'model_not_found' }, /模型或路由不存在/],
    [{ protocol: 'chat_completions', httpStatus: 422, reason: 'tool_unsupported', upstreamCode: 'unsupported_tool' }, /不支持搜索工具/],
    [{ httpStatus: 422, reason: 'invalid_request', upstreamCode: 'invalid_request_error' }, /请求参数不受支持/],
    [{ httpStatus: 400, reason: 'invalid_request' }, /请求参数/],
    [{ httpStatus: 401, reason: 'auth_error', upstreamCode: 'invalid_api_key' }, /认证失败/],
    [{ httpStatus: 429, reason: 'rate_limited', upstreamCode: 'rate_limit_exceeded' }, /限流或额度/],
    [{ httpStatus: 401, reason: 'auth_error', upstreamCode: 'auth_error' }, /认证失败/],
    [{ httpStatus: 429, reason: 'rate_limited', upstreamCode: 'rate_limited' }, /限流或额度/],
    [{ httpStatus: 429, reason: 'rate_limited', upstreamCode: 'rate_limit_error' }, /限流或额度/],
    [{ httpStatus: 422, reason: 'tool_unsupported', upstreamCode: 'unsupported_tools' }, /不支持搜索工具/],
    [{ httpStatus: 599 }, /上游接口调用失败/],
  ]) await t.test(`${overrides.httpStatus} ${overrides.reason ?? 'upstream_error'}`, async () => {
    const data = primaryData(overrides);
    await assert.rejects(runMcpSearch(primaryErrorOptions(data)), error => {
      assert.equal(error.code, `HTTP_${data.httpStatus}`);
      assert.match(error.message, message);
      assert.doesNotMatch(error.message, /路径|协议/);
      assert.deepEqual(error.details, { ...data, evidence: 'primary-request' });
      checkSafeFailure(error);
      return true;
    });
  });
});

integration('结构化原因允许省略 HTTP 状态，四个阶段都只保留安全枚举', async t => {
  for (const [reason, stage, code, message] of [
    ['auth_error', 'request', 'grok_auth_error', /认证失败/],
    ['rate_limited', 'response', 'grok_provider_error', /限流/],
    ['model_not_found', 'response', 'grok_provider_error', /模型或路由/],
    ['tool_unsupported', 'response', 'grok_provider_error', /搜索工具/],
    ['invalid_request', 'request', 'grok_provider_error', /请求参数/],
    ['upstream_error', 'response', 'grok_provider_error', /上游接口/],
    ['network_error', 'request', 'GROK_NETWORK_ERROR', /网络/],
    ['timeout', 'request', 'grok_timeout', /超时/],
    ['parse_error', 'parse', 'grok_parse_error', /解析/],
    ['content_empty', 'result', 'grok_content_empty', /回答内容/],
    ['sources_empty', 'result', 'grok_sources_empty', /引用链接/],
  ]) await t.test(reason, async () => {
    const data = primaryData({ httpStatus: undefined, stage, reason });
    delete data.httpStatus;
    await assert.rejects(runMcpSearch(primaryErrorOptions(data)), error => {
      assert.equal(error.code, code);
      assert.match(error.message, message);
      assert.deepEqual(error.details, { ...data, evidence: 'primary-request' });
      checkSafeFailure(error);
      return true;
    });
  });
});

integration('HTTP 200 中的失败帧或无法解析的正文保留真实原因', async t => {
  for (const [reason, stage, code] of [
    ['parse_error', 'parse', 'grok_parse_error'],
    ['model_not_found', 'response', 'grok_provider_error'],
    ['network_error', 'response', 'GROK_NETWORK_ERROR'],
  ]) await t.test(reason, async () => {
    const data = primaryData({ httpStatus: 200, reason, stage });
    await assert.rejects(runMcpSearch(primaryErrorOptions(data)), error => {
      assert.equal(error.code, code);
      assert.deepEqual(error.details, { ...data, evidence: 'primary-request' });
      checkSafeFailure(error);
      return true;
    });
  });
});

integration('不完整、未知、伪造和夹带正文的 error.data 整体降级为旧错误', async t => {
  const invalid = [
    ['null', null], ['array', []], ['text', 'never-retain-this-secret'],
    ['version', primaryData({ schemaVersion: 2 })], ['string version', primaryData({ schemaVersion: '1' })],
    ['provider', primaryData({ provider: 'tavily' })], ['protocol', primaryData({ protocol: 'messages' })],
    ['stage', primaryData({ stage: 'doctor' })], ['reason', primaryData({ reason: 'never-retain-this-secret' })],
    ['prototype reason', primaryData({ reason: 'toString' })],
    ...[199, 600, 502.5, '502', null].map(httpStatus => [`status ${httpStatus}`, primaryData({ httpStatus })]),
    ...['never-retain-this-secret', 'toString', {}, null, 401].map((upstreamCode, index) => [`upstream code ${index}`, primaryData({ upstreamCode })]),
    ['raw body', primaryData({ body: 'Authorization: Bearer never-retain-this-secret' })],
    ['spoofed evidence', primaryData({ evidence: 'primary-request' })],
    ['nested data', { primary_failure: primaryData() }],
    ...['schemaVersion', 'provider', 'protocol', 'stage', 'reason'].map(field => {
      const data = primaryData(); delete data[field]; return [`missing ${field}`, data];
    }),
  ];
  for (const [name, data] of invalid) await t.test(name, async () => {
    await assert.rejects(runMcpSearch(primaryErrorOptions(data, { request: { query: 'diagnosis', testPrimary: true } })), error => {
      assert.equal(error.code, 'grok_provider_error');
      assert.equal(error.details, undefined);
      checkSafeFailure(error);
      return true;
    });
  });
});

integration('有效 data 也不能冒充其他 RPC code、未知原因或自由文本错误', async t => {
  for (const rpc of [
    { code: -32603 }, { message: 'Authorization: Bearer never-retain-this-secret' },
    { message: primaryMessage.replace('provider error: ', '') },
    { message: primaryMessage.replace('grok_provider_error', 'grok_future_reason') },
  ]) await t.test(JSON.stringify(rpc), async () => {
    await assert.rejects(runMcpSearch(primaryErrorOptions(primaryData(), { rpc })), error => {
      assert.equal(error.code, 'GROK_MCP_ERROR');
      assert.equal(error.details, undefined);
      checkSafeFailure(error);
      return true;
    });
  });
  await assert.rejects(runMcpSearch(primaryErrorOptions({ schemaVersion: 2 }, {
    rpc: { message: primaryMessage.replace('grok_provider_error', 'grok_auth_error') },
  })), error => error.code === 'grok_auth_error' && error.details === undefined);
});

integration('成功回退的 primary_failure 仅进入安全诊断，来源仍为实际回退供应商', async t => {
  for (const mode of ['primary-fallback', 'primary-fallback-text']) {
    for (const valid of [true, false]) await t.test(`${mode} valid=${valid}`, async () => {
      const data = primaryData({ httpStatus: 404, reason: 'model_not_found', upstreamCode: 'model_not_found',
        ...(valid ? {} : { body: 'never-retain-this-secret' }) });
      const configured = options(mode);
      const result = await runMcpSearch({ ...configured,
        envOverrides: { ...configured.envOverrides, FIXTURE_PRIMARY_FAILURE: JSON.stringify(data) } });
      assert.deepEqual(result.diagnostic.primaryFailure, valid ? { ...data, evidence: 'primary-request' } : undefined);
      assert.equal(result.diagnostic.fallbackReason, 'grok_provider_error');
      assert.equal(result.diagnostic.searchProvider, 'source_fallback');
      assert.equal(result.sources[0].provider, 'tavily_fallback');
      assert.deepEqual(result.diagnostic.sourceProvenance, { resultProviders: ['tavily'], resultProvidersComplete: true,
        fallbackProviders: ['tavily'], enrichmentProviders: [] });
      assert.doesNotMatch(JSON.stringify(result), /primary_failure|primaryFailure|schemaVersion/);
      assert.doesNotMatch(JSON.stringify([result, result.diagnostic]), /never-retain-this-secret/);
      checkReaped(result.diagnostic);
    });
  }
});

test('独立诊断取消优先于同时到达的结构化错误，且不发起 doctor', async () => {
  const controller = new AbortController(), reason = new Error('用户取消独立诊断');
  const calls = [];
  const connection = { client: {
    callTool: async request => {
      calls.push(request.name);
      controller.abort(reason);
      throw { code: -32001, message: primaryMessage, data: primaryData() };
    },
    close: async () => {},
  } };
  await assert.rejects(runMcpSearch(options('structured', { connection, signal: controller.signal,
    request: { query: 'diagnosis', testPrimary: true } })), error => error === reason);
  assert.deepEqual(calls, ['web_search']);
  assert.equal(reason.details, undefined);
});

test('关闭连接抛出普通异常时不覆盖主搜索错误，抛出 GROK_PROCESS_REAP_FAILED 时优先上报', async () => {
  const makeConnection = (callError, closeError) => ({
    client: {
      callTool: async () => { throw callError; },
      close: async () => {},
    },
    transport: {
      fatal: new Promise(() => {}),
      failure: null,
      diagnostic: () => ({ exited: closeError?.code !== 'GROK_PROCESS_REAP_FAILED', childPid: null, stdoutBytes: 0 }),
      close: async () => { if (closeError) throw closeError; },
    },
  });

  const primaryTimeout = new GrokSearchError('GROK_TIMEOUT', '主搜索超时');
  await assert.rejects(
    runMcpSearch(options('structured', {
      connection: makeConnection(primaryTimeout, new GrokSearchError('GROK_CLOSE_ERROR', '普通关闭失败')),
    })),
    error => error.code === 'GROK_TIMEOUT',
  );

  const reapFailed = new GrokSearchError('GROK_PROCESS_REAP_FAILED', '子进程未确认退出');
  await assert.rejects(
    runMcpSearch(options('structured', {
      connection: makeConnection(primaryTimeout, reapFailed),
    })),
    error => error === reapFailed && error.code === 'GROK_PROCESS_REAP_FAILED',
  );
});

test('transport.close 已确认子进程退出后 client.close 普通异常不抛出伪 GROK_CLOSE_ERROR', async () => {
  const connection = {
    client: {
      callTool: async () => ({
        isError: false,
        structuredContent: { content: '正常命中', sources: [{ url: 'https://example.invalid/ok', title: 'OK' }] },
      }),
      close: async () => { throw new Error('SDK client memory teardown warning'); },
    },
    transport: {
      fatal: new Promise(() => {}),
      failure: null,
      diagnostic: () => ({ exited: true, childPid: null, stdoutBytes: 64 }),
      close: async () => {},
    },
  };
  const result = await runMcpSearch(options('structured', { connection }));
  assert.equal(result.content, '正常命中');
  assert.equal(result.sources.length, 1);
});

test('client-only synthetic MCP connections retain primary errors across SDK cleanup failures', async t => {
  for (const code of ['GROK_TIMEOUT', 'grok_auth_error']) await t.test(code, async () => {
    const primary = new GrokSearchError(code, 'primary failure');
    let calls = 0, closes = 0;
    const connection = { client: {
      callTool() { calls++; throw primary; },
      async close() { closes++; throw new Error('synthetic SDK cleanup failure'); },
    } };
    await assert.rejects(runMcpSearch(options('structured', { connection })), error => error === primary);
    assert.equal(calls, 1);
    assert.equal(closes, 1);
  });
});

test('client-only synthetic MCP connections await asynchronous primary results', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const connection = { client: { callTool: () => pending, close: async () => {} } };
  const search = runMcpSearch(options('structured', { connection }));
  finish({ structuredContent: { content: 'synthetic answer', sources: [{ url: 'https://example.invalid/ok' }] } });
  const result = await search;
  assert.equal(result.content, 'synthetic answer');
  assert.equal(result.sources.length, 1);
});

test('synthetic SDK transport without optional diagnostics preserves the primary error', async () => {
  const primary = new GrokSearchError('GROK_TOOL_ERROR', 'synthetic primary failure');
  const connection = { client: { callTool: async () => { throw primary; }, close: async () => {} },
    transport: { close: async () => {} } };
  await assert.rejects(runMcpSearch(options('structured', { connection })), error => error === primary);
});

test('managed synthetic SDK setup preserves the primary error through owner retirement', async () => {
  const primary = new GrokSearchError('GROK_SDK_UNSUPPORTED', 'synthetic framing setup failed');
  let closes = 0;
  const core = createGrokProvider({ configuration: { executable, configPath }, sdkFactory: async () => ({
    Client: class { async close() { closes++; throw new Error('synthetic SDK cleanup failed'); } },
    ReadBuffer: class { constructor() { throw primary; } }, serializeMessage: () => '',
  }) });
  try {
    await assert.rejects(core.provider.search({ query: 'offline' }), error => error === primary);
    assert.equal(closes, 1);
    assert.equal(core.snapshot().session.faulted, false, 'no process was spawned');
  } finally { await core.dispose(); }
});


test('source recovery follows budget-trimmed pages until the requested limit', async () => {
  const calls = [];
  const connection = { client: { close: async () => {}, callTool: async input => {
    calls.push(input);
    if (input.name === 'web_search') return { structuredContent: { sources: [], sources_count: 4, session_id: 'paged' } };
    const offset = input.arguments.offset;
    return { content: [{ type: 'text', text: JSON.stringify({ session_id: 'paged', offset, sources_count: 1,
      total_sources: 4, next_offset: offset + 1, truncated: true,
      sources: [{ url: 'https://example.invalid/' + offset, provider: 'grok_responses' }] }) }] };
  } } };
  const result = await runMcpSearch(options('structured', { connection, request: { query: 'offline pages', maxResults: 3 } }));
  assert.deepEqual(result.sources.map(source => source.url), [0, 1, 2].map(index => 'https://example.invalid/' + index));
  assert.deepEqual(calls.slice(1).map(call => call.arguments), [0, 1, 2].map(offset => ({
    session_id: 'paged', offset, limit: 3 - offset,
  })));
  assert.equal(result.truncated, true);
  assert.equal(result.diagnostic.sourceRecovery, 'completed');
});

test('later recovery pages preserve cancellation and remote partial-failure semantics', async t => {
  for (const mode of ['cancel', 'timeout', 'remote-error']) await t.test(mode, async () => {
    const controller = new AbortController(), reason = mode === 'timeout'
      ? new GrokSearchError('GROK_TIMEOUT', 'synthetic timeout') : new Error('synthetic cancellation');
    let calls = 0;
    const connection = { client: { close: async () => {}, callTool: async input => {
      calls++;
      if (input.name === 'web_search') return { structuredContent: { sources: [], sources_count: 2, session_id: 'paged' } };
      if (input.arguments.offset === 0) return { structuredContent: { sources: [{ url: 'https://example.invalid/first' }],
        total_sources: 2, sources_count: 1, offset: 0, next_offset: 1 } };
      if (mode === 'remote-error') throw Object.assign(new Error('private remote body'), { code: -32001 });
      controller.abort(reason);
      return { structuredContent: { sources: [{ url: 'https://example.invalid/second' }] } };
    } } };
    const pending = runMcpSearch(options('structured', { connection, signal: controller.signal }));
    if (mode === 'remote-error') {
      const result = await pending;
      assert.equal(result.sources.length, 1);
      assert.equal(result.diagnostic.sourceRecovery, 'partial');
      assert.equal(result.truncated, true);
    } else await assert.rejects(pending, error => error === reason);
    assert.equal(calls, 3);
  });
});

test('source recovery rejects mismatched cursors and stops when a page cannot make progress', async t => {
  for (const extra of [{ next_offset: 0 }, { next_offset: 2 }, { offset: 7 }, { session_id: 'other' }, { next_offset: 'secret' }]) {
    await t.test(JSON.stringify(extra), async () => {
      const connection = { client: { close: async () => {}, callTool: async input => ({ structuredContent:
        input.name === 'web_search' ? { sources: [], sources_count: 3, session_id: 'paged' }
          : { sources: [{ url: 'https://example.invalid/first' }], ...extra } }) } };
      await assert.rejects(runMcpSearch(options('structured', { connection })), { code: 'GROK_INVALID_RESULT' });
    });
  }
  let calls = 0;
  const connection = { client: { close: async () => {}, callTool: async input => {
    calls++;
    return { structuredContent: input.name === 'web_search'
      ? { sources: [{ url: 'https://example.invalid/first' }], sources_count: 3, session_id: 'paged' }
      : { sources: [], offset: 1, next_offset: 1, total_sources: 3, truncated: true } };
  } } };
  const result = await runMcpSearch(options('structured', { connection }));
  assert.equal(calls, 2);
  assert.equal(result.diagnostic.sourceRecovery, 'partial');
});

test('MCP diagnostic labels reject unknown token-shaped remote values', async () => {
  const secret = 'TOKEN_SHAPED_PRIVATE_VALUE';
  const connection = { client: { close: async () => {}, callTool: async () => ({ structuredContent: {
    sources: [{ url: 'https://example.invalid/first' }], fallback_used: true,
    fallback_reason: secret, search_provider: secret,
  } }) } };
  const result = await runMcpSearch(options('structured', { connection }));
  assert.equal(result.diagnostic.fallbackUsed, true);
  assert.equal(result.diagnostic.fallbackReason, null);
  assert.equal(result.diagnostic.searchProvider, null);
  assert.doesNotMatch(JSON.stringify(result.diagnostic), /TOKEN_SHAPED_PRIVATE_VALUE/);
});

test('caller cancellation during MCP cleanup cannot return the completed result', async () => {
  const controller = new AbortController(), reason = new Error('synthetic cleanup cancellation');
  const connection = { client: {
    callTool: async () => ({ structuredContent: {
      content: 'completed before cancellation', sources: [{ url: 'https://example.invalid/result' }],
    } }),
    async close() { controller.abort(reason); },
  } };
  await assert.rejects(runMcpSearch(options('structured', { connection, signal: controller.signal })),
    failure => failure === reason);
});

integration('real SDK cleanup preserves caller cancellation after the child exit is proven', async () => {
  const controller = new AbortController(), reason = new Error('synthetic real SDK cleanup cancellation');
  const sdk = await realSdk();
  class CancelOnClose extends sdk.Client {
    async close() { controller.abort(reason); return super.close(); }
  }
  await assert.rejects(runMcpSearch(options('structured', { signal: controller.signal,
    sdkFactory: () => ({ ...sdk, Client: CancelOnClose }) })), failure => {
    assert.equal(failure, reason);
    checkReaped(failure.diagnostic);
    return true;
  });
});

test('MCP source recovery counts retained links when an initial page is unsafe or duplicated', async t => {
  for (const mode of ['unsafe', 'duplicate', 'output-budget']) await t.test(mode, async () => {
    const calls = [], first = { url: 'https://example.invalid/first', provider: 'grok_responses' };
    const initial = mode === 'unsafe' ? [{ url: 'javascript:private-upstream-data' }]
      : mode === 'duplicate' ? [first, first] : [{ url: 'https://example.invalid/' + 'x'.repeat(400) }];
    const connection = { client: { close: async () => {}, callTool: async input => {
      calls.push(input);
      if (input.name === 'web_search') return { structuredContent: {
        sources: initial, sources_count: initial.length + 1, session_id: 'filtered-page',
      } };
      return { structuredContent: { sources: [{ url: 'https://example.invalid/recovered', provider: 'tavily_fallback' }],
        session_id: 'filtered-page', total_sources: initial.length + 1, offset: initial.length, next_offset: null } };
    } } };
    const maxResults = mode === 'duplicate' ? 2 : 1;
    const result = await runMcpSearch(options('structured', { connection, maxChars: mode === 'output-budget' ? 120 : 45_000,
      request: { query: 'filtered pages', maxResults } }));
    assert.equal(result.sources.length, maxResults);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].arguments, { session_id: 'filtered-page', offset: initial.length, limit: 1 });
    assert.equal(result.sources.at(-1).url, 'https://example.invalid/recovered');
    assert.doesNotMatch(JSON.stringify(result), /private-upstream-data/);
  });
});

test('MCP source recovery keeps raw cursors after an unusable later page without losing retained provenance', async () => {
  const calls = [];
  const connection = { client: { close: async () => {}, callTool: async input => {
    calls.push(input);
    if (input.name === 'web_search') return { structuredContent: {
      sources: [], sources_count: 3, session_id: 'later-filtered-page',
    } };
    const offset = input.arguments.offset;
    return { structuredContent: { session_id: 'later-filtered-page', total_sources: 3, offset, next_offset: offset + 1,
      sources: [offset === 1 ? { url: 'javascript:discarded-page' }
        : { url: `https://example.invalid/${offset}`, provider: offset === 0 ? 'grok_responses' : 'exa_fallback' }] } };
  } } };
  const result = await runMcpSearch(options('structured', { connection, request: { query: 'later filtered page', maxResults: 2 } }));
  assert.deepEqual(calls.slice(1).map(input => [input.arguments.offset, input.arguments.limit]),
    [[0, 2], [1, 1], [2, 1]]);
  assert.deepEqual(result.sources.map(source => [source.url, source.provider]),
    [['https://example.invalid/0', 'grok_responses'], ['https://example.invalid/2', 'exa_fallback']]);
  assert.doesNotMatch(JSON.stringify(result), /provider|discarded-page/);
});
