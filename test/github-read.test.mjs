import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createGithubReader, createGithubScheduling, parseGithubUrl, formatGithubRead } from '../src/core/github-read.mjs';

const url = 'https://github.com/octocat/example/issues/7';
const scope = { sessionId: 'session-a', agentId: 'agent-a' };
const root = { id: 7, title: 'Discussion', body: 'opening-key-answer', user: { login: 'author' }, updated_at: '2026-11-09T01:00:00Z' };
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status,
  headers: { 'content-type': 'application/json', ...headers } });
function fixture(count = 0, options = {}) {
  const config = { enabled: true, token: '', ...options.config };
  const requests = [];
  const comments = Array.from({ length: count }, (_, i) => ({ id: 1000 + i, body: `comment-${i}-key-answer`, user: { login: `author-${i}` } }));
  const fetchImpl = async (input, init) => {
    requests.push({ url: input, init });
    if (options.fetch) return options.fetch(input, init, requests);
    const parsed = new URL(input);
    if (!parsed.pathname.endsWith('/comments')) return response(root);
    const page = Number(parsed.searchParams.get('page')), per = Number(parsed.searchParams.get('per_page'));
    const start = (page - 1) * per;
    return response(comments.slice(start, start + per), 200, start + per < comments.length
      ? { link: `<https://api.github.com${parsed.pathname}?per_page=${per}&page=${page + 1}>; rel="next"` } : {});
  };
  const reader = createGithubReader({ getState: () => config, fetchImpl, ...options.reader });
  return { config, requests, comments, reader };
}
async function collect(reader, target = url, targetScope = scope) {
  const results = [];
  let cursor;
  for (let attempts = 0; attempts < 300; attempts++) {
    const result = await reader.read({ url: target, scope: targetScope, cursor });
    assert.ok(formatGithubRead(result).length <= 16_000);
    results.push(result);
    if (!result.hasMore) return results;
    cursor = result.nextCursor;
  }
  assert.fail('Continuation failed to make progress');
}

test('only explicit official Issue, PR and single Release URLs are accepted', () => {
  assert.equal(parseGithubUrl(url + '#issuecomment-1').kind, 'issue');
  assert.equal(parseGithubUrl('https://github.com/o/r/pull/11').kind, 'pr');
  assert.equal(parseGithubUrl('https://github.com/o/r/releases/latest').api, '/repos/o/r/releases/latest');
  assert.equal(parseGithubUrl('https://github.com/o/r/releases/tag/a%2Fb').api, '/repos/o/r/releases/tags/a%2Fb');
  for (const value of ['http://github.com/o/r/issues/1', 'https://evil.test/o/r/issues/1',
    'https://api.github.com/repos/o/r/issues/1', 'https://github.com@evil.test/o/r/issues/1',
    'https://user:pass@github.com/o/r/issues/1', 'https://github.com/o/r/blob/main/a',
    'https://github.com/o/r/discussions/1', 'https://github.com/o/r/releases',
    'https://github.com/o/r/issues/0', 'https://github.com/o/r/issues/../issues/1']) {
    assert.throws(() => parseGithubUrl(value), /GitHub|Issue|PR/);
  }
});

for (const count of [0, 1, 100, 101, 500, 1101]) test(`all ${count} comments delivered with first/middle/last answers`, async () => {
  const { reader, requests } = fixture(count);
  const results = await collect(reader);
  const content = results.map(result => result.content).join('');
  assert.match(content, /opening-key-answer/);
  for (const i of new Set([0, Math.floor(count / 2), count - 1])) if (i >= 0 && count) {
    assert.ok(content.includes(`comment-${i}-key-answer`));
  }
  assert.equal(results.at(-1).deliveredItems, count + 1);
  assert.equal(results.at(-1).acquiredComplete, true);
  assert.equal(results.at(-1).hasMore, false);
  assert.equal(requests.filter(request => !new URL(request.url).pathname.endsWith('/comments')).length, results.length);
  assert.equal(requests.every(request => !request.init.headers.Authorization), true);
  reader.dispose();
  assert.equal(reader.snapshot().bytes, 0);
});

test('long single comment spans segments with no missing tail or broken Unicode', async () => {
  const { reader, comments } = fixture(1);
  comments[0].body = '😀长评论'.repeat(12_000) + 'TAIL-ANSWER';
  const results = await collect(reader);
  const parts = results.flatMap(result => result.parts).filter(part => part.id === '1000');
  assert.equal(parts[0].start, 0);
  for (let i = 1; i < parts.length; i++) assert.equal(parts[i].start, parts[i - 1].end);
  assert.equal(parts.at(-1).end, comments[0].body.length);
  assert.match(results.at(-1).content, /TAIL-ANSWER/);
  assert.equal(parts.at(-1).continues, false);
  reader.dispose();
});

