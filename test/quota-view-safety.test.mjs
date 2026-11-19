import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuotaView } from '../src/ui/quota-view.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
function fixture(t, value, { id = 'tavily', key = 'synthetic-key', draftBase = null } = {}) {
  const previous = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ height: '0', transform: 'none' });
  t.after(() => {
    if (previous) globalThis.getComputedStyle = previous;
    else delete globalThis.getComputedStyle;
  });
  const slot = { innerHTML: '' }, calls = [];
  const base = id === 'tavily' ? { keys: [key], url: 'https://api.tavily.com' }
    : { key, searchUrl: 'https://api.search.tinyfish.ai' };
  const dialog = { kind: 'card', id, base, draft: { ...base, ...(draftBase ? { url: draftBase } : {}) },
    configBaseline: { revision: 'revision', quotaRevision: 'quota' } };
  const S = { configRevision: 'revision', config: { quotaRevision: 'quota' }, capabilities: { secretsAllowed: true } };
  const denials = [];
  const result = method => async request => {
    calls.push({ method, request });
    return { value: typeof value === 'function' ? await value(request) : value };
  };
  const view = createQuotaView({
    $: selector => selector === '#quotaSlot' ? slot : null, active: () => null,
    S, onPrivateAccessDenied(error) { denials.push(error.code); S.capabilities.secretsAllowed = false; view.render(); },
    getDialog: () => dialog, dlg: {}, SUPP: ['tavily', 'exa', 'tinyfish', 'firecrawl'],
    DEF: { tavilyUrl: 'https://api.tavily.com', tfSearch: 'https://api.search.tinyfish.ai' },
    svg: () => '', EXT: value => value, esc: escape, reduced: () => true, dialogBusy: () => false,
    uuid: () => 'synthetic-operation', remote: { accountQuota: result('saved'), previewAccountQuota: result('draft'),
      cancelDiagnosis: async () => {} },
  });
  t.after(() => view.dispose());
  return { view, slot, calls, dialog, S, denials };
}

test('malformed quota values never become HTML attributes or a misleading numeric zero', async t => {
  const h = fixture(t, { kind: 'credits', used: 4, plan: '10" onmouseover="bad', remaining: Infinity });
  await h.view.open();
  assert.doesNotMatch(h.slot.innerHTML, /onmouseover|Infinity|aria-valuemax=/);
  assert.match(h.slot.innerHTML, /总额度未报告/);
  assert.match(h.slot.innerHTML, /is-unreported/);
});

test('unknown kind is not interpolated and note markup remains escaped', async t => {
  const h = fixture(t, { kind: '"><img src=x onerror=bad>', balance: 1 });
  await h.view.open();
  assert.doesNotMatch(h.slot.innerHTML, /onerror|<img/);
  assert.match(h.slot.innerHTML, /未报告数据/);
});

test('negative wallet and exact zero remain real values', async t => {
  const h = fixture(t, { kind: 'wallet', balance: -1.25, note: '<img onerror="bad">' }, { id: 'tinyfish' });
  await h.view.open();
  assert.match(h.slot.innerHTML, /-1\.25/);
  assert.match(h.slot.innerHTML, /&lt;img/);
  assert.doesNotMatch(h.slot.innerHTML, /<img/);
});

test('credits meter preserves zero and caps progress without accepting nonnumeric limits', async t => {
  const h = fixture(t, { kind: 'credits', used: 0, plan: 10, remaining: 10 });
  await h.view.open();
  assert.match(h.slot.innerHTML, /aria-valuemax="10" aria-valuenow="0"/);
  assert.match(h.slot.innerHTML, /transform:scaleX\(0\)/);
});

test('default hidden predicate never forwards a masked saved key when a draft changes its Base URL', async t => {
  const key = '\u2063dsg-configured-secret:configured';
  const h = fixture(t, { kind: 'credits', used: 1, plan: 10, remaining: 9 },
    { key, draftBase: 'https://custom.example.test' });
  await h.view.open();
  assert.equal(h.calls[0].method, 'draft');
  assert.deepEqual(h.calls[0].request.draft, { baseUrl: 'https://custom.example.test' });
  assert.equal(JSON.stringify(h.calls).includes(key), false);
});

for (const code of ['SETTINGS_AUTH_REQUIRED', 'SETTINGS_SECURE_CONNECTION_REQUIRED']) {
  test(`quota RPC ${code} revokes private data across cached keys until a fresh read`, async t => {
    let errorCode = null, balance = 142.75;
    const h = fixture(t, () => {
      if (errorCode) throw Object.assign(new Error('restricted'), { code: errorCode });
      return { kind: 'wallet', balance };
    });
    h.dialog.base.keys.push('synthetic-second');
    await h.view.open();
    balance = 298.5;
    await h.view.key(1);
    assert.match(h.slot.innerHTML, /298\.5/);
    errorCode = code;
    await h.view.refresh();
    assert.deepEqual(h.denials, [code]);
    assert.match(h.slot.innerHTML, /data-state="restricted"/);
    assert.doesNotMatch(h.slot.innerHTML, /298\.5/);

    h.S.capabilities.secretsAllowed = true;
    h.view.render();
    assert.match(h.slot.innerHTML, /data-state="unreported"/);
    errorCode = null; balance = 21;
    const read = h.view.key(0);
    assert.doesNotMatch(h.slot.innerHTML, /142\.75/);
    await read;
    assert.match(h.slot.innerHTML, /class="qp-value">21</);
    assert.equal(h.calls.length, 4);
  });
}

test('a restricted snapshot clears quota and a late reply cannot restore it after reauthorization', async t => {
  let finish;
  const h = fixture(t, () => h.calls.length === 1 ? { kind: 'wallet', balance: 71.25 }
    : new Promise(resolve => { finish = resolve; }), { id: 'tinyfish' });
  await h.view.open();
  const reading = h.view.refresh();
  h.S.capabilities.secretsAllowed = false;
  h.view.render();
  assert.match(h.slot.innerHTML, /data-state="restricted"/);
  assert.doesNotMatch(h.slot.innerHTML, /71\.25/);
  h.S.capabilities.secretsAllowed = true;
  h.view.render();
  finish({ kind: 'wallet', balance: 82.5 });
  await reading;
  assert.match(h.slot.innerHTML, /data-state="unreported"/);
  assert.doesNotMatch(h.slot.innerHTML, /71\.25|82\.5/);
});

test('an upstream quota failure retains the last balance with a stale label', async t => {
  const h = fixture(t, () => {
    if (h.calls.length === 1) return { kind: 'wallet', balance: 18.5 };
    throw Object.assign(new Error('rate limited'), { code: 'QUOTA_QUERY_FAILED',
      details: { category: 'RATE_LIMIT', httpStatus: 429 } });
  }, { id: 'tinyfish' });
  await h.view.open();
  await h.view.refresh();
  assert.match(h.slot.innerHTML, /class="qp-value">18\.5</);
  assert.match(h.slot.innerHTML, /刷新失败 · 上次结果 · HTTP 429/);
  assert.deepEqual(h.denials, []);
});
