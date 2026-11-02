import { openSync, closeSync, readSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';

function entryPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || value.includes(':')) {
    throw new Error('ASAR entry must be a relative POSIX path.');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid ASAR entry path.');
  return parts;
}

function readExactly(fd, size, position) {
  const buffer = Buffer.alloc(size);
  let done = 0;
  while (done < size) {
    const count = readSync(fd, buffer, done, size - done, position + done);
    if (count === 0) throw new Error('Truncated ASAR archive.');
    done += count;
  }
  return buffer;
}

export function readAsar(archivePath) {
  const path = resolve(archivePath);
  const fd = openSync(path, 'r');
  try {
    const fileSize = statSync(path).size;
    const lead = readExactly(fd, 16, 0);
    const headerBytes = lead.readUInt32LE(12);
    const dataOffset = 8 + lead.readUInt32LE(4);
    if (headerBytes < 2 || headerBytes > 32 * 1024 * 1024 || dataOffset < 16 + headerBytes || dataOffset > fileSize) {
      throw new Error('Invalid ASAR header bounds.');
    }
    const header = JSON.parse(readExactly(fd, headerBytes, 16).toString('utf8'));
    if (!header.files || typeof header.files !== 'object') throw new Error('Invalid ASAR file table.');

    function locate(name, seen = new Set()) {
      if (seen.has(name)) throw new Error('Cyclic ASAR link.');
      seen.add(name);
      let entry = header;
      for (const part of entryPath(name)) {
        entry = Object.hasOwn(entry.files ?? {}, part) ? entry.files[part] : undefined;
        if (!entry) throw new Error(`ASAR entry not found: ${name}`);
      }
      if (entry.link) return locate(entry.link, seen);
      return { entry, name };
    }

    return {
      path,
      dataOffset,
      headerBytes,
      read(name) {
        const located = locate(name);
        const entry = located.entry;
        if (entry.files) throw new Error(`ASAR entry is a directory: ${name}`);
        if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('Invalid ASAR entry size.');
        if (entry.unpacked) {
          const root = path + '.unpacked';
          const target = resolve(root, ...entryPath(located.name));
          const rel = relative(root, target);
          if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Unpacked entry escapes archive directory.');
          const realRoot = realpathSync(root);
          const realTarget = realpathSync(target);
          const realRelative = relative(realRoot, realTarget);
          if (realRelative === '..' || realRelative.startsWith('..' + sep) || isAbsolute(realRelative)) throw new Error('Unpacked entry escapes archive directory.');
          const content = readFileSync(realTarget);
          if (content.length !== entry.size) throw new Error('Unpacked entry size mismatch.');
          return content;
        }
        const offset = Number(entry.offset);
        if (!Number.isSafeInteger(offset) || offset < 0 || dataOffset + offset + entry.size > fileSize) {
          throw new Error('Invalid ASAR entry bounds.');
        }
        const handle = openSync(path, 'r');
        try { return readExactly(handle, entry.size, dataOffset + offset); }
        finally { closeSync(handle); }
      },
      json(name) { return JSON.parse(this.read(name).toString('utf8')); },
      entries(name) { return Object.keys(locate(name).entry.files ?? {}); },
      sha256(name) { return createHash('sha256').update(this.read(name)).digest('hex'); },
    };
  } finally {
    closeSync(fd);
  }
}

export function desktopRuntime(desktopExecutable) {
  if (!desktopExecutable) throw new Error('Pass --desktop <Desktop executable> or set DSH_DESKTOP_EXE.');
  const executable = resolve(desktopExecutable);
  if (!statSync(executable).isFile()) throw new Error('Desktop executable is not a file.');
  const archivePath = join(dirname(executable), 'resources', 'app.asar');
  const archive = readAsar(archivePath);
  const app = archive.json('package.json');
  const runtime = archive.json('dsh/package.json');
  const manifest = archive.json('dsh/desktop-runtime.json');
  if (app.name !== '@deepseek-ai/dsh-desktop' || app.version !== '0.2.0-rc.2' || runtime.version !== '0.2.0-rc.2') {
    throw new Error('M0 supports only Desktop/runtime 0.2.0-rc.2.');
  }
  return { executable, archivePath, archive, app, runtime, manifest };
}