test('PR preserves review state, empty bodies, reply relation and code fragment', async () => {
  const f = fixture(0, { fetch: async input => {
    const path = new URL(input).pathname;
    if (path.endsWith('/reviews')) return response([{ id: 20, body: '', state: 'APPROVED', user: null }]);
    if (path.includes('/pulls/') && path.endsWith('/comments')) return response([
      { id: 22, body: 'line answer', in_reply_to_id: 21, pull_request_review_id: 20, diff_hunk: '@@ x @@\n+fix', path: 'code.js' },
    ]);
    if (path.endsWith('/comments')) return response([{ id: 21, body: 'conversation' }]);
    return response(root);
  } });
  const result = (await collect(f.reader, 'https://github.com/octocat/example/pull/7'))[0];
  assert.equal(result.parts.length, 4);
  assert.equal(result.parts.find(part => part.type === 'review').state, 'APPROVED');
  assert.equal(result.parts.find(part => part.type === 'review-comment').replyTo, '21');
  assert.match(result.content, /code.js|line answer/);
  assert.match(result.content, /\+fix/);
  f.reader.dispose();
});

test('Release reads a single body without downloading assets; latest cursor is pinned to id', async () => {
  const f = fixture(0, { fetch: async () => response({ ...root, body: 'R'.repeat(25_000), assets: [{ browser_download_url: 'https://evil.test' }] }) });
  await collect(f.reader, 'https://github.com/octocat/example/releases/latest');
  assert.equal(f.requests.length, 2);
  assert.equal(new URL(f.requests[1].url).pathname, '/repos/octocat/example/releases/7');
  f.reader.dispose();
});

test('only known current cursor can continue, bound to session, agent and resource', async () => {
  const f = fixture(100);
  const first = await f.reader.read({ url, scope });
  for (const input of [
    { scope: { ...scope, sessionId: 'another' } }, { scope: { ...scope, agentId: 'other' } },
    { url: url.replace('/7', '/8') }, { cursor: 'https://evil.test' },
  ]) {
    await assert.rejects(f.reader.read({ url, scope, cursor: first.nextCursor, ...input }), { code: 'GITHUB_CURSOR_INVALID' });
  }
  assert.equal(f.requests.length, 2);
  const second = await f.reader.read({ url, scope, cursor: first.nextCursor });
  const replay = await f.reader.read({ url, scope, cursor: first.nextCursor });
  assert.equal(replay.content, second.content);
  assert.equal(replay.nextCursor, second.nextCursor);
  assert.equal(replay.cacheHit, true);
  f.reader.dispose();
});

test('remote revoked token fails even cached replay without anonymous fallback', async () => {
  let revoked = false;
  const f = fixture(0, { config: { token: 'test-token' }, fetch: async input => revoked
    ? response({}, 401) : response(new URL(input).pathname.endsWith('/comments') ? [{ id: 100, body: 'x'.repeat(25_000) }] : root) });
  const first = await f.reader.read({ url, scope });
  revoked = true;
  await assert.rejects(f.reader.read({ url, scope, cursor: first.nextCursor }), { code: 'GITHUB_AUTH' });
  assert.equal(f.reader.snapshot().resources, 0);
  assert.ok(f.requests.every(request => request.init.headers.Authorization === 'Bearer test-token'));
  f.reader.dispose();
});

for (const status of [403, 404, 429, 502]) test(`HTTP ${status} is classified without returning stale cache`, async () => {
  let fail = false;
  const f = fixture(0, { fetch: async input => fail ? response({}, status, status === 429 ? { 'retry-after': '80' } : {})
    : response(new URL(input).pathname.endsWith('/comments') ? [{ id: 100, body: 'x'.repeat(25_000) }] : root) });
  const first = await f.reader.read({ url, scope });
  fail = true;
  await assert.rejects(f.reader.read({ url, scope, cursor: first.nextCursor }), failure => {
    assert.equal(failure.details.httpStatus, status);
    if (status === 429) assert.ok(Date.parse(failure.details.retryAt) > Date.now());
    return true;
  });
  f.reader.dispose();
});

test('network error during authorization does not serve cached content', async () => {
  let fail = false;
  const f = fixture(0, { fetch: async input => {
    if (fail) throw new TypeError('secret-network-url');
    return response(new URL(input).pathname.endsWith('/comments') ? [{ id: 100, body: 'x'.repeat(25_000) }] : root);
  } });
  const first = await f.reader.read({ url, scope });
  fail = true;
  await assert.rejects(f.reader.read({ url, scope, cursor: first.nextCursor }), failure => {
    assert.equal(failure.code, 'GITHUB_NETWORK'); assert.ok(!failure.message.includes('secret')); return true;
  });
  f.reader.dispose();
});

