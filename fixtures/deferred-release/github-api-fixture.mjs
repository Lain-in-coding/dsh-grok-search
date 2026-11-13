// Isolated Desktop gates only. Never packaged with the product.
export function installGithubApiFixture(trace) {
  const original = globalThis.fetch;
  const patched = async (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    if (url.origin !== 'https://api.github.com') return original(input, options);
    options?.signal?.throwIfAborted();
    trace.calls.github = (trace.calls.github ?? 0) + 1;
    if (!url.pathname.startsWith('/repos/dsh-fixture/discussion/')) {
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }
    let value, headers = { 'content-type': 'application/json' };
    if (url.pathname.endsWith('/comments')) {
      const page = Number(url.searchParams.get('page')), per = Number(url.searchParams.get('per_page'));
      value = Array.from({ length: 120 }, (_, index) => ({
        id: 1000 + index, user: { login: 'fixture-author' }, body: `fixture-answer-${index} ` + 'discussion '.repeat(90),
      })).slice((page - 1) * per, page * per);
      if (page * per < 120) headers.link = `<https://api.github.com${url.pathname}?per_page=${per}&page=${page + 1}>; rel="next"`;
    } else if (url.pathname.endsWith('/reviews')) value = [];
    else value = { id: 7, title: 'Synthetic GitHub discussion', body: 'fixture-opening-answer' };
    return new Response(JSON.stringify(value), { status: 200, headers });
  };
  globalThis.fetch = patched;
  return () => { if (globalThis.fetch === patched) globalThis.fetch = original; };
}
