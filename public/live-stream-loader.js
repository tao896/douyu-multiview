// mpegts customLoader 接口：直播连接必须立即取消，不能等待下一个网络块。
const IDLE = 0, CONNECTING = 1, BUFFERING = 2, ERROR = 3;

export class LiveStreamLoader {
  constructor(seekHandler, config) {
    this.seekHandler = seekHandler;
    this.config = config;
    this.status = IDLE;
    this.type = 'abortable-live-fetch';
    this.needStashBuffer = true;
    this.controller = null;
    this.reader = null;
  }

  isWorking() {
    return this.status === CONNECTING || this.status === BUFFERING;
  }

  open(source, range) {
    this.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.status = CONNECTING;
    // IOController 不等待 open()；在 run 内处理失败，避免未处理的 Promise。
    void this.run(source, range, controller);
  }

  async run(source, range, controller) {
    let reader;
    let received = 0;
    try {
      const url = this.config.reuseRedirectedURL && source.redirectedURL || source.url;
      const seek = this.seekHandler.getConfig(url, range);
      const headers = new Headers(seek.headers);
      for (const [name, value] of Object.entries(this.config.headers || {})) headers.set(name, value);
      const response = await fetch(seek.url, {
        headers,
        signal: controller.signal,
        mode: source.cors === false ? 'same-origin' : 'cors',
        credentials: source.withCredentials ? 'include' : 'same-origin',
        cache: 'no-store',
        referrerPolicy: source.referrerPolicy || 'no-referrer-when-downgrade',
      });
      if (controller.signal.aborted) {
        await response.body?.cancel();
        return;
      }
      if (!response.ok) {
        await response.body?.cancel();
        this.status = ERROR;
        this.onError?.('HttpStatusCodeInvalid', { code: response.status, msg: response.statusText });
        return;
      }
      reader = response.body.getReader();
      this.reader = reader;
      if (response.url && response.url !== seek.url) {
        this.onURLRedirect?.(this.seekHandler.removeURLParameters(response.url));
      }
      const length = Number(response.headers.get('Content-Length'));
      if (length > 0) this.onContentLengthKnown?.(length);
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) return;
        if (done) {
          // 无限直播流结束需要重新签名，而非对旧 URL 自动追加 Range 重试。
          this.status = ERROR;
          this.onError?.('UnrecoverableEarlyEof', { code: -1, msg: 'Live stream ended' });
          return;
        }
        this.status = BUFFERING;
        const chunk = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
          ? value.buffer : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        const start = range.from + received;
        received += chunk.byteLength;
        this.onDataArrival?.(chunk, start, received);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.status = ERROR;
        this.onError?.('Exception', { code: -1, msg: error?.message || String(error) });
      }
    } finally {
      controller.abort();
      try { await reader?.cancel(); } catch {}
      try { reader?.releaseLock(); } catch {}
      if (this.controller === controller) {
        this.controller = null;
        this.reader = null;
      }
    }
  }

  abort() {
    // 即使当前 reader.read() 永远不返回，也立刻断开请求并释放 reader。
    this.controller?.abort();
    this.reader?.cancel().catch(() => {});
    this.controller = null;
    this.reader = null;
    this.status = IDLE;
  }

  destroy() {
    this.abort();
    this.onContentLengthKnown = this.onURLRedirect = this.onDataArrival = null;
    this.onError = this.onComplete = null;
  }
}
