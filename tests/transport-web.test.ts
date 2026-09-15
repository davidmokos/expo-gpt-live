import assert from 'node:assert/strict';
import test from 'node:test';

import { createTransport } from '../src/live/transport.web';

function fakeBrowser(failAt?: 'constructor' | 'track' | 'channel') {
  const original = new Map(
    ['navigator', 'document', 'RTCPeerConnection'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const track = {
    enabled: true,
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const player = {
    autoplay: false,
    srcObject: null,
    removed: false,
    setAttribute() {},
    remove() {
      this.removed = true;
    },
    play: async () => {},
  };
  const channel = {
    readyState: 'open',
    closed: false,
    onmessage: undefined,
    onclose: undefined,
    send() {},
    close() {
      this.closed = true;
    },
  };
  let peer: FakePeer | undefined;
  class FakePeer {
    closed = false;
    ontrack?: (event: unknown) => void;
    iceGatheringState = 'complete';
    localDescription = null;
    constructor() {
      if (failAt === 'constructor') throw new Error('Setup failed');
      peer = this;
    }
    addTrack() {
      if (failAt === 'track') throw new Error('Setup failed');
    }
    createDataChannel() {
      if (failAt === 'channel') throw new Error('Setup failed');
      return channel;
    }
    close() {
      this.closed = true;
    }
    async createOffer() {
      return {};
    }
    async setLocalDescription() {}
  }
  const replacements = {
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    document: { createElement: () => player, body: { appendChild() {} } },
    RTCPeerConnection: FakePeer,
  };
  for (const [key, value] of Object.entries(replacements))
    Object.defineProperty(globalThis, key, { value, configurable: true });
  return {
    track,
    player,
    channel,
    peer: () => peer,
    restore() {
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('releases microphone capture when browser transport setup fails', async () => {
  for (const step of ['constructor', 'track', 'channel'] as const) {
    const browser = fakeBrowser(step);
    try {
      await assert.rejects(createTransport({ onEvent() {}, onFailure() {} }), /Setup failed/);
      assert.equal(browser.track.stopped, true);
      if (step !== 'constructor') {
        assert.equal(browser.peer()?.closed, true);
        assert.equal(browser.player.removed, true);
      }
    } finally {
      browser.restore();
    }
  }
});

test('closing browser audio is idempotent and ignores late playback events', async () => {
  const browser = fakeBrowser();
  let failures = 0;
  try {
    const transport = await createTransport({
      onEvent() {},
      onFailure() {
        failures++;
      },
    });
    transport.close();
    transport.close();
    browser.peer()?.ontrack?.({ streams: [] });
    assert.equal(browser.track.stopped, true);
    assert.equal(browser.channel.closed, true);
    assert.equal(browser.peer()?.closed, true);
    assert.equal(browser.player.removed, true);
    assert.equal(browser.player.srcObject, null);
    assert.equal(failures, 0);
  } finally {
    browser.restore();
  }
});

test('a missing browser SDP answer does not produce an unsafe assertion error', async () => {
  const browser = fakeBrowser();
  try {
    const transport = await createTransport({ onEvent() {}, onFailure() {} });
    await assert.rejects(transport.offer(), /Could not prepare the audio connection/);
    transport.close();
  } finally {
    browser.restore();
  }
});