test('external credential changes during fetch are checked before delivery', async () => {
  const config = { enabled: true, token: 'a' };
  const reader = createGithubReader({ getState: () => config, fetchImpl: async () => {
    config.token = 'b'; return response(root);
  } });
  await assert.rejects(reader.read({ url, scope }), { code: 'GITHUB_STATE_CHANGED' });
  assert.equal(reader.snapshot().resources, 0);
  reader.dispose();
});

test('disabled by default, missing identity and tiny output limits do not issue requests', async () => {
  const f = fixture(0, { config: { enabled: false } });
  await assert.rejects(f.reader.read({ url, scope }), { code: 'GITHUB_DISABLED' });
  f.config.enabled = true;
  await assert.rejects(f.reader.read({ url }), { code: 'GITHUB_SCOPE_REQUIRED' });
  for (const limitChars of [-200, 0, 300, 1399, 1600.5, NaN, Infinity]) {
    await assert.rejects(f.reader.read({ url, scope, limitChars }), { code: 'GITHUB_OUTPUT_LIMIT' });
  }
  assert.equal(f.requests.length, 0);
  f.reader.dispose();
});

test('time budget returns partial content and resumable position; caller cancellation never does', async () => {
  let slow = true, aborted = 0;
  const f = fixture(0, { reader: { budgetMs: 70 }, fetch: async (input, init) => {
    if (!new URL(input).pathname.endsWith('/comments')) return response(root);
    if (!slow) return response([{ id: 1, body: 'tail' }]);
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => { aborted++; reject(init.signal.reason); }, { once: true }));
  } });
  const first = await f.reader.read({ url, scope });
  assert.equal(first.acquiredComplete, false);
  assert.equal(first.incomplete.code, 'GITHUB_TIMEOUT');
  assert.match(first.content, /opening-key-answer/);
  assert.equal(aborted, 1);
  slow = false;
  const last = await f.reader.read({ url, scope, cursor: first.nextCursor });
  assert.equal(last.hasMore, false);
  slow = true;
  const stop = new AbortController();
  const pending = f.reader.read({ url, scope, signal: stop.signal });
  setTimeout(() => stop.abort(new Error('caller cancelled')), 10);
  await assert.rejects(pending, /caller cancelled/);
  f.reader.dispose();
});

test('a stalled GitHub response body obeys caller cancellation and releases its reader', async () => {
  const controller = new AbortController(), reason = new Error('synthetic GitHub body cancellation');
  let stream, responseBody, started, cancelled = 0;
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture(0, { fetch: async () => {
    responseBody = new Response(new ReadableStream({
      start(value) { stream = value; started(); },
      cancel() { cancelled++; },
    }));
    return responseBody;
  } });
  const pending = f.reader.read({ url, scope, signal: controller.signal });
  let timer;
  try {
    await ready;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(responseBody.body.locked, true);
    controller.abort(reason);
    await assert.rejects(Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('GitHub body remained pending after cancellation.')), 500);
    })]), failure => failure === reason);
    assert.equal(cancelled, 1);
    assert.equal(responseBody.body.locked, false);
    assert.equal(f.reader.snapshot().active, 0);
    assert.equal(f.reader.snapshot().queued, 0);
  } finally {
    clearTimeout(timer);
    if (!cancelled) stream.close();
    await pending.catch(() => {});
    f.reader.dispose();
  }
});

test('GitHub page body timeout returns authorized partial content without orphaning a stream', async () => {
  let stream, responseBody, cancelled = 0;
  const f = fixture(0, { reader: { budgetMs: 100 }, fetch: async input => {
    if (!new URL(input).pathname.endsWith('/comments')) return response(root);
    responseBody = new Response(new ReadableStream({
      start(value) { stream = value; },
      cancel() { cancelled++; },
    }));
    return responseBody;
  } });
  const pending = f.reader.read({ url, scope });
  let timer;
  try {
    const result = await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('GitHub page body ignored the read budget.')), 600);
    })]);
    assert.equal(result.incomplete.code, 'GITHUB_TIMEOUT');
    assert.equal(result.acquiredComplete, false);
    assert.equal(result.hasMore, true);
    assert.match(result.content, /opening-key-answer/);
    assert.equal(cancelled, 1);
    assert.equal(responseBody.body.locked, false);
  } finally {
    clearTimeout(timer);
    if (!cancelled) stream.close();
    await pending.catch(() => {});
    f.reader.dispose();
  }
});

test('pagination never follows external, repeated, backwards or unrelated next links', async () => {
  for (const next of [
    'https://evil.test/repos/octocat/example/issues/7/comments?per_page=100&page=2',
    'https://api.github.com/repos/other/private/issues/7/comments?per_page=100&page=2',
    'https://api.github.com/repos/octocat/example/issues/7/comments?per_page=100&page=1',
    'https://api.github.com/repos/octocat/example/issues/7/comments?per_page=100&page=2&token=bad',
  ]) {
    const f = fixture(0, { fetch: async input => new URL(input).pathname.endsWith('/comments')
      ? response([{ id: 1, body: 'comment' }], 200, { link: `<${next}>; rel="next"` }) : response(root) });
    const result = await f.reader.read({ url, scope });
    assert.equal(result.acquiredComplete, false);
    assert.equal(result.incomplete.code, 'GITHUB_PAGINATION');
    assert.equal(f.requests.length, 2);
    f.reader.dispose();
  }
});

