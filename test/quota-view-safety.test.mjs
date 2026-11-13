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
  const result = method => async request => { calls.push({ method, request }); return { value }; };
  const view = createQuotaView({
    $: selector => selector === '#quotaSlot' ? slot : null, active: () => null,
    S: { configRevision: 'revision', config: { quotaRevision: 'quota' }, capabilities: { secretsAllowed: true } },
    getDialog: () => dialog, dlg: {}, SUPP: ['tavily', 'exa', 'tinyfish', 'firecrawl'],
    DEF: { tavilyUrl: 'https://api.tavily.com', tfSearch: 'https://api.search.tinyfish.ai' },
    svg: () => '', EXT: value => value, esc: escape, reduced: () => true, dialogBusy: () => false,
    uuid: () => 'synthetic-operation', remote: { accountQuota: result('saved'), previewAccountQuota: result('draft'),
      cancelDiagnosis: async () => {} },
  });
  t.after(() => view.dispose());
  return { view, slot, calls };
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
