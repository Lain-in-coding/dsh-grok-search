import { readFileSync } from 'node:fs';
import { validateCommitMessage } from './lib/commit-message.mjs';

const path = process.argv[2];
if (!path || process.argv.length !== 3) throw new Error('用法：node scripts/check-commit-message.mjs <提交信息文件>');
const errors = validateCommitMessage(readFileSync(path, 'utf8'));
if (errors.length) { for (const error of errors) console.error(error); process.exitCode = 1; }
else console.log('提交信息格式与中文摘要检查通过。');
