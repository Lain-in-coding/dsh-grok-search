#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { createCompatibilityState } from './compatibility-state.mjs';
import { isCompatibilityVersion } from './compatibility-contract.mjs';
import { GrokSearchError } from './errors.mjs';

const usage = [
  'dsh-grok-search-compatibility <inspect|confirm|revoke>',
  '  --profile-dir <absolute-directory> --host-version <exact-version> --plugin-version <exact-version>',
  '  confirm additionally requires --accept-risk',
  'This local-owner command only changes plugin consent, never host admission or core safety.',
].join('\n');
const argumentError = () => { throw new GrokSearchError('COMPATIBILITY_CLI_ARGUMENT', 'Use an explicit command, profile directory and exact version pair.'); };

export function runCompatibilityCli(args, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let store;
  try {
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { stdout.write(usage + '\n'); return 0; }
    const [command, ...flags] = args;
    if (!['inspect', 'confirm', 'revoke'].includes(command)) argumentError();
    const fields = new Map([
      ['--profile-dir', 'profileDir'], ['--host-version', 'hostVersion'], ['--plugin-version', 'pluginVersion'],
    ]);
    const options = {};
    let acceptRisk = false;
    for (let index = 0; index < flags.length; index++) {
      const flag = flags[index];
      if (flag === '--accept-risk') {
        if (acceptRisk || command !== 'confirm') argumentError();
        acceptRisk = true;
        continue;
      }
      const field = fields.get(flag), value = flags[++index];
      if (!field || Object.hasOwn(options, field) || typeof value !== 'string' || value.startsWith('--')) argumentError();
      options[field] = value;
    }
    if (typeof options.profileDir !== 'string' || !isCompatibilityVersion(options.hostVersion)
      || !isCompatibilityVersion(options.pluginVersion) || command === 'confirm' && !acceptRisk) argumentError();
    store = createCompatibilityState(options);
    const before = store.snapshot();
    if (before.errorCode) throw new GrokSearchError(before.errorCode, 'Compatibility state is unavailable.');
    const request = {
      hostVersion: before.hostVersion, pluginVersion: before.pluginVersion, expectedRevision: before.revision,
    };
    const state = command === 'inspect' ? before : command === 'confirm'
      ? store.confirm({ ...request, acceptRisk: true }) : store.revoke(request);
    stdout.write(JSON.stringify({ command, ...state }) + '\n');
    return 0;
  } catch (error) {
    const code = error instanceof GrokSearchError ? error.code : 'COMPATIBILITY_CLI_FAILED';
    stderr.write(JSON.stringify({ code, message: 'Compatibility command failed. No host permission was changed.' }) + '\n');
    return 1;
  } finally { store?.dispose(); }
}

let invokedDirectly = false;
try { invokedDirectly = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch {}
if (invokedDirectly) {
  process.exitCode = runCompatibilityCli(process.argv.slice(2));
}
