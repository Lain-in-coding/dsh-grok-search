import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runMcpSearch, executionEnvironment } from '../src/core/mcp-search.mjs';

const runtimeRoot = process.env.DSH_TEST_RUNTIME_ROOT;
const realSdk = runtimeRoot ? () => import(pathToFileURL(join(runtimeRoot, 'node_modules', '@modelcontextprotocol', 'client', 'dist', 'index.mjs')).href) : undefined;
const fixture = fileURLToPath(new URL('../fixtures/mcp/grok-server.mjs', import.meta.url));
const sourceFixture = fileURLToPath(new URL('../fixtures/internal-candidate/mcp-sources.mjs', import.meta.url));
const executable = process.env.DSH_TEST_NODE ?? process.execPath;
const configPath = join(tmpdir(), 'dsh-internal-unread-config.toml');
const integration = runtimeRoot ? test : test.skip;
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
for (const [mode, code] of [
  ['init-error', 'GROK_MCP_ERROR'], ['rpc-error', 'GROK_MCP_ERROR'], ['tool-error', 'GROK_TOOL_ERROR'],
  ['malformed-result', 'GROK_INVALID_RESULT'], ['init-exit', 'GROK_CHILD_EXIT'], ['call-exit', 'GROK_CHILD_EXIT'],
  ['stdout-limit', 'GROK_STDOUT_LIMIT'], ['invalid-frame', 'GROK_PROTOCOL_ERROR'], ['invalid-json', 'GROK_PROTOCOL_ERROR'],
]) {
  integration(`真实 SDK：${mode} 明确报错并回收`, async () => {
    await assert.rejects(runMcpSearch(options(mode, { maxMessageBytes: 16_384 })), error => {
      assert.equal(error.code, code);
      assert.ok(!String(error.stack).includes('never-retain-this-secret'));
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
integration('真实 SDK：合并帧总量超过单消息上限时仍按各消息分别检查', async () => {
  const result = await runMcpSearch(options('structured', { executableArgs: [sourceFixture, 'large-coalesced'], maxMessageBytes: 2_048 }));
  assert.equal(result.sources.length, 1);
  assert.ok(result.diagnostic.stdoutBytes > 2_048);
  checkReaped(result.diagnostic);
});