test('stable id deduplicates overlapping pages and discloses live changes', async () => {
  let changed = false;
  const f = fixture(0, { fetch: async input => {
    const parsed = new URL(input);
    if (!parsed.pathname.endsWith('/comments')) return response({ ...root, updated_at: changed ? 'later' : root.updated_at });
    if (parsed.searchParams.get('page') === '1') return response([{ id: 1, body: 'first' }], 200,
      { link: '<https://api.github.com/repositories/42/issues/7/comments?per_page=100&page=2>; rel="next"' });
    return response([{ id: 1, body: 'first' }, { id: 2, body: 'last'.repeat(6000) }]);
  } });
  const first = await f.reader.read({ url, scope });
  assert.equal(first.fetchedItems, 3);
  changed = true;
  const last = await f.reader.read({ url, scope, cursor: first.nextCursor });
  assert.equal(last.changedDuringRead, true);
  assert.ok(f.requests.every(request => new URL(request.url).pathname.startsWith('/repos/octocat/example/')));
  f.reader.dispose();
});

test('idle expiration and lifecycle invalidation release cached bodies', async () => {
  let now = 1;
  const f = fixture(100, { reader: { now: () => now, idleMs: 1000 } });
  const first = await f.reader.read({ url, scope });
  now = 1002;
  await assert.rejects(f.reader.read({ url, scope, cursor: first.nextCursor }), { code: 'GITHUB_CURSOR_INVALID' });
  assert.equal(f.reader.snapshot().bytes, 0);
  const again = await f.reader.read({ url, scope });
  f.reader.invalidate();
  await assert.rejects(f.reader.read({ url, scope, cursor: again.nextCursor }), { code: 'GITHUB_CURSOR_INVALID' });
  f.reader.dispose();
});

test('same-credential requests are serial and queue time counts toward budget', async () => {
  let active = 0, maximum = 0;
  const f = fixture(0, { reader: { budgetMs: 2000 }, fetch: async input => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return response(new URL(input).pathname.endsWith('/comments') ? [] : root);
  } });
  await Promise.all(Array.from({ length: 5 }, (_, i) => f.reader.read({ url, scope: { ...scope, agentId: `a${i}` } })));
  assert.equal(maximum, 1);
  assert.equal(f.reader.snapshot().queued, 0);
  f.reader.dispose();
});

test('small cache makes progress by shrinking a page without losing comments', async () => {
  const f = fixture(101, { reader: { cacheBytes: 14000 } });
  const results = await collect(f.reader);
  assert.equal(results.at(-1).deliveredItems, 102);
  for (let i = 0; i < 101; i++) assert.ok(results.some(result => result.content.includes(`comment-${i}-key-answer`)));
  assert.ok(f.requests.some(request => request.url.includes('per_page=1&')));
  assert.ok(f.reader.snapshot().bytes <= 14000);
  f.reader.dispose();
});

test('secondary limits without headers are classified and observed without immediate retry', async () => {
  const f = fixture(0, { fetch: async () => response({ message: 'You have exceeded a secondary rate limit.' }, 403) });
  await assert.rejects(f.reader.read({ url, scope }), { code: 'GITHUB_RATE_LIMIT' });
  await assert.rejects(f.reader.read({ url, scope }), { code: 'GITHUB_RATE_LIMIT' });
  assert.equal(f.requests.length, 1);
  f.reader.dispose();
});

test('observed token change and reverting never resurrects old cursors', async () => {
  const f = fixture(100, { config: { token: 'a' } });
  const first = await f.reader.read({ url, scope });
  f.config.token = 'b';
  await f.reader.read({ url, scope });
  f.config.token = 'a';
  await assert.rejects(f.reader.read({ url, scope, cursor: first.nextCursor }), { code: 'GITHUB_CURSOR_INVALID' });
  f.reader.dispose();
});

test('cache-limit failure leaves no inaccessible orphan body', async () => {
  const f = fixture(0, { reader: { cacheBytes: 100 } });
  await assert.rejects(f.reader.read({ url, scope }), { code: 'GITHUB_CACHE_FULL' });
  assert.deepEqual(f.reader.snapshot(), { resources: 0, bytes: 0, active: 0, queued: 0 });
  f.reader.dispose();
});

