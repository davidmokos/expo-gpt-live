import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type WebSocket from 'ws';

import { closeLiveSession, closeLiveSessionOnWorker } from '../src/server/close-session';
import { LiveRequestError } from '../src/server/http';
import {
  connectSideband,
  connectWorkerSideband,
  SidebandError,
  type SidebandOptions,
} from '../src/server/sideband';

const fakeKey = 'test-private-sideband-key';

function callbacks() {
  const events: unknown[] = [];
  const calls = { closed: 0, errors: 0 };
  const options: SidebandOptions = {
    onEvent: (event) => events.push(event),
    onClose: () => calls.closed++,
    onError: () => calls.errors++,
  };
  return { options, calls, events };
}

class NodeSocket extends EventEmitter {
  readyState = 0;
  sent: string[] = [];
  closes = 0;
  terminations = 0;
  sendError?: Error;

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  send(data: string, done?: (error?: Error) => void) {
    this.sent.push(data);
    done?.(this.sendError);
  }

  close() {
    this.closes++;
    this.readyState = 3;
    this.emit('close');
  }

  terminate() {
    this.terminations++;
    // Real ws emits an error when terminating a pending handshake.
    this.emit('error', new Error(`raw failure containing ${fakeKey}`));
    this.readyState = 3;
    this.emit('close');
  }
}

function nodeOptions(socket: NodeSocket, options: SidebandOptions): SidebandOptions {
  return {
    ...options,
    createSocket: (url, key) => {
      assert.equal(url, 'wss://api.openai.com/v1/live/sessions/live_test/attach');
      assert.equal(key, fakeKey);
      return socket as unknown as WebSocket;
    },
  };
}

class WorkerSocket extends EventTarget {
  readyState = 1;
  accepted = 0;
  closes = 0;
  sent: string[] = [];
  sendError?: Error;

  accept() {
    this.accepted++;
  }

  send(data: string) {
    assert.equal(this.accepted, 1);
    if (this.sendError) throw this.sendError;
    this.sent.push(data);
  }

  close() {
    assert.equal(this.accepted, 1);
    this.closes++;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }

  message(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

function upgrade(socket: WorkerSocket) {
  return { status: 101, body: null, webSocket: socket } as unknown as Response;
}

function workerOptions(socket: WorkerSocket, options: SidebandOptions): SidebandOptions {
  return {
    ...options,
    fetch: async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/live/sessions/live_test/attach');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${fakeKey}`);
      assert.equal(new Headers(init?.headers).get('upgrade'), 'websocket');
      return upgrade(socket);
    },
  };
}

test('Node sideband waits for open, sends JSON, ignores malformed/binary data and cleans up', async () => {
  const socket = new NodeSocket();
  const { options, events, calls } = callbacks();
  const controller = new AbortController();
  let ready = false;
  const pending = connectSideband(
    'live_test',
    fakeKey,
    nodeOptions(socket, { ...options, signal: controller.signal, timeoutMs: 5 }),
  ).then((sideband) => {
    ready = true;
    return sideband;
  });
  await Promise.resolve();
  assert.equal(ready, false);
  socket.open();
  const sideband = await pending;
  sideband.send({ type: 'tool.result', result: 'sunny' });
  socket.emit('message', Buffer.from('{broken'), false);
  socket.emit('message', Buffer.from('{"type":"binary"}'), true);
  socket.emit('message', Buffer.from('{"type":"tool.call"}'), false);
  assert.deepEqual(events, [{ type: 'tool.call' }]);
  assert.deepEqual(
    socket.sent.map((value) => JSON.parse(value)),
    [{ type: 'tool.result', result: 'sunny' }],
  );
  await delay(10);
  assert.deepEqual(calls, { closed: 0, errors: 0 });
  sideband.close();
  sideband.close();
  controller.abort();
  assert.equal(socket.closes, 1);
  assert.deepEqual(socket.eventNames(), []);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(calls, { closed: 0, errors: 0 });
  assert.throws(() => sideband.send({ type: 'late' }), SidebandError);
});

test('Node upgrade rejection preserves only the HTTP status and drains its response', async () => {
  for (const status of [401, 404, 410, 500]) {
    const socket = new NodeSocket();
    const { options, calls } = callbacks();
    let drained = false;
    const pending = connectSideband('live_test', fakeKey, nodeOptions(socket, options));
    socket.emit(
      'unexpected-response',
      {},
      {
        statusCode: status,
        resume() {
          drained = true;
        },
      },
    );
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof SidebandError);
      assert.equal(error.status, status);
      assert.ok(!error.message.includes(fakeKey));
      return true;
    });
    assert.equal(drained, true);
    assert.equal(socket.terminations, 1);
    assert.deepEqual(socket.eventNames(), []);
    assert.deepEqual(calls, { closed: 0, errors: 0 });
  }
});

