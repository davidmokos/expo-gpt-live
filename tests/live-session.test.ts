import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type WebSocket from 'ws';

import {
  closeLiveSession,
  closeLiveSessionOnWorker,
  createLiveSessionHandlers,
} from '../src/server/live-session';
import { VOICES } from '../src/live/voices';

const offer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const answer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const fakeKey = 'sk-proj-test-secret-that-must-stay-on-the-server';
const token = 'test-api-token';

function request(body: unknown, method = 'POST', authenticated = true, signal?: AbortSignal) {
  return new Request('http://localhost/api/live-session', {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
}

test('rejects unauthorized requests before reaching OpenAI', async () => {
  let calls = 0;
  const handlers = createLiveSessionHandlers({
    apiKey: fakeKey,
    apiToken: token,
    fetch: async () => {
      calls++;
      throw new Error('Must not run');
    },
  });
  const response = await handlers.POST(request({ sdp: offer }, 'POST', false));
  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});

test('deployed handlers reject requests when their access token is missing', async () => {
  let calls = 0;
  const handlers = createLiveSessionHandlers({
    apiKey: fakeKey,
    requireApiToken: true,
    fetch: async () => {
      calls++;
      throw new Error('Must not run');
    },
    closeSession: async () => {
      calls++;
      throw new Error('Must not run');
    },
  });
  for (const method of ['POST', 'DELETE'] as const) {
    const response = await handlers[method](request({ sdp: offer, sessionId: 'live_123' }, method));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'missing_api_token');
  }
  assert.equal(calls, 0);
});

test('missing server credentials identify the setting needed for a fresh clone', async () => {
  let calls = 0;
  const send: typeof fetch = async () => {
    calls++;
    throw new Error('Must not run');
  };
  const missingKey = createLiveSessionHandlers({
    apiToken: token,
    requireApiToken: true,
    fetch: send,
  });
  const response = await missingKey.POST(request({ sdp: offer }));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Set OPENAI_API_KEY on the voice server/);
  const missingToken = createLiveSessionHandlers({
    apiKey: fakeKey,
    requireApiToken: true,
    fetch: send,
  });
  const denied = await missingToken.POST(request({ sdp: offer }));
  assert.match((await denied.json()).error, /Set API_TOKEN on the voice server/);
  assert.equal(calls, 0);
});

test('rejects malformed and oversized offers before billing a session', async () => {
  let calls = 0;
  const handlers = createLiveSessionHandlers({
    apiKey: fakeKey,
    fetch: async () => {
      calls++;
      throw new Error('Must not run');
    },
  });
  assert.equal((await handlers.POST(request({ sdp: 'not an SDP' }))).status, 400);
  assert.equal((await handlers.POST(request({ sdp: offer + 'a'.repeat(66_000) }))).status, 413);
  assert.equal(
    (
      await handlers.POST(
        new Request('http://localhost/api/live-session', { method: 'POST', body: '{broken' }),
      )
    ).status,
    400,
  );
  assert.equal(calls, 0);
});

test('a canceled request does not create a new billable session', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const handlers = createLiveSessionHandlers({
    apiKey: fakeKey,
    fetch: async () => {
      calls++;
      throw new Error('Must not run');
    },
  });
  assert.equal(
    (await handlers.POST(request({ sdp: offer }, 'POST', true, controller.signal))).status,
    499,
  );
  assert.equal(calls, 0);
});

test('uses fixed server configuration and returns only the answer and opaque session ID', async () => {
  const handlers = createLiveSessionHandlers({
    apiKey: fakeKey,
    apiToken: token,
    fetch: async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/live/sessions');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${fakeKey}`);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.session.model, 'gpt-live-1');
      assert.equal(body.session.audio.output.voice, 'marin');
      assert.equal(body.session.delegation.responses.model, 'gpt-5.6-luna');
      assert.equal(body.session.delegation.responses.max_output_tokens, 600);
      assert.equal(body.session.store, false);
      assert.deepEqual(body.transport, { type: 'webrtc', sdp: offer });
      assert.equal(body.session.audio.input, undefined);
      return Response.json(
        {
          session: { id: 'opaque_prefix-123' },
          transport: { type: 'webrtc', sdp: answer },
          secret: fakeKey,
        },
        { status: 201 },
      );
    },
  });
  const response = await handlers.POST(
    request({ sdp: offer, model: 'unwanted-model', session: { store: true } }),
  );
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { sdp: answer, sessionId: 'opaque_prefix-123' });
});