test('PR reached through an issues URL still includes reviews and code comments', async () => {
  const f = fixture(0, { fetch: async input => {
    const path = new URL(input).pathname;
    if (path.endsWith('/issues/7')) return response({ ...root, pull_request: { url: 'https://api.github.com/repos/octocat/example/pulls/7' } });
    if (path.endsWith('/reviews')) return response([{ id: 11, body: 'review-answer' }]);
    if (path.endsWith('/comments')) return response([]);
    return response(root);
  } });
  const result = (await collect(f.reader))[0];
  assert.equal(result.type, 'pr');
  assert.match(result.content, /review-answer/);
  f.reader.dispose();
});

test('multiple-page PR review replies retain references to earlier pages', async () => {
  const f = fixture(0, { fetch: async input => {
    const parsed = new URL(input);
    if (parsed.pathname.endsWith('/reviews')) return response([{ id: 50, body: null, state: 'COMMENTED' }]);
    if (parsed.pathname.includes('/issues/') && parsed.pathname.endsWith('/comments')) return response([]);
    if (parsed.pathname.includes('/pulls/') && parsed.pathname.endsWith('/comments')) {
      if (parsed.searchParams.get('page') === '1') return response(Array.from({ length: 100 }, (_, i) =>
        ({ id: 1000 + i, body: 'first-page', pull_request_review_id: 50 })), 200, {
        link: '<https://api.github.com/repos/octocat/example/pulls/7/comments?per_page=100&page=2>; rel="next"',
      });
      return response([{ id: 1100, body: 'last-page-reply', in_reply_to_id: 1000, pull_request_review_id: 50 }]);
    }
    return response(root);
  } });
  const results = await collect(f.reader, 'https://github.com/octocat/example/pull/7');
  const reply = results.flatMap(result => result.parts).find(part => part.id === '1100');
  assert.equal(reply.replyTo, '1000');
  assert.equal(reply.reviewId, '50');
  assert.equal(results.at(-1).deliveredItems, 103);
  f.reader.dispose();
});

test('read and draft test readers share bounded credential scheduling and rate limits', async () => {
  const scheduling = createGithubScheduling();
  let active = 0, maximum = 0;
  const make = () => fixture(0, { reader: { scheduling }, fetch: async input => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    return response(new URL(input).pathname.endsWith('/comments') ? [] : root);
  } });
  const one = make(), two = make();
  await Promise.all([one.reader.read({ url, scope }), two.reader.read({ url, scope })]);
  assert.equal(maximum, 1);
  one.reader.dispose(); two.reader.dispose();
});

test('queue overflow and queued cancellation never dispatch an extra request', async () => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = fixture(0, { reader: { queueLimit: 1 }, fetch: (input, init) => {
    entered();
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  } });
  const stopFirst = new AbortController(), stopSecond = new AbortController();
  const first = f.reader.read({ url, scope, signal: stopFirst.signal }).catch(failure => failure);
  await ready;
  const second = f.reader.read({ url, scope, signal: stopSecond.signal }).catch(failure => failure);
  await assert.rejects(f.reader.read({ url, scope }), { code: 'GITHUB_QUEUE_FULL' });
  stopSecond.abort(new Error('queued-cancel'));
  assert.match((await second).message, /queued-cancel/);
  stopFirst.abort(new Error('first-cancel'));
  await first;
  assert.equal(f.requests.length, 1);
  assert.equal(f.reader.snapshot().active, 0);
  f.reader.dispose();
});

test('oversized pages reduce to individual comments without skipping their ids', async () => {
  const f = fixture(5, { reader: { responseBytes: 600 } });
  for (const comment of f.comments) comment.body = 'value'.repeat(30);
  const results = await collect(f.reader);
  assert.equal(results.at(-1).deliveredItems, 6);
  assert.ok(f.requests.some(request => request.url.includes('per_page=1&')));
  f.reader.dispose();
});

test('repeated next page content is never reported as complete', async () => {
  const f = fixture(0, { fetch: async input => {
    const parsed = new URL(input);
    if (!parsed.pathname.endsWith('/comments')) return response(root);
    const page = Number(parsed.searchParams.get('page'));
    return response([{ id: 1, body: 'same page' }], 200, {
      link: `<https://api.github.com${parsed.pathname}?per_page=100&page=${page + 1}>; rel="next"`,
    });
  } });
  const result = await f.reader.read({ url, scope });
  assert.equal(result.acquiredComplete, false);
  assert.equal(result.incomplete.code, 'GITHUB_PAGINATION');
  assert.equal(f.requests.length, 3);
  f.reader.dispose();
});

test('long resource URL and metadata fit the whole output envelope without truncating continuation', async () => {
  const target = 'https://github.com/' + 'o'.repeat(90) + '/' + 'r'.repeat(90) + '/releases/tag/' + 'v'.repeat(490);
  const f = fixture(0, { fetch: async () => response({ ...root, body: '正文😀'.repeat(3000), user: { login: 'a'.repeat(280) } }) });
  let cursor, delivered = 0;
  for (let i = 0; i < 30; i++) {
    const result = await f.reader.read({ url: target, scope, cursor, limitChars: 3000 });
    assert.ok(formatGithubRead(result).length <= 3000);
    delivered += result.parts.reduce((n, part) => n + part.end - part.start, 0);
    if (!result.hasMore) break;
    cursor = result.nextCursor;
  }
  assert.equal(delivered, ('Discussion\n\n' + '正文😀'.repeat(3000)).length);
  f.reader.dispose();
});

