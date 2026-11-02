import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommitMessage } from '../scripts/lib/commit-message.mjs';

test('规范英文 type/scope 和中文摘要、正文可通过', () => {
  assert.deepEqual(validateCommitMessage('feat(provider): 接入 Grok 查询核心\n\n保留官方工具和抓取配置。\n验证：核心测试通过。'), []);
  assert.deepEqual(validateCommitMessage('fix(runtime)!: 更换控制记录格式\n\nBREAKING CHANGE: 旧记录需在加载时迁移。'), []);
});
test('英文摘要、非法格式、混入 AI 署名均拒绝', () => {
  for (const value of ['feat: add search', 'changed: 修改配置', 'feat(中文): 添加查询', 'fix: 修复查询\n没有空行', 'fix: 修复查询\n\nCo-authored-by: Codex <codex@openai.com>']) {
    assert.ok(validateCommitMessage(value).length > 0, value);
  }
});

test('中文正文允许技术名与引用 footer，拒绝纯英文自然语言段落', () => {
  assert.deepEqual(validateCommitMessage('fix(core): 修复预算边界\n\n使用 MCP Client 保留查询来源。\n\nRefs: #12'), []);
  assert.deepEqual(validateCommitMessage('test(core): 补充取消验证\n\n验证命令：\n```powershell\nnode --test test/provider-core.test.mjs\n```'), []);
  assert.ok(validateCommitMessage('fix(core): 修复预算边界\n\nFix the off by one error in JSON serialization.').length > 0);
  assert.ok(validateCommitMessage('fix(core): 修复预算边界\n\n修复精确边界。\n\nAdd more English descriptions.').length > 0);
});