test('preserves actionable API access errors while removing credential text', async () => {
  const handlers = createLiveSessionHandlers({
    apiKey: fakeKey,
    apiToken: token,
    fetch: async () =>
      Response.json(
        {
          error: {
            code: 'model_not_found',
            message: `The project does not have access to gpt-live-1. Credential ${fakeKey}. Bearer ${token}`,
          },
        },
        { status: 403 },
      ),
  });
  const response = await handlers.POST(request({ sdp: offer }));
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, 'model_not_found');
  assert.match(body.error, /does not have access to gpt-live-1/);
  assert.ok(!body.error.includes(fakeKey));
  assert.ok(!body.error.includes(token));
});

test('forwards every supported voice without changing the default for older clients', async () => {
  const received: string[] = [];
  const handlers = createLiveSessionHandlers({
    apiKey: fakeKey,
    apiToken: token,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      received.push(body.session.audio.output.voice);
      return Response.json(
        { session: { id: 'live_voice' }, transport: { sdp: answer } },
        { status: 201 },
      );
    },
  });
  for (const { id } of VOICES) {
    assert.equal((await handlers.POST(request({ sdp: offer, voice: id }))).status, 201);
  }
  assert.equal((await handlers.POST(request({ sdp: offer }))).status, 201);
  assert.deepEqual(received, [...VOICES.map(({ id }) => id), 'marin']);
});

test('rejects invalid voice values before creating a billable session', async () => {
  let calls = 0;
  const handlers = createLiveSessionHandlers({
    apiKey: fakeKey,
    apiToken: token,
    fetch: async () => {
      calls++;
      throw new Error('Must not run');
    },
  });
  for (const voice of [
    'unknown',
    'Marin',
    '',
    'nova',
    'fable',
    'onyx',
    null,
    4,
    {},
    { id: 'voice_custom' },
  ]) {
    const response = await handlers.POST(request({ sdp: offer, voice }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'invalid_voice');
  }
  assert.equal(calls, 0);
});

test('does not retry session creation when OpenAI times out', async () => {
  let calls = 0;
  const handlers = createLiveSessionHandlers({
    apiKey: fakeKey,
    timeoutMs: 5,
    fetch: async (_url, init) => {
      calls++;
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      );
    },
  });
  const response = await handlers.POST(request({ sdp: offer }));
  assert.equal(response.status, 504);
  assert.equal(calls, 1);
});

test('closes a session created after the caller canceled its connection', async () => {
  const controller = new AbortController();
  const closed: string[] = [];
  const handlers = createLiveSessionHandlers({
    apiKey: fakeKey,
    fetch: async () => {
      controller.abort();
      return Response.json(
        { session: { id: 'live_canceled' }, transport: { sdp: answer } },
        { status: 201 },
      );
    },
    closeSession: async (sessionId) => {
      closed.push(sessionId);
    },
  });
  const response = await handlers.POST(request({ sdp: offer }, 'POST', true, controller.signal));
  assert.equal(response.status, 499);
  assert.deepEqual(closed, ['live_canceled']);
});

test('cleans up an unusable answer when OpenAI has already allocated a session', async () => {
  const closed: string[] = [];
  const handlers = createLiveSessionHandlers({
    apiKey: fakeKey,
    fetch: async () =>
      Response.json({ session: { id: 'live_invalid' }, transport: {} }, { status: 201 }),
    closeSession: async (id) => {
      closed.push(id);
    },
  });
  assert.equal((await handlers.POST(request({ sdp: offer }))).status, 502);
  assert.deepEqual(closed, ['live_invalid']);
});

test('DELETE validates its session ID and delegates closure without passing credentials to the client', async () => {
  const closed: string[] = [];
  const handlers = createLiveSessionHandlers({
    apiKey: fakeKey,
    apiToken: token,
    closeSession: async (id, key) => {
      assert.equal(key, fakeKey);
      closed.push(id);
    },
  });
  assert.equal((await handlers.DELETE(request({ sessionId: '../another' }, 'DELETE'))).status, 400);
  assert.equal((await handlers.DELETE(request({ sessionId: 'live_123' }, 'DELETE'))).status, 204);
  assert.deepEqual(closed, ['live_123']);
});

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  stopped = false;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.stopped = true;
    this.readyState = 3;
    this.emit('close');
  }
  terminate() {
    this.close();
  }
}

