import assert from 'node:assert/strict';
import test from 'node:test';

import { createToolConnection } from '../src/live/tool-connection';

const encoder = new TextEncoder();
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let canceled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel() {
      canceled++;
    },
  });
  return {
    body,
    response: new Response(body, {
      headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
    }),
    enqueue(text: string) {
      controller.enqueue(encoder.encode(text));
    },
    enqueueBytes(bytes: Uint8Array) {
      controller.enqueue(bytes);
    },
    end() {
      controller.close();
    },
    error() {
      controller.error(new Error('network lost'));
    },
    get canceled() {
      return canceled;
    },
  };
}

test('waits for a complete ready frame and decodes split UTF-8 plus coalesced frames', async () => {
  const source = stream();
  const failures: string[] = [];
  const connection = createToolConnection({
    open: async () => source.response,
    onFailure: (message) => failures.push(message),
  });
  let ready = false;
  void connection.ready.then(() => {
    ready = true;
  });
  source.enqueue('{"type":"rea');
  await settle();
  assert.equal(ready, false);
  const bytes = encoder.encode('dy","note":"✓"}\r\n{"type":"ping"}\n');
  const split = bytes.indexOf(0xe2) + 1;
  source.enqueueBytes(bytes.slice(0, split));
  source.enqueueBytes(bytes.slice(split));
  await connection.ready;
  await settle();
  assert.equal(ready, true);
  source.enqueue('{"type":"closed"}\n');
  await settle();
  assert.deepEqual(failures, []);
  assert.equal(source.canceled, 1);
});

test('normal closure accepts a final frame without a trailing newline', async () => {
  const source = stream();
  const connection = createToolConnection({
    open: async () => source.response,
    onFailure: assert.fail,
  });
  source.enqueue('{"type":"ready"}\n');
  await connection.ready;
  source.enqueue('{"type":"closed"}');
  source.end();
  await settle();
  connection.close();
});

test('canceling before response headers rejects readiness and disposes a late response', async () => {
  const source = stream();
  let respond!: (response: Response) => void;
  let signal!: AbortSignal;
  let requests = 0;
  const connection = createToolConnection({
    open(value) {
      requests++;
      signal = value;
      return new Promise((resolve) => {
        respond = resolve;
      });
    },
    onFailure: assert.fail,
  });
  connection.close();
  connection.close();
  await assert.rejects(connection.ready, /canceled/);
  assert.equal(signal.aborted, true);
  respond(source.response);
  await settle();
  assert.equal(source.canceled, 1);
  assert.equal(requests, 1);
});

test('canceling a pending reader is immediate and does not report a network failure', async () => {
  const source = stream();
  const connection = createToolConnection({
    open: async () => source.response,
    onFailure: assert.fail,
  });
  await settle();
  connection.close();
  await assert.rejects(connection.ready, /canceled/);
  assert.equal(source.canceled, 1);
});

test('ready timeout aborts even if fetch never settles, without opening a second stream', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal!: AbortSignal;
  let requests = 0;
  const connection = createToolConnection({
    open(value) {
      signal = value;
      requests++;
      return new Promise(() => {});
    },
    onFailure: assert.fail,
  });
  t.mock.timers.tick(10_000);
  await assert.rejects(connection.ready, /did not become ready/);
  assert.equal(signal.aborted, true);
  assert.equal(requests, 1);
});

test('heartbeats extend liveness and silence for thirty seconds reports one failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = stream();
  const failures: string[] = [];
  const connection = createToolConnection({
    open: async () => source.response,
    onFailure: (message) => failures.push(message),
  });
  source.enqueue('{"type":"ready"}\n');
  await connection.ready;
  t.mock.timers.tick(20_000);
  source.enqueue('{"type":"ping"}\n');
  await settle();
  t.mock.timers.tick(29_999);
  assert.deepEqual(failures, []);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(failures.length, 1);
  assert.match(failures[0], /tool connection/);
  assert.equal(source.canceled, 1);
  t.mock.timers.tick(60_000);
  assert.equal(failures.length, 1);
});

test('backgrounding keeps the reader open and foregrounding starts a fresh heartbeat window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = stream();
  const failures: string[] = [];
  const connection = createToolConnection({
    open: async () => source.response,
    onFailure: (message) => failures.push(message),
  });
  source.enqueue('{"type":"ready"}\n');
  await connection.ready;
  t.mock.timers.tick(25_000);
  connection.setAppActive(false);
  t.mock.timers.tick(90_000);
  source.enqueue('{"type":"ping"}\n');
  await settle();
  assert.equal(source.canceled, 0);
  assert.deepEqual(failures, []);
  connection.setAppActive(true);
  t.mock.timers.tick(29_999);
  assert.deepEqual(failures, []);
  source.enqueue('{"type":"ping"}\n');
  await settle();
  t.mock.timers.tick(29_999);
  assert.deepEqual(failures, []);
  connection.close();
  assert.equal(source.canceled, 1);
});

test('backgrounding does not hide an explicit server failure', async () => {
  const source = stream();
  const failures: string[] = [];
  const connection = createToolConnection({
    open: async () => source.response,
    onFailure: (message) => failures.push(message),
  });
  connection.setAppActive(false);
  source.enqueue('{"type":"ready"}\n');
  await connection.ready;
  source.enqueue('{"type":"error","message":"Unavailable"}\n');
  await settle();
  assert.equal(failures.length, 1);
});

test('unexpected EOF and reader errors fail once after readiness', async () => {
  for (const failure of ['eof', 'network']) {
    const source = stream();
    const failures: string[] = [];
    const connection = createToolConnection({
      open: async () => source.response,
      onFailure: (message) => failures.push(message),
    });
    source.enqueue('{"type":"ready"}\n');
    await connection.ready;
    if (failure === 'eof') source.end();
    else source.error();
    await settle();
    connection.close();
    assert.equal(failures.length, 1);
  }
});

test('rejects wrong content types, HTTP failures, malformed frames and oversized buffers', async () => {
  const cases = [
    () => new Response('<html>Wrong server</html>'),
    () => new Response('Unavailable', { status: 503 }),
    ...['not-json\n', '{"type":"ping"}\n', '{"type":"unknown"}\n', 'x'.repeat(65537)].map(
      (text) => () => new Response(text, { headers: { 'Content-Type': 'application/x-ndjson' } }),
    ),
  ];
  for (const response of cases) {
    const connection = createToolConnection({
      open: async () => response(),
      onFailure: assert.fail,
    });
    await assert.rejects(connection.ready, /tool connection/);
  }
});
