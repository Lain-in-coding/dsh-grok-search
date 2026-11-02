import { dirname, join, resolve } from 'node:path';
import { statSync, existsSync } from 'node:fs';
import { readAsar } from './asar.mjs';

export const CANDIDATE_VERSIONS = Object.freeze(['0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.3']);

// 独立于历史 M0 解析入口，不扩大旧探针的支持声明。
export function candidateRuntime(executablePath) {
  if (!executablePath) throw new Error('请用 --desktop 指定实际 Desktop 程序。');
  const executable = resolve(executablePath);
  if (!statSync(executable).isFile()) throw new Error('Desktop 路径不是文件。');
  const binaryDir = dirname(executable);
  const windowsArchive = join(binaryDir, 'resources', 'app.asar');
  const macArchive = resolve(binaryDir, '..', 'Resources', 'app.asar');
  const archivePath = existsSync(windowsArchive) ? windowsArchive : existsSync(macArchive) ? macArchive : null;
  if (!archivePath) throw new Error('找不到 Desktop app.asar；需要 Windows 或 macOS .app 布局。');
  const archive = readAsar(archivePath);
  const app = archive.json('package.json');
  const runtime = archive.json('dsh/package.json');
  const manifest = archive.json('dsh/desktop-runtime.json');
  const resourcesDir = dirname(archivePath);
  const fuseBinary = existsSync(join(binaryDir, '..', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework'))
    ? join(binaryDir, '..', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework')
    : executable;
  if (app.name !== '@deepseek-ai/dsh-desktop' || !CANDIDATE_VERSIONS.includes(app.version)
    || app.version !== runtime.version || app.version !== manifest.release?.version
    || manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error('内部候选只验证与当前进程平台/架构一致、版本一致的官方 Desktop。');
  }
  return { executable, binaryDir, resourcesDir, archivePath, archive, app, runtime, manifest, fuseBinary,
    selectorKind: app.version === '0.2.0-rc.2' ? 'constructor' : 'volatile' };
}
