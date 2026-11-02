const TYPES = new Set(['feat', 'fix', 'docs', 'refactor', 'test', 'build', 'ci', 'chore', 'perf', 'style', 'revert']);

// 格式检查不代替对中文表述、改动归属和验证证据的人工审查。
export function validateCommitMessage(message) {
  const errors = [];
  if (typeof message !== 'string') return ['提交信息必须是文本。'];
  const lines = message.replaceAll('\r\n', '\n').trimEnd().split('\n');
  const header = lines[0] ?? '';
  const match = /^(?<type>[a-z]+)(?:\((?<scope>[a-z][a-z0-9./-]*)\))?(?<breaking>!)?: (?<description>\S.*)$/.exec(header);
  if (!match || !TYPES.has(match.groups.type)) errors.push('标题必须符合 Conventional Commits，使用规范英文 type 和可选英文 scope。');
  if (match && !/\p{Script=Han}/u.test(match.groups.description)) errors.push('提交摘要必须使用中文说明。');
  if (Array.from(header).length > 100) errors.push('提交标题最多 100 个字符。');
  if (lines.length > 1 && lines[1] !== '') errors.push('标题与正文之间必须空一行。');
  if (/^(?:Co-authored-by|Signed-off-by):.*(?:openai|codex|claude|agent|gpt|ai\b)/im.test(message)
    || /^Generated with/im.test(message)) errors.push('不得添加 AI 署名。');
  // 自然语言正文按段检查；规范引用 footer、命令和代码块保留原样。
  let inCode = false;
  const prose = [];
  for (const line of lines.slice(2)) {
    if (/^\s*```/.test(line)) { inCode = !inCode; prose.push(''); continue; }
    if (inCode || /^(?:Refs|Fixes|Closes|Resolves):\s*(?:#\d+|https?:\/\/\S+)/.test(line)) { prose.push(''); continue; }
    prose.push(line);
  }
  for (const paragraph of prose.join('\n').split(/\n\s*\n/)) {
    if (/[A-Za-z]/.test(paragraph) && !/\p{Script=Han}/u.test(paragraph)) {
      errors.push('提交正文的自然语言段落必须使用中文；技术名称、命令和规范 footer 保持原样。'); break;
    }
  }
  if (/^BREAKING CHANGE:\s*(?!.*\p{Script=Han})\S/mu.test(message)) errors.push('破坏性变更说明必须使用中文。');
  return errors;
}