test('PR alias continuation keeps the actual PR resource kind', async () => {
  const f = fixture(0, { fetch: async input => {
    const path = new URL(input).pathname;
    if (path.endsWith('/issues/7')) return response({ ...root, pull_request: {} });
    if (path.endsWith('/reviews') || path.endsWith('/comments')) return response([]);
    return response({ ...root, body: 'long'.repeat(9000) });
  } });
  const results = await collect(f.reader);
  assert.ok(results.length > 1);
  assert.ok(results.every(result => result.type === 'pr'));
  f.reader.dispose();
});

test('observing disabled state invalidates cached cursors even without a host timer', async () => {
  const f = fixture(100);
  const first = await f.reader.read({ url, scope });
  f.config.enabled = false;
  await assert.rejects(f.reader.read({ url, scope, cursor: first.nextCursor }), { code: 'GITHUB_DISABLED' });
  assert.equal(f.reader.snapshot().bytes, 0);
  f.config.enabled = true;
  await assert.rejects(f.reader.read({ url, scope, cursor: first.nextCursor }), { code: 'GITHUB_CURSOR_INVALID' });
  f.reader.dispose();
});

test('cached replay respects a smaller output limit without consuming the cursor', async () => {
  const f = fixture(1);
  f.comments[0].body = 'long-answer-'.repeat(5000);
  try {
    const first = await f.reader.read({ url, scope });
    const second = await f.reader.read({ url, scope, cursor: first.nextCursor });
    assert.ok(formatGithubRead(second).length > 3000);
    await assert.rejects(f.reader.read({ url, scope, cursor: first.nextCursor, limitChars: 3000 }),
      { code: 'GITHUB_OUTPUT_LIMIT' });
    const retry = await f.reader.read({ url, scope, cursor: first.nextCursor });
    assert.equal(retry.content, second.content);
    assert.equal(retry.nextCursor, second.nextCursor);
    assert.equal(retry.cacheHit, true);
    const next = await f.reader.read({ url, scope, cursor: second.nextCursor });
    assert.equal(next.segment, second.segment + 1);
  } finally { f.reader.dispose(); }
});

test('cached replay discloses newly observed resource updates within the same output limit', async () => {
  let changed = false;
  const f = fixture(0, { fetch: async input => response(new URL(input).pathname.endsWith('/comments')
    ? [{ id: 1000, body: 'long-answer-'.repeat(5000) }]
    : { ...root, updated_at: changed ? 'later' : root.updated_at }) });
  try {
    const first = await f.reader.read({ url, scope });
    const second = await f.reader.read({ url, scope, cursor: first.nextCursor });
    changed = true;
    const replay = await f.reader.read({ url, scope, cursor: first.nextCursor });
    assert.equal(replay.changedDuringRead, true);
    assert.match(formatGithubRead(replay), /读取期间检测到资源更新/);
    assert.ok(formatGithubRead(replay).length <= 16_000);
    assert.equal(replay.content, second.content);
    assert.equal(replay.nextCursor, second.nextCursor);
  } finally { f.reader.dispose(); }
});