test('sideband close waits for session.closed before cleaning up the socket', async () => {
  const socket = new FakeSocket();
  const completion = closeLiveSession('opaque_123', fakeKey, {
    createSocket: (url, key) => {
      assert.equal(url, 'wss://api.openai.com/v1/live/sessions/opaque_123/attach');
      assert.equal(key, fakeKey);
      return socket as unknown as WebSocket;
    },
  });
  socket.emit('open');
  assert.deepEqual(
    socket.sent.map((item) => JSON.parse(item)),
    [{ type: 'session.close' }],
  );
  socket.emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'session.output_transcript.delta', delta: 'Bye' })),
  );
  assert.equal(socket.stopped, false);
  socket.emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'session.closed', usage: { seconds: 3 } })),
  );
  await completion;
  assert.equal(socket.stopped, true);
});

test('sideband transport closure alone is not reported as finalization', async () => {
  const socket = new FakeSocket();
  const completion = closeLiveSession('live_123', fakeKey, {
    createSocket: () => socket as unknown as WebSocket,
  });
  socket.emit('close');
  await assert.rejects(completion, /without final session confirmation/);
});

class FakeWorkerSocket extends EventTarget {
  readyState = 1;
  sent: string[] = [];
  accepted = false;
  stopped = false;
  accept() {
    this.accepted = true;
  }
  send(data: string) {
    assert.equal(this.accepted, true);
    this.sent.push(data);
  }
  close() {
    this.stopped = true;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
  }
}

test('Workers close uses an authenticated upgrade and waits for final session confirmation', async () => {
  const socket = new FakeWorkerSocket();
  const completion = closeLiveSessionOnWorker('opaque_123', fakeKey, {
    fetch: async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/live/sessions/opaque_123/attach');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${fakeKey}`);
      assert.equal(new Headers(init?.headers).get('upgrade'), 'websocket');
      return { status: 101, webSocket: socket } as unknown as Response;
    },
  });
  await Promise.resolve();
  assert.deepEqual(
    socket.sent.map((item) => JSON.parse(item)),
    [{ type: 'session.close' }],
  );
  socket.message({ type: 'session.output_transcript.delta', delta: 'Bye' });
  assert.equal(socket.stopped, false);
  socket.message({ type: 'session.closed' });
  await completion;
  assert.equal(socket.stopped, true);
});

test('Workers treats an already-ended sideband as a successful close', async () => {
  for (const status of [404, 410]) {
    await closeLiveSessionOnWorker('live_123', fakeKey, {
      fetch: async () => new Response(null, { status }),
    });
  }
});

test('Workers rejects failed upgrades without exposing upstream credentials', async () => {
  await assert.rejects(
    closeLiveSessionOnWorker('live_123', fakeKey, {
      fetch: async () => new Response(`Credential ${fakeKey}`, { status: 403 }),
    }),
    (error: unknown) =>
      error instanceof Error && /rejected/.test(error.message) && !error.message.includes(fakeKey),
  );
});

test('Workers rejects transport closure without session finalization', async () => {
  const socket = new FakeWorkerSocket();
  const completion = closeLiveSessionOnWorker('live_123', fakeKey, {
    fetch: async () => ({ status: 101, webSocket: socket }) as unknown as Response,
  });
  await Promise.resolve();
  socket.close();
  await assert.rejects(completion, /without final session confirmation/);
});

test('Workers aborts a stalled upgrade and never retries session closure', async () => {
  let calls = 0;
  let aborted = false;
  await assert.rejects(
    closeLiveSessionOnWorker('live_123', fakeKey, {
      timeoutMs: 5,
      fetch: async (_url, init) => {
        calls++;
        return new Promise((_resolve, reject) =>
          init?.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('aborted'));
            },
            { once: true },
          ),
        );
      },
    }),
    /without final session confirmation/,
  );
  assert.equal(calls, 1);
  assert.equal(aborted, true);
});

test('Workers closes a sideband that never confirms session finalization', async () => {
  const socket = new FakeWorkerSocket();
  await assert.rejects(
    closeLiveSessionOnWorker('live_123', fakeKey, {
      timeoutMs: 5,
      fetch: async () => ({ status: 101, webSocket: socket }) as unknown as Response,
    }),
    /without final session confirmation/,
  );
  assert.equal(socket.stopped, true);
});