test('Node startup exceptions and premature close become sanitized connection errors', async () => {
  const { options } = callbacks();
  await assert.rejects(
    connectSideband('live_test', fakeKey, {
      ...options,
      createSocket: () => {
        throw new Error(fakeKey);
      },
    }),
    (error: unknown) => error instanceof SidebandError && !error.message.includes(fakeKey),
  );
  const socket = new NodeSocket();
  const pending = connectSideband('live_test', fakeKey, nodeOptions(socket, options));
  socket.close();
  await assert.rejects(pending, SidebandError);
  assert.deepEqual(socket.eventNames(), []);
});

test('Node pending handshake times out or aborts and suppresses termination errors', async () => {
  for (const abort of [false, true]) {
    const socket = new NodeSocket();
    const { options, calls } = callbacks();
    const controller = new AbortController();
    const pending = connectSideband(
      'live_test',
      fakeKey,
      nodeOptions(socket, { ...options, timeoutMs: 5, signal: controller.signal }),
    );
    if (abort) controller.abort(new Error(fakeKey));
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof SidebandError);
      assert.equal(error.status, abort ? 499 : 504);
      assert.ok(!error.message.includes(fakeKey));
      return true;
    });
    assert.equal(socket.terminations, 1);
    assert.deepEqual(socket.eventNames(), []);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.deepEqual(calls, { closed: 0, errors: 0 });
  }
});

test('pre-aborted Node and Worker connections never start a network request', async () => {
  const { options } = callbacks();
  const controller = new AbortController();
  controller.abort();
  let starts = 0;
  const aborted = {
    ...options,
    signal: controller.signal,
    createSocket: () => {
      starts++;
      throw new Error('Must not run');
    },
    fetch: async () => {
      starts++;
      throw new Error('Must not run');
    },
  };
  await assert.rejects(connectSideband('live_test', fakeKey, aborted), SidebandError);
  await assert.rejects(connectWorkerSideband('live_test', fakeKey, aborted), SidebandError);
  assert.equal(starts, 0);
});

