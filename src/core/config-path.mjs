import { posix, win32 } from 'node:path';
import { homedir } from 'node:os';
import { GrokSearchError } from './errors.mjs';

function normalizeWindowsPath(value) {
  if (typeof value !== 'string') return value;
  const msys = /^\/(?:mnt\/|cygdrive\/)?([A-Za-z])\/(.*)$/.exec(value);
  if (msys) return `${msys[1].toUpperCase()}:\\${msys[2].replaceAll('/', '\\')}`;
  return value.replace(/\//g, '\\');
}

export function resolveSharedConfigPath({ override, env = process.env, platform = process.platform } = {}) {
  const value = name => Object.entries(env)
    .find(([key]) => platform === 'win32' ? key.toUpperCase() === name : key === name)?.[1];
  const pathApi = platform === 'win32' ? win32 : posix;
  const normalize = pathApi === win32 ? normalizeWindowsPath : value => value;
  const home = normalize(value('HOME') || value('USERPROFILE') || homedir());
  const path = normalize(override || value('GROK_SEARCH_CONFIG')
    || pathApi.join(home, '.config/grok-search-rs/config.toml'));
  if (typeof path !== 'string' || !pathApi.isAbsolute(path) || path.includes('\0')) {
    throw new GrokSearchError('CONFIG_PATH_INVALID', '配置文件必须使用绝对路径。');
  }
  return path;
}
