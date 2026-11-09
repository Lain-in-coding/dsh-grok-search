import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanEnvironment } from './internal-candidate-utils.mjs';

// Desktop acceptance only. Never imported by the published plugin or applied to
// an ordinary profile. HOME alone cannot redirect Windows Known Folder records.
const within = (root, path) => {
  const distance = relative(root, path);
  return distance === '' || (distance !== '..' && !distance.startsWith('..' + sep) && !isAbsolute(distance));
};

function inspectPath(root, path, kind = 'directory') {
  if (!within(root, path)) throw new Error('Acceptance path escapes its temporary root.');
  const parts = relative(root, path).split(sep).filter(Boolean);
  let current = root;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = join(current, parts[index]);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (!entry) continue;
    if (entry.isSymbolicLink()) throw new Error('Acceptance path contains a link.');
    const file = kind === 'file' && index === parts.length - 1;
    if (file ? !entry.isFile() : !entry.isDirectory()) throw new Error('Acceptance path has an unexpected type.');
  }
}

export function desktopAcceptancePaths(runRoot) {
  if (typeof runRoot !== 'string' || !isAbsolute(runRoot)) throw new Error('Acceptance root must be absolute.');
  const temporaryAlias = resolve(tmpdir()), temporary = realpathSync(temporaryAlias);
  const provided = resolve(runRoot);
  const root = within(temporaryAlias, provided)
    ? join(temporary, relative(temporaryAlias, provided)) : provided;
  const distance = relative(temporary, root);
  if (!distance || !within(temporary, root) || !distance.split(sep)[0].startsWith('dsh-deferred-desktop-')) {
    throw new Error('Acceptance root must use the dedicated temporary namespace.');
  }
  inspectPath(temporary, root);
  if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('Acceptance root must already exist.');
  }
  const paths = {
    root,
    home: join(root, 'user'),
    desktop: join(root, 'user', 'Desktop'),
    documents: join(root, 'user', 'Documents'),
    downloads: join(root, 'user', 'Downloads'),
    appData: join(root, 'appdata'),
    localAppData: join(root, 'localappdata'),
    dshHome: join(root, 'dsh-home'),
    profile: join(root, 'dsh-home', 'profiles', 'desktop'),
    userData: join(root, 'electron-data'),
    workspace: join(root, 'user', 'Documents', 'deepseek-harness', 'default-workspace'),
  };
  for (const path of Object.values(paths)) inspectPath(root, path);
  return paths;
}

export function desktopWorkspacePatch(runRoot) {
  const paths = desktopAcceptancePaths(runRoot);
  return { id: 'workspace-controller', config: { documentsDirectory: paths.documents } };
}

export function prepareDesktopAcceptanceEnvironment(runRoot, extra = {}) {
  const paths = desktopAcceptancePaths(runRoot);
  // These are process-local test boundaries, not deployment overrides.
  const managed = new Set(['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR']);
  for (const name of Object.keys(extra)) {
    if (managed.has(name.toUpperCase())) throw new Error('Cannot override a managed acceptance environment path.');
    if (name.toUpperCase() === 'DSH_HOME' && resolve(extra[name]) !== paths.dshHome) {
      throw new Error('DSH_HOME must remain in the acceptance profile.');
    }
    if (name.toUpperCase() === 'GROK_SEARCH_CONFIG') {
      if (typeof extra[name] !== 'string' || !isAbsolute(extra[name])) throw new Error('Acceptance config path must be absolute.');
      inspectPath(paths.root, resolve(extra[name]), 'file');
    }
  }
  const patchPath = join(paths.profile, 'cordis.patch.yml');
  inspectPath(paths.root, patchPath, 'file');
  let patch;
  try { patch = JSON.parse(readFileSync(patchPath, 'utf8')); }
  catch { throw new Error('Desktop acceptance requires its explicit JSON workspace patch.'); }
  const entries = Array.isArray(patch) ? patch.filter(entry => entry?.id === 'workspace-controller') : [];
  if (entries.length !== 1 || entries[0].disabled === true
    || entries[0].config?.documentsDirectory !== paths.documents) {
    throw new Error('Isolate documentsDirectory before enabling native desktop commands.');
  }
  // Validate the complete directory set before creating anything. Do not create
  // the default workspace: the official Host must initialize and register it.
  for (const path of [paths.desktop, paths.documents, paths.downloads, paths.appData, paths.localAppData]) {
    mkdirSync(path, { recursive: true });
  }
  const env = cleanEnvironment(paths.root, { ...extra, DSH_HOME: paths.dshHome });
  if (process.platform === 'win32') {
    const system = process.env.SystemRoot ?? 'C:/Windows';
    env.PATH = [...new Set([...env.PATH.split(';'), system,
      join(system, 'System32', 'WindowsPowerShell', 'v1.0')])].join(';');
  }
  return { paths, env };
}
