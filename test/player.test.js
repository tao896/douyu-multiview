import test from 'node:test';
import assert from 'node:assert/strict';

class FakeVideo extends EventTarget {
  constructor() {
    super();
    this.paused = false;
    this.ended = false;
    this.readyState = 4;
    this.currentTime = 1;
    this.videoWidth = 1920;
    this.videoHeight = 1080;
    this.buffered = { length: 0 };
  }
  play() { this.paused = false; return Promise.resolve(); }
  getVideoPlaybackQuality() { return { totalVideoFrames: 10, droppedVideoFrames: 1 }; }
}

test('player refreshes stream URLs and filters routine remuxer timestamp warnings', async (t) => {
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  const oldMpegts = globalThis.mpegts;
  globalThis.document = { hidden: false };
  const urls = [];
  const logListeners = [];
  const fakeMpegts = {
    LoggingControl: {
      enableWarn: true,
      enableError: true,
      addLogListener: (listener) => logListeners.push(listener),
    },
    Events: { ERROR: 'error', MEDIA_INFO: 'media' },
    isSupported: () => true,
    createPlayer: ({ url }) => {
      urls.push(url);
      const handlers = {};
      return {
        attachMediaElement() {},
        on: (name, handler) => (handlers[name] = handler),
        load: () => handlers.media?.(),
        play: () => Promise.resolve(),
        pause() {}, unload() {}, detachMediaElement() {}, destroy() {},
      };
    },
  };
  globalThis.window = { mpegts: fakeMpegts };
  globalThis.mpegts = fakeMpegts;
  const { Player } = await import('../public/player.js');
  const error = t.mock.method(console, 'error', () => {});
  let getUrlCalls = 0;
  const player = new Player(new FakeVideo(), { getUrl: async () => `fresh-${++getUrlCalls}` });
  t.after(() => {
    player.destroy();
    globalThis.document = oldDocument;
    globalThis.window = oldWindow;
    globalThis.mpegts = oldMpegts;
  });
  await player.load({ initialUrl: 'initial' });
  await player.reload();
  assert.deepEqual(urls, ['initial', 'fresh-1']);
  assert.equal(getUrlCalls, 1);
  assert.equal(player.diagnostics().droppedFrames, 1);
  assert.equal(logListeners.length, 1, 'reload must not register duplicate log listeners');
  assert.equal(fakeMpegts.LoggingControl.enableWarn, false);
  assert.equal(fakeMpegts.LoggingControl.enableError, true);
  const warn = t.mock.method(console, 'warn', () => {});
  logListeners[0]('warn', '[MP4Remuxer] > Dropping 1 audio frame (originalDts: 158873 ms ,curRefDts: 158965.80952379006 ms)  due to dtsCorrection: -92.80952379005612 ms overlap.');
  assert.equal(warn.mock.callCount(), 0);
  logListeners[0]('warn', '[MP4Remuxer] > Large audio timestamp gap detected, may cause AV sync to drift. Silent frames will be generated to avoid unsync.\noriginalDts: 1377740 ms, curRefDts: 1370355.8435371201 ms, dtsCorrection: 7384 ms, generate: 318 frames');
  assert.equal(warn.mock.callCount(), 0, 'timestamp gaps are corrected with generated silent frames');
  logListeners[0]('warn', '[MP4Remuxer] > Unable to generate silent frame');
  assert.equal(warn.mock.callCount(), 1, 'other remuxer warnings must remain visible');
  logListeners[0]('error', '[MSEController] > SourceBuffer append failed');
  assert.equal(warn.mock.callCount(), 1, 'errors keep the native error logger without duplicate warnings');
  console.error('[MP4Remuxer] > Dropping 1 audio frame (originalDts: 312358 ms ,curRefDts: 312442.48979586404 ms) due to dtsCorrection: -84.48979586403584 ms overlap.');
  assert.equal(error.mock.callCount(), 0, 'the routine overlap message must not reach console.error');
});