test('Node unexpected close/error is reported once after ready; post-open abort is intentional', async () => {
  for (const kind of ['close', 'error', 'abort', 'sendError']) {
    const socket = new NodeSocket();
    const { options, calls } = callbacks();
    const controller = new AbortController();
    const pending = connectSideband(
      'live_test',
      fakeKey,
      nodeOptions(socket, { ...options, signal: controller.signal }),
    );
    socket.open();
    const sideband = await pending;
    if (kind === 'close') socket.close();
    if (kind === 'error') socket.emit('error', new Error(fakeKey));
    if (kind === 'abort') controller.abort();
    if (kind === 'sendError') {
      socket.sendError = new Error(fakeKey);
      sideband.send({ type: 'tool.result' });
    }
    sideband.close();
    assert.deepEqual(calls, {
      closed: kind === 'close' ? 1 : 0,
      errors: kind === 'error' || kind === 'sendError' ? 1 : 0,
    });
    assert.deepEqual(socket.eventNames(), []);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('Worker upgrades authenticate, accept once, stream events and detach on intentional close', async () => {
  const socket = new WorkerSocket();
  const { options, calls, events } = callbacks();
  const controller = new AbortController();
  const sideband = await connectWorkerSideband(
    'live_test',
    fakeKey,
    workerOptions(socket, { ...options, signal: controller.signal, timeoutMs: 5 }),
  );
  assert.equal(socket.accepted, 1);
  sideband.send({ type: 'tool.result' });
  socket.message('{bad json');
  socket.message(new Uint8Array([1]));
  socket.message('{"type":"tool.call"}');
  assert.deepEqual(events, [{ type: 'tool.call' }]);
  assert.deepEqual(socket.sent, ['{"type":"tool.result"}']);
  await delay(10);
  sideband.close();
  sideband.close();
  controller.abort();
  socket.message('{"type":"late"}');
  assert.deepEqual(events, [{ type: 'tool.call' }]);
  assert.equal(socket.closes, 1);
  assert.deepEqual(calls, { closed: 0, errors: 0 });
  for (const event of ['message', 'error', 'close']) {
    assert.equal(getEventListeners(socket, event).length, 0);
  }
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('Worker rejected/missing upgrades cancel the response body without exposing it', async () => {
  for (const status of [200, 401, 404, 410, 500]) {
    const { options, calls } = callbacks();
    let canceled = false;
    const body = new ReadableStream({
      cancel() {
        canceled = true;
      },
    });
    await assert.rejects(
      connectWorkerSideband('live_test', fakeKey, {
        ...options,
        fetch: async () => new Response(body, { status }),
      }),
      (error: unknown) =>
        error instanceof SidebandError && error.status === (status >= 400 ? status : 502),
    );
    assert.equal(canceled, true);
    assert.deepEqual(calls, { closed: 0, errors: 0 });
  }
});

test('Worker timeout and abort cancel fetch and dispose a late successful upgrade', async () => {
  for (const abort of [false, true]) {
    const socket = new WorkerSocket();
    const { options, calls } = callbacks();
    const controller = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    let complete!: (response: Response) => void;
    const pending = connectWorkerSideband('live_test', fakeKey, {
      ...options,
      signal: controller.signal,
      timeoutMs: 5,
      fetch: async (_url, init) => {
        fetchSignal = init?.signal ?? undefined;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    });
    if (abort) controller.abort(new Error(fakeKey));
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof SidebandError && error.status === (abort ? 499 : 504),
    );
    assert.equal(fetchSignal?.aborted, true);
    complete(upgrade(socket));
    await delay(0);
    assert.equal(socket.accepted, 1);
    assert.equal(socket.closes, 1);
    for (const event of ['message', 'error', 'close']) {
      assert.equal(getEventListeners(socket, event).length, 0);
    }
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.deepEqual(calls, { closed: 0, errors: 0 });
  }
});

test('Worker unexpected close/error is reported once; abort and send failure clean up', async () => {
  for (const kind of ['close', 'error', 'abort', 'sendError']) {
    const socket = new WorkerSocket();
    const { options, calls } = callbacks();
    const controller = new AbortController();
    const sideband = await connectWorkerSideband(
      'live_test',
      fakeKey,
      workerOptions(socket, { ...options, signal: controller.signal }),
    );
    if (kind === 'close') socket.close();
    if (kind === 'error') socket.dispatchEvent(new Event('error'));
    if (kind === 'abort') controller.abort();
    if (kind === 'sendError') {
      socket.sendError = new Error(fakeKey);
      assert.throws(
        () => sideband.send({ type: 'tool.result' }),
        (error: unknown) => error instanceof SidebandError && !error.message.includes(fakeKey),
      );
    }
    sideband.close();
    socket.dispatchEvent(new Event('error'));
    assert.deepEqual(calls, {
      closed: kind === 'close' ? 1 : 0,
      errors: kind === 'error' || kind === 'sendError' ? 1 : 0,
    });
    for (const event of ['message', 'error', 'close']) {
      assert.equal(getEventListeners(socket, event).length, 0);
    }
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('Worker network failures reject with a sanitized error', async () => {
  const { options } = callbacks();
  await assert.rejects(
    connectWorkerSideband('live_test', fakeKey, {
      ...options,
      fetch: async () => {
        throw new Error(fakeKey);
      },
    }),
    (error: unknown) => error instanceof SidebandError && !error.message.includes(fakeKey),
  );
});

test('shared session closure sends once and waits for a confirmed close on both runtimes', async () => {
  const node = new NodeSocket();
  const nodeClose = closeLiveSession('live_test', fakeKey, {
    createSocket: () => node as unknown as WebSocket,
  });
  node.open();
  await delay(0);
  assert.deepEqual(node.sent, ['{"type":"session.close"}']);
  assert.equal(node.closes, 0);
  node.emit('message', Buffer.from('{"type":"session.closed"}'), false);
  await nodeClose;
  assert.equal(node.closes, 1);
  assert.deepEqual(node.eventNames(), []);

  const worker = new WorkerSocket();
  const workerClose = closeLiveSessionOnWorker('live_test', fakeKey, {
    fetch: async () => upgrade(worker),
  });
  await delay(0);
  assert.deepEqual(worker.sent, ['{"type":"session.close"}']);
  assert.equal(worker.closes, 0);
  worker.message('{"type":"session.closed"}');
  await workerClose;
  assert.equal(worker.closes, 1);
});

test('shared session closure preserves rejection codes and accepts already-ended sessions', async () => {
  for (const status of [404, 410]) {
    await closeLiveSessionOnWorker('live_test', fakeKey, {
      fetch: async () => new Response(null, { status }),
    });
  }
  await assert.rejects(
    closeLiveSessionOnWorker('live_test', fakeKey, {
      fetch: async () => new Response(fakeKey, { status: 403 }),
    }),
    (error: unknown) =>
      error instanceof LiveRequestError &&
      error.status === 502 &&
      error.code === 'close_rejected' &&
      !error.message.includes(fakeKey),
  );
  await assert.rejects(
    closeLiveSessionOnWorker('live_test', fakeKey, {
      fetch: async () => {
        throw new Error(fakeKey);
      },
    }),
    (error: unknown) =>
      error instanceof LiveRequestError && error.code === 'close_connection_failed',
  );
});

test('shared session closure treats socket loss, protocol rejection and missing confirmation distinctly', async () => {
  for (const kind of ['close', 'error', 'timeout']) {
    const socket = new WorkerSocket();
    const pending = closeLiveSessionOnWorker('live_test', fakeKey, {
      fetch: async () => upgrade(socket),
      timeoutMs: 10,
    });
    await delay(0);
    if (kind === 'close') socket.close();
    if (kind === 'error') socket.message(JSON.stringify({ type: 'error', message: fakeKey }));
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof LiveRequestError);
      assert.equal(
        error.code,
        kind === 'close'
          ? 'close_unconfirmed'
          : kind === 'error'
            ? 'close_rejected'
            : 'close_timeout',
      );
      assert.equal(error.status, kind === 'timeout' ? 504 : 502);
      assert.ok(!error.message.includes(fakeKey));
      return true;
    });
    assert.equal(socket.closes, 1);
  }
});
