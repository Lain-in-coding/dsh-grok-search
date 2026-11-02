import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { GrokSearchError } from './errors.mjs';

export function resolveSharedConfigPath({ override, env = process.env, platform = process.platform } = {}) {
  const value = name => Object.entries(env)
    .find(([key]) => platform === 'win32' ? key.toUpperCase() === name : key === name)?.[1];
  const path = override || value('GROK_SEARCH_CONFIG')
    || join(value('HOME') || value('USERPROFILE') || homedir(), '.config/grok-search-rs/config.toml');
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw new GrokSearchError('CONFIG_PATH_INVALID', '配置文件必须使用绝对路径。');
  }
  return path;
}