test('scope invalidation removes only that Agent cursors and cancels only its admitted reads', async () => {
  const otherScope = { ...scope, agentId: 'agent-b' };
  const f = fixture(1);
  f.comments[0].body = 'long-answer-'.repeat(5000);
  try {
    const first = await f.reader.read({ url, scope });
    const other = await f.reader.read({ url, scope: otherScope });
    f.reader.invalidateScope(scope);
    await assert.rejects(f.reader.read({ url, scope, cursor: first.nextCursor }), { code: 'GITHUB_CURSOR_INVALID' });
    const continued = await f.reader.read({ url, scope: otherScope, cursor: other.nextCursor });
    assert.equal(continued.segment, 2);
  } finally { f.reader.dispose(); }

  let enter, finish;
  const started = new Promise(resolve => { enter = resolve; });
  const pending = fixture(0, { fetch: async (input, init) => {
    if (!new URL(input).pathname.endsWith('/comments')) {
      enter();
      await new Promise((resolve, reject) => {
        finish = resolve;
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    }
    return response(new URL(input).pathname.endsWith('/comments') ? [] : root);
  } });
  try {
    const first = pending.reader.read({ url, scope }).catch(failure => failure);
    await started;
    const other = pending.reader.read({ url, scope: otherScope });
    pending.reader.invalidateScope(scope);
    assert.equal((await first).code, 'GITHUB_SCOPE_CHANGED');
    await new Promise(resolve => setImmediate(resolve));
    finish();
    assert.equal((await other).hasMore, false);
    assert.deepEqual(pending.reader.snapshot(), { resources: 0, bytes: 0, active: 0, queued: 0 });
  } finally { pending.reader.dispose(); }
});

test('a local authentication failure preserves other resources and Agent cursors', async () => {
  const f = fixture(0, { fetch: async input => {
    const path = new URL(input).pathname;
    if (path.endsWith('/8')) return response({}, 401);
    return response(path.endsWith('/comments') ? [{ id: 1000, body: 'long-answer-'.repeat(5000) }] : root);
  } });
  const otherScope = { ...scope, agentId: 'agent-b' };
  try {
    const first = await f.reader.read({ url, scope });
    const other = await f.reader.read({ url, scope: otherScope });
    await assert.rejects(f.reader.read({ url: url.replace('/7', '/8'), scope }), { code: 'GITHUB_AUTH' });
    assert.equal((await f.reader.read({ url, scope, cursor: first.nextCursor })).segment, 2);
    assert.equal((await f.reader.read({ url, scope: otherScope, cursor: other.nextCursor })).segment, 2);
  } finally { f.reader.dispose(); }
});

let hostModule;
const loadHost = () => hostModule ??= (async () => {
  const webUrl = `data:text/javascript,${encodeURIComponent(`
    export class HarnessError extends Error {
      constructor(message, code) { super(message); this.name = new.target.name; this.code = code; }
    }
    export class WebError extends HarnessError {}
  `)}`;
  register(`data:text/javascript,${encodeURIComponent(`
    export function resolve(specifier, context, next) {
      return specifier === '@deepseek-ai/dsh-web'
        ? { url: ${JSON.stringify(webUrl)}, shortCircuit: true } : next(specifier, context);
    }
  `)}`, import.meta.url);
  return { ...await import('../src/core/github-host.mjs'), ...await import(webUrl) };
})();

async function hostFixture(options = {}) {
  const { createGithubIntegration, HarnessError } = await loadHost();
  const events = new Map(), effects = [];
  const definitions = new Map(), config = { enabled: true, token: '' };
  const tools = {
    register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); },
    get(name) { return definitions.get(name); }, checkGuards: () => undefined,
  };
  definitions.set('web_fetch', { timeoutMs: 30_000 });
  const ctx = {
    tools, logger: { warn() {} },
    inject(_services, apply) { apply(ctx); },
    effect(dispose) { effects.push(dispose()); },
    on(event, listener) { const listeners = events.get(event) ?? []; listeners.push(listener); events.set(event, listeners); },
    get(name) { return name === 'tools' ? tools : undefined; },
  };
  const comments = [{ id: 1000, body: 'long-answer-'.repeat(5000) }];
  const github = createGithubIntegration({ ctx, getState: () => config,
    callRoutes: { capture: () => null, finalizeRead() {}, read: () => ({ routes: options.noRoute ? [] : [{ served: 'github' }] }) },
    readerOptions: { ...options.reader, fetchImpl: async (input, init) => options.fetch
      ? options.fetch(input, init) : response(new URL(input).pathname.endsWith('/comments') ? comments : root) } });
  const run = (exec) => events.get('tools/execute')[0](exec, async () => {
    if (exec.name === 'github_read') return github.definition.execute(exec.arguments, exec);
    const caller = { tools, fiber: { uid: 1, runtime: { name: 'tool-web' },
      entry: { options: { name: '@deepseek-ai/dsh-tool-web' } }, config: { fetch: true } } };
    const original = { fetch() { assert.fail('GitHub must not fall back to the original provider'); } };
    const service = events.get('internal/get')[0](caller, 'web', undefined, () => original);
    return service.fetch({ url: exec.arguments.url }, exec.signal);
  });
  const execute = async (name, args, agent) => {
    const exec = { name, arguments: args, agent, callId: 'host-call', signal: new AbortController().signal };
    let result;
    try {
      const value = await run(exec);
      result = { isError: false, value };
    } catch (failure) {
      result = { isError: true, error: { message: failure.message,
        ...(failure instanceof HarnessError ? { info: { name: failure.name, code: failure.code } } : {}) } };
    }
    for (const observer of events.get('tools/result')) observer(exec, result);
    return result;
  };
  return { github, execute, run, config, events, tools,
    async dispose() { github.dispose(); for (const effect of effects.reverse()) await effect?.(); } };
}

