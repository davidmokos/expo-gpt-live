import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionAPI } from '../src/live/api-client';

const token = 'test-access-token';
const base = { isWeb: false, apiUrl: 'https://voice.example', getAccessToken: () => token };

test('validates native setup before making a request', async () => {
  let calls = 0;
  const send: typeof fetch = async () => {
    calls++;
    throw new Error('Must not run');
  };
  for (const apiUrl of [undefined, '', '   ']) {
    const api = createSessionAPI({ ...base, apiUrl, fetch: send });
    assert.throws(() => api.prepare?.(), /Set EXPO_PUBLIC_API_URL/);
  }
  for (const apiUrl of [
    'voice.example',
    'ftp://voice.example',
    'https://user:password@voice.example',
    'https://voice.example?token=value',
  ]) {
    const api = createSessionAPI({ ...base, apiUrl, fetch: send });
    assert.throws(() => api.prepare?.(), /must be an http/);
  }
  const missingToken = createSessionAPI({ ...base, getAccessToken: () => '', fetch: send });
  assert.throws(() => missingToken.prepare?.(), /EXPO_PUBLIC_API_TOKEN.*API_TOKEN/);
  assert.equal(calls, 0);
});

test('only interactive preparation asks the browser for access', async () => {
  const interactive: boolean[] = [];
  let stored = '';
  const api = createSessionAPI({
    isWeb: true,
    getAccessToken: (prompt = false) => {
      interactive.push(prompt);
      if (prompt) stored = token;
      return stored;
    },
    fetch: async (url, init) => {
      assert.equal(url, '/api/live-session');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({ sdp: 'answer', sessionId: 'live_test' });
    },
  });
  api.prepare?.();
  await api.create('offer', 'cedar');
  await api.close('live_test');
  assert.deepEqual(interactive, [true, false, false]);
});

test('missing browser authorization fails cleanup without prompting or fetching', async () => {
  let prompted = false;
  let calls = 0;
  const api = createSessionAPI({
    isWeb: true,
    getAccessToken: (interactive = false) => {
      prompted ||= interactive;
      return '';
    },
    fetch: async () => {
      calls++;
      throw new Error('Must not run');
    },
  });
  await assert.rejects(api.close('live_test'), /access token is required/);
  assert.equal(prompted, false);
  assert.equal(calls, 0);
});

test('sends the chosen voice and returns only the connection fields', async () => {
  const api = createSessionAPI({
    ...base,
    apiUrl: 'https://voice.example///',
    fetch: async (url, init) => {
      assert.equal(url, 'https://voice.example/api/live-session');
      assert.deepEqual(JSON.parse(String(init?.body)), { sdp: 'offer', voice: 'ash' });
      return Response.json({ sdp: 'answer', sessionId: 'live_test', extra: 'discarded' });
    },
  });
  assert.deepEqual(await api.create('offer', 'ash'), { sdp: 'answer', sessionId: 'live_test' });
});

test('malformed successful responses produce an actionable error', async () => {
  for (const body of [null, [], {}, { sdp: '', sessionId: 'live_test' }, { sdp: 'answer' }]) {
    const api = createSessionAPI({ ...base, fetch: async () => Response.json(body) });
    await assert.rejects(api.create('offer'), /voice server returned an invalid connection/);
  }
  const html = createSessionAPI({
    ...base,
    fetch: async () => new Response('<html>A different app</html>'),
  });
  await assert.rejects(html.create('offer'), /server URL points to this app/);
});

test('HTML gateway errors preserve the HTTP status without exposing a JSON parse error', async () => {
  const api = createSessionAPI({
    ...base,
    fetch: async () => new Response('<html>Unavailable</html>', { status: 503 }),
  });
  await assert.rejects(api.create('offer'), /HTTP 503/);
});

test('only an app authorization failure clears the browser token', async () => {
  let cleared = 0;
  let code = 'invalid_api_key';
  const api = createSessionAPI({
    ...base,
    clearAccessToken: () => {
      cleared++;
    },
    fetch: async () =>
      Response.json({ error: 'Check access configuration.', code }, { status: 401 }),
  });
  await assert.rejects(api.create('offer'), /Check access configuration/);
  assert.equal(cleared, 0);
  code = 'unauthorized';
  await assert.rejects(api.create('offer'), /Check access configuration/);
  assert.equal(cleared, 1);
});

test('a request timeout aborts once and never retries a billable create', async () => {
  let calls = 0;
  const api = createSessionAPI({
    ...base,
    timeoutMs: 5,
    fetch: async (_url, init) => {
      calls++;
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      );
    },
  });
  await assert.rejects(api.create('offer'), /Cannot reach the voice service/);
  assert.equal(calls, 1);
});
