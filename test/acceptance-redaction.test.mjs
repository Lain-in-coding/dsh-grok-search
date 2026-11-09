import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSecretFreeEvidence, configSecrets, redact } from '../scripts/lib/internal-candidate-utils.mjs';

test('acceptance evidence redacts authorized TOML secrets and every comma-separated key', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-acceptance-redaction-'));
  const config = join(root, 'synthetic.toml');
  writeFileSync(config, [
    'grok_api_key = "synthetic-grok-secret"',
    'tavily_api_key = "synthetic-key-one, synthetic-key-two"',
    'github_token = "synthetic-github-secret"',
    'grok_model = "not-a-secret-model"',
    '[auth]',
    'client_secret = "synthetic-client-secret"',
    'tokens = ["synthetic-array-secret"]',
    '',
  ].join('\n'));
  const secrets = configSecrets(config);
  for (const secret of ['synthetic-grok-secret', 'synthetic-key-one', 'synthetic-key-two',
    'synthetic-github-secret', 'synthetic-client-secret', 'synthetic-array-secret']) assert.ok(secrets.includes(secret));
  assert.ok(!secrets.includes('not-a-secret-model'));
  const safe = redact(JSON.stringify({ stderr: 'Bearer synthetic-grok-secret',
    failures: ['synthetic-key-one', 'synthetic-key-two', 'synthetic-github-secret', 'synthetic-client-secret',
      'synthetic-array-secret'] }), [], secrets);
  assert.doesNotThrow(() => JSON.parse(safe));
  for (const secret of secrets) assert.ok(!safe.includes(secret));
});

test('acceptance redaction handles URL/JSON-escaped secrets and overlapping values', () => {
  const secret = 'synthetic-"quoted"/key+long';
  const encoded = encodeURIComponent(secret);
  const json = JSON.stringify({ stderr: secret, url: 'https://example.invalid/?key=' + encoded });
  const safe = redact(json, [], ['synthetic-', secret]);
  assert.deepEqual(JSON.parse(safe), {
    stderr: '<AUTH_REDACTED>', url: 'https://example.invalid/?key=<AUTH_REDACTED>',
  });
});

test('invalid acceptance TOML never echoes credential source lines', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-acceptance-redaction-'));
  const config = join(root, 'invalid-synthetic.toml');
  writeFileSync(config, 'grok_api_key = "synthetic-secret-that-must-not-appear\n');
  assert.throws(() => configSecrets(config), error =>
    error.message === 'Cannot safely parse the explicitly supplied acceptance configuration.'
    && !error.message.includes('synthetic-secret'));
});

test('short invalid test keys do not reject numeric acceptance evidence', () => {
  const evidence = { status: 'passed', httpStatus: 200, count: 1, elapsedMs: 123,
    version: '0.2.1', hash: 'abcdef123' };
  assert.equal(assertSecretFreeEvidence(evidence, ['1', '2', '3']), evidence);
  assert.throws(() => assertSecretFreeEvidence({ key: '1' }, ['1']),
    { code: 'EVIDENCE_SECRET_REJECTED' });
});

test('acceptance guard still rejects raw and encoded full-length credentials', () => {
  const secret = 'synthetic-"quoted"/key+long';
  for (const value of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) {
    assert.throws(() => assertSecretFreeEvidence({ diagnostic: value }, [secret]),
      { code: 'EVIDENCE_SECRET_REJECTED' });
  }
});
