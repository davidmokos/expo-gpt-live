import assert from 'node:assert/strict';
import test from 'node:test';

import { LiveRequestError, readBody } from '../src/server/http';

function request(body: BodyInit | null, headers?: HeadersInit) {
  return new Request('http://localhost/api/live-session', {
    method: 'POST',
    body,
    headers,
    ...{ duplex: 'half' },
  });
}

function tooLarge(error: unknown) {
  return (
    error instanceof LiveRequestError && error.status === 413 && error.code === 'request_too_large'
  );
}

test('decodes a JSON request whose UTF-8 characters span stream chunks', async () => {
  const body = new TextEncoder().encode('{"city":"Łódź ☀️"}');
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(body.slice(offset, ++offset));
      if (offset === body.length) controller.close();
    },
  });
  assert.deepEqual(await readBody(request(stream)), { city: 'Łódź ☀️' });
  assert.equal(stream.locked, false);
});

test('accepts a body exactly at the byte limit and rejects non-object JSON', async () => {
  const body = '{"ok":true}'.padEnd(65_536, ' ');
  assert.deepEqual(await readBody(request(body)), { ok: true });
  for (const body of [null, '', 'null', '[]', '"text"', '{broken']) {
    await assert.rejects(
      readBody(request(body)),
      (error: unknown) => error instanceof LiveRequestError && error.code === 'invalid_json',
    );
  }
});

test('rejects a declared oversized request without reading and cancels its body', async () => {
  let reads = 0;
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(100));
      },
      cancel() {
        canceled = true;
      },
    },
    { highWaterMark: 0 },
  );
  await assert.rejects(readBody(request(stream, { 'content-length': '65537' })), tooLarge);
  assert.equal(reads, 0);
  assert.equal(canceled, true);
});

test('cancels chunked overflow before consuming the rest even with a false Content-Length', async () => {
  for (const headers of [undefined, { 'content-length': '10' }]) {
    let reads = 0;
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++;
          controller.enqueue(new Uint8Array(40_000));
          if (reads === 8) controller.close();
        },
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    );
    await assert.rejects(readBody(request(stream, headers)), tooLarge);
    assert.ok(reads < 8);
    assert.equal(canceled, true);
    assert.equal(stream.locked, false);
  }
});

test('measures UTF-8 bytes instead of JavaScript string length', async () => {
  const body = JSON.stringify({ text: '☀'.repeat(22_000) });
  assert.ok(body.length < 65_536);
  await assert.rejects(readBody(request(body)), tooLarge);
});
