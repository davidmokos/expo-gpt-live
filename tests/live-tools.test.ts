import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveToolsHandler } from '../src/server/live-tools';
import type { SidebandOptions } from '../src/server/sideband';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const token = 'test-token';
function request(body: unknown = { sessionId: 'live_test' }, signal?: AbortSignal) {
  return new Request('http://localhost/api/live-tools', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal,
  });
}

function setup(extra: Parameters<typeof createLiveToolsHandler>[0] = {}) {
  let callbacks!: SidebandOptions;
  let connects = 0;
  let closes = 0;
  const sent: Record<string, unknown>[] = [];
  const handler = createLiveToolsHandler({
    apiKey: 'test-key',
    apiToken: token,
    connect: async (id, key, options) => {
      assert.equal(id, 'live_test');
      assert.equal(key, 'test-key');
      connects++;
      callbacks = options;
      return {
        send: (event) => {
          sent.push(event);
        },
        close: () => {
          closes++;
        },
      };
    },
    ...extra,
  });
  return {
    handler,
    sent,
    get callbacks() {
      return callbacks;
    },
    get connects() {
      return connects;
    },
    get closes() {
      return closes;
    },
  };
}

async function frame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const value = await reader.read();
  assert.equal(value.done, false);
  return JSON.parse(new TextDecoder().decode(value.value));
}

test('tools require authorization and a valid session before attaching', async () => {
  const app = setup();
  const denied = await app.handler(
    new Request('http://localhost/api/live-tools', { method: 'POST', body: '{}' }),
  );
  assert.equal(denied.status, 401);
  for (const id of ['', '../other', null, 1, 'a'.repeat(257)]) {
    assert.equal((await app.handler(request({ sessionId: id }))).status, 400);
  }
  assert.equal((await app.handler(request({ sessionId: 'x'.repeat(70_000) }))).status, 413);
  const controller = new AbortController();
  controller.abort();
  assert.equal((await app.handler(request(undefined, controller.signal))).status, 499);
  assert.equal(app.connects, 0);
});

test('ready follows attachment, heartbeat keeps streaming, cancellation releases resources', async () => {
  const app = setup({ heartbeatMs: 5 });
  const response = await app.handler(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/x-ndjson');
  assert.match(response.headers.get('cache-control')!, /no-transform/);
  const reader = response.body!.getReader();
  assert.deepEqual(await frame(reader), { type: 'ready' });
  assert.deepEqual(await frame(reader), { type: 'ping' });
  await reader.cancel();
  assert.equal(app.closes, 1);
  assert.equal(app.callbacks.signal?.aborted, true);
  assert.deepEqual(app.sent, [{ type: 'session.close' }]);
});

test('the server executes completed calls and resumes the response without forwarding private data', async () => {
  let executions = 0;
  const app = setup({
    execute: async (name, args) => {
      executions++;
      assert.equal(name, 'get_weather');
      assert.equal(args, '{"location":"Paris, France","units":"celsius"}');
      return '{"ok":true,"temperature":18}';
    },
  });
  const reader = (await app.handler(request())).body!.getReader();
  await frame(reader);
  const emit = (event: unknown) =>
    app.callbacks.onEvent({ type: 'response.event', delegation_id: 'd1', event });
  emit({ type: 'response.created', response: { id: 'r1' } });
  emit({
    type: 'response.output_item.done',
    item: {
      type: 'function_call',
      call_id: 'c1',
      name: 'get_weather',
      arguments: '{"location":"Paris, France","units":"celsius"}',
    },
  });
  emit({ type: 'response.completed', response: { id: 'r1', status: 'completed', output: [] } });
  await turn();
  assert.equal(executions, 1);
  assert.deepEqual(
    app.sent.map(({ type }) => type),
    ['response.item.create', 'response.create'],
  );
  assert.deepEqual(app.sent[0].item, {
    type: 'function_call_output',
    call_id: 'c1',
    output: '{"ok":true,"temperature":18}',
  });
  app.callbacks.onEvent({ type: 'session.closed' });
  assert.deepEqual(await frame(reader), { type: 'closed' });
  assert.equal((await reader.read()).done, true);
  assert.equal(app.closes, 1);
});

test('request abort cancels an in-flight lookup and never submits a late result', async () => {
  let signal: AbortSignal | undefined;
  let resolve!: (value: string) => void;
  const app = setup({
    execute: async (_name, _args, options) => {
      signal = options?.signal;
      return new Promise<string>((done) => {
        resolve = done;
      });
    },
  });
  const controller = new AbortController();
  const reader = (await app.handler(request(undefined, controller.signal))).body!.getReader();
  await frame(reader);
  const emit = (event: unknown) =>
    app.callbacks.onEvent({ type: 'response.event', delegation_id: 'd1', event });
  emit({ type: 'response.created', response: { id: 'r1' } });
  emit({
    type: 'response.output_item.done',
    item: { type: 'function_call', call_id: 'c1', name: 'get_weather', arguments: '{}' },
  });
  emit({ type: 'response.completed', response: { id: 'r1', status: 'completed', output: [] } });
  await turn();
  controller.abort();
  assert.equal(signal?.aborted, true);
  resolve('late');
  await turn();
  assert.deepEqual(app.sent, [{ type: 'session.close' }]);
  assert.equal((await reader.read()).done, true);
});

test('connection failures and deadlines produce a safe error and finish the stream', async () => {
  for (const extra of [
    {
      connect: async () => {
        throw new Error('private-key upstream failure');
      },
    },
    { lifetimeMs: 5 },
  ]) {
    const app = setup(extra);
    const reader = (await app.handler(request())).body!.getReader();
    let event = await frame(reader);
    if (event.type === 'ready') event = await frame(reader);
    assert.equal(event.type, 'error');
    assert.match(event.message, /Start a new conversation/);
    assert.doesNotMatch(JSON.stringify(event), /private-key/);
    assert.equal((await reader.read()).done, true);
  }
});

test('unexpected sideband loss ends once, while a late attachment is closed after cancellation', async () => {
  const app = setup();
  const reader = (await app.handler(request())).body!.getReader();
  await frame(reader);
  app.callbacks.onClose();
  app.callbacks.onError();
  assert.equal((await frame(reader)).type, 'error');
  assert.equal((await reader.read()).done, true);
  assert.equal(app.closes, 1);

  let complete!: (value: { send(): void; close(): void }) => void;
  let closed = 0;
  const late = setup({
    connect: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  const lateReader = (await late.handler(request())).body!.getReader();
  await lateReader.cancel();
  complete({
    send() {},
    close() {
      closed++;
    },
  });
  await turn();
  assert.equal(closed, 1);
});
