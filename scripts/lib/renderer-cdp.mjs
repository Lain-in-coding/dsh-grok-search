const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function pageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find(row => row.type === 'page' && row.webSocketDebuggerUrl);
        if (target) return target;
      }
    } catch (error) {
      last = error;
    }
    await sleep(100);
  }
  throw new Error('Desktop renderer CDP target did not become ready.' + (last ? ' ' + last.message : ''));
}

export async function connectRenderer(port, { timeoutMs = 20_000, requestTimeoutMs = 15_000 } = {}) {
  const target = await pageTarget(port, timeoutMs);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Renderer CDP WebSocket timed out.')), timeoutMs);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Renderer CDP WebSocket failed.')); }, { once: true });
  });
  let serial = 0;
  const pending = new Map();
  const consoleEntries = [];
  const exceptions = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params.exceptionDetails;
      exceptions.push({ text: detail.text, description: detail.exception?.description,
        url: detail.url, lineNumber: detail.lineNumber });
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      consoleEntries.push({
        type: message.params.type,
        timestamp: message.params.timestamp,
        text: (message.params.args ?? []).map(arg => arg.value ?? arg.description ?? '').join(' '),
      });
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return;
      reject(new Error(`Renderer CDP request timed out: ${method}`));
    }, requestTimeoutMs);
    timer.unref?.();
    pending.set(id, {
      resolve(value) { clearTimeout(timer); resolve(value); },
      reject(error) { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text ?? 'Renderer evaluation failed.');
    }
    return result.result?.value;
  };
  return Object.freeze({
    target,
    send,
    evaluate,
    consoleEntries,
    exceptions,
    close() { socket.close(); },
  });
}

export async function waitForRenderer(renderer, predicate, { timeoutMs = 20_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate(renderer);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error('Renderer condition did not become true.' + (lastError ? ' Last error: ' + lastError.message : ''));
}
