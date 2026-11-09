import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runMcpSearch, executionEnvironment } from '../src/core/mcp-search.mjs';
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

for (const [mode, code] of [
  ['doctor-structured', 'HTTP_401'], ['doctor-text', 'HTTP_401'],
  ['doctor-spoof', 'grok_provider_error'], ['doctor-reachable', 'grok_provider_error'],
  ['doctor-unsupported', 'grok_provider_error'],
]) {
  integration(`Grok 诊断补查：${mode} 只保留可确认状态，不泄漏上游正文`, async () => {
    await assert.rejects(runMcpSearch(options(mode, { request: { query: 'diagnosis', testPrimary: true } })), error => {
      assert.equal(error.code, code);
      assert.equal(error.details?.httpStatus, code === 'HTTP_401' ? 401 : undefined);
      assert.equal(error.details?.evidence, code === 'HTTP_401' ? 'primary-doctor' : undefined);
      assert.equal(JSON.stringify(error).includes('never-retain-this-secret'), false);
      assert.equal(String(error.stack).includes('never-retain-this-secret'), false);
      checkReaped(error.diagnostic);
      return true;
    });
  });
}

integration('真实搜索不补发 doctor 请求替换原始错误', async () => {
  await assert.rejects(runMcpSearch(options('doctor-structured')), error => {
    assert.equal(error.code, 'grok_provider_error');
    assert.equal(error.details?.evidence, undefined);
    checkReaped(error.diagnostic);
    return true;
  });
});

integration('Grok 诊断补查挂起仍受原总截止限制，并确认进程退出', async () => {
  const deadline = performance.now() + 400;
  await assert.rejects(runMcpSearch(options('doctor-hang', {
    request: { query: 'diagnosis', testPrimary: true }, remainingMs: () => deadline - performance.now(),
  })), error => {
    assert.equal(error.code, 'GROK_TIMEOUT');
    checkReaped(error.diagnostic);
    return true;
  });
});