test('direct and diverted GitHub failures keep their host error identity without invalidating other Agent cursors', async () => {
  const one = { session: { id: 'host-session' } }, other = { session: { id: 'host-session' } };
  const f = await hostFixture();
  try {
    const first = await f.execute('github_read', { url }, one);
    const kept = await f.execute('github_read', { url }, other);
    assert.equal(first.isError, false);
    assert.equal(kept.isError, false);
    const invalid = await f.execute('github_read', { url, cursor: 'missing' }, one);
    assert.equal(invalid.error.info?.code, 'GITHUB_CURSOR_INVALID');
    assert.equal((await f.execute('github_read', { url, cursor: kept.value.nextCursor }, other)).isError, false);
    const guarded = f.tools.checkGuards;
    f.tools.checkGuards = () => ({ reason: 'host-specific guard denial', info: { code: 'PERMISSION_DENIED' } });
    const denied = await f.execute('web_fetch', { url }, one);
    assert.equal(denied.error.info?.code, 'GITHUB_PERMISSION');
    f.tools.checkGuards = guarded;
    const afterDenied = await f.execute('github_read', { url, cursor: first.value.nextCursor }, one);
    assert.equal(afterDenied.error.info?.code, 'GITHUB_CURSOR_INVALID');
  } finally { await f.dispose(); }
});

test('both host entry points preserve sanitized upstream failure codes', async () => {
  for (const [status, code] of [[401, 'GITHUB_AUTH'], [403, 'GITHUB_FORBIDDEN'], [429, 'GITHUB_RATE_LIMIT']]) {
    for (const name of ['github_read', 'web_fetch']) {
      const f = await hostFixture({ fetch: async () => response({ message: 'private-upstream-detail' }, status) });
      try {
        const result = await f.execute(name, { url }, { session: { id: 'host-session' } });
        assert.equal(result.error.info?.code, code);
        assert.doesNotMatch(JSON.stringify(result), /private-upstream-detail/);
      } finally { await f.dispose(); }
    }
  }
});

test('post-policy failure invalidates only the affected Agent and global changes still invalidate every Agent', async () => {
  const one = { session: { id: 'host-session' } }, other = { session: { id: 'other-session' } };
  const f = await hostFixture();
  try {
    const first = await f.execute('github_read', { url }, one);
    const kept = await f.execute('github_read', { url }, other);
    const exec = { name: 'github_read', agent: one };
    for (const observer of f.events.get('tools/result')) {
      observer(exec, { isError: true, error: { info: { code: 'PERMISSION_DENIED' } } });
    }
    const denied = await f.execute('github_read', { url, cursor: first.value.nextCursor }, one);
    assert.equal(denied.error.info?.code, 'GITHUB_CURSOR_INVALID');
    assert.equal((await f.execute('github_read', { url, cursor: kept.value.nextCursor }, other)).isError, false);
    f.config.token = 'changed-fixture-token'; f.github.sync();
    assert.equal((await f.execute('github_read', { url, cursor: kept.value.nextCursor }, other)).error.info?.code, 'GITHUB_CURSOR_INVALID');
  } finally { await f.dispose(); }
});

test('a host denial before the GitHub adapter runs invalidates only that Agent existing cursors', async () => {
  for (const name of ['github_read', 'web_fetch']) {
    const one = { session: { id: 'host-session' } }, other = { session: { id: 'other-session' } };
    const f = await hostFixture({ noRoute: true });
    try {
      const first = await f.execute('github_read', { url }, one);
      const kept = await f.execute('github_read', { url }, other);
      const get = f.tools.get;
      f.tools.get = () => undefined;
      for (const observer of f.events.get('tools/result')) {
        observer({ name, agent: one, arguments: { url } },
          { isError: true, error: { info: { code: 'PERMISSION_DENIED' } } });
      }
      f.tools.get = get;
      assert.equal((await f.execute('github_read', { url, cursor: first.value.nextCursor }, one)).error.info?.code, 'GITHUB_CURSOR_INVALID');
      assert.equal((await f.execute('github_read', { url, cursor: kept.value.nextCursor }, other)).isError, false);
    } finally { await f.dispose(); }
  }
});

test('host boundaries preserve caller cancellation identity and keep local timeouts classified as failures', async () => {
  for (const name of ['github_read', 'web_fetch']) {
    const f = await hostFixture();
    const stop = new AbortController(), reason = new DOMException('caller cancelled', 'AbortError');
    stop.abort(reason);
    try {
      await assert.rejects(f.run({ name, arguments: { url }, agent: { session: { id: 'host-session' } },
        callId: 'cancelled-call', signal: stop.signal }), failure => failure === reason);
    } finally { await f.dispose(); }
  }
  for (const name of ['github_read', 'web_fetch']) {
    const f = await hostFixture({ reader: { budgetMs: 70 }, fetch: async (_input, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })) });
    try {
      await assert.rejects(f.run({ name, arguments: { url }, agent: { session: { id: 'host-session' } },
        callId: 'timed-out-call', signal: new AbortController().signal }),
      failure => failure.code === 'GITHUB_TIMEOUT' && failure.name === 'WebError');
    } finally { await f.dispose(); }
  }
});
