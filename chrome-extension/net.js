export class RequestError extends Error {
  constructor(message, { status = 0, code, retryable = false } = {}) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function extensionRuntime() {
  const runtime = globalThis.chrome?.runtime;
  return runtime?.id && typeof runtime.sendMessage === 'function' ? runtime : null;
}

function fetchExtensionApi(runtime, url, { signal, timeout }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, new DOMException('请求已取消', 'AbortError'));
    const timer = setTimeout(() => {
      timedOut = true;
      finish(reject, new RequestError('请求超时', { status: 408, code: 'TIMEOUT', retryable: true }));
    }, timeout);

    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    runtime.sendMessage({ type: 'douyu-api', path: String(url) }, (response) => {
      if (settled || timedOut) return;
      const runtimeError = runtime.lastError;
      if (runtimeError) {
        finish(reject, new RequestError(`扩展后台通信失败：${runtimeError.message}`, { retryable: true }));
        return;
      }
      if (!response?.ok) {
        finish(reject, new RequestError(response?.error || '请求失败', {
          status: Number(response?.status) || 502,
          code: response?.code,
          retryable: Number(response?.status) >= 500 || Number(response?.status) === 429,
        }));
        return;
      }
      finish(resolve, response.data);
    });
  });
}

export async function fetchJson(url, { signal, timeout = 12_000, fetchImpl = fetch } = {}) {
  const runtime = extensionRuntime();
  if (runtime && fetchImpl === globalThis.fetch && String(url).startsWith('/api/')) {
    return fetchExtensionApi(runtime, url, { signal, timeout });
  }
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);

  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.error) {
      throw new RequestError(
        typeof data?.error === 'string' ? data.error : `请求失败 HTTP ${response.status}`,
        {
          status: response.status,
          code: data?.code,
          retryable: response.status >= 500 || response.status === 429,
        }
      );
    }
    if (data == null) throw new RequestError('响应解析失败', { status: response.status, retryable: true });
    return data;
  } catch (error) {
    if (timedOut) throw new RequestError('请求超时', { status: 408, code: 'TIMEOUT', retryable: true });
    if (signal?.aborted || error?.name === 'AbortError') {
      throw new DOMException('请求已取消', 'AbortError');
    }
    if (error instanceof RequestError) throw error;
    throw new RequestError(`网络请求失败：${error?.message || error}`, { retryable: true });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function isAbortError(error) {
  return error?.name === 'AbortError';
}
