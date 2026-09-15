import assert from 'node:assert/strict';
import test from 'node:test';

import { executeTool, toolDefinitions } from '../src/server/tools';

const args = { location: 'Paris, France', units: 'celsius' };
const paris = {
  name: 'Paris',
  admin1: 'Île-de-France',
  country: 'France',
  latitude: 48.85,
  longitude: 2.35,
};
const weather = () => ({
  timezone: 'Europe/Paris',
  current: {
    time: '2026-09-17T12:15',
    temperature_2m: 21.2,
    apparent_temperature: 22,
    weather_code: 2,
    wind_speed_10m: 8.1,
  },
  daily: {
    time: ['2026-09-17'],
    temperature_2m_max: [24],
    temperature_2m_min: [13],
    precipitation_probability_max: [25],
  },
});

async function run(input: unknown, send: typeof fetch) {
  return JSON.parse(await executeTool('get_weather', JSON.stringify(input), { fetch: send }));
}

function responses(...bodies: unknown[]) {
  const requests: URL[] = [];
  const send: typeof fetch = async (input, init) => {
    requests.push(new URL(String(input)));
    assert.equal(init?.redirect, 'manual');
    assert.ok(init?.signal);
    assert.equal(init?.headers, undefined);
    return Response.json(bodies.shift());
  };
  return { send, requests };
}

test('publishes a strict weather schema with explicit units', () => {
  assert.equal(toolDefinitions.length, 1);
  const tool = toolDefinitions[0];
  assert.equal(tool.name, 'get_weather');
  assert.equal(tool.type, 'function');
  assert.equal(tool.strict, true);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.required, ['location', 'units']);
  assert.deepEqual(tool.parameters.properties.units.enum, ['celsius', 'fahrenheit']);
});

test('returns concise current weather and today forecast with attribution', async () => {
  const h = responses(
    { results: [paris, { ...paris, name: 'Parisot', latitude: 44.3 }] },
    weather(),
  );
  const result = await run(args, h.send);
  assert.equal(result.ok, true);
  assert.equal(result.location, 'Paris, Île-de-France, France');
  assert.equal(result.basis, 'Weather model estimate');
  assert.equal(result.current.condition, 'Partly cloudy');
  assert.equal(result.current.temperature, 21.2);
  assert.equal(result.today.high, 24);
  assert.equal(result.today.precipitationProbabilityPercent, 25);
  assert.deepEqual(result.units, { temperature: '°C', windSpeed: 'km/h' });
  assert.equal(result.source.weatherUrl, 'https://open-meteo.com/');
  assert.equal(result.source.locations, 'GeoNames');
  assert.ok(JSON.stringify(result).length < 2000);
  assert.equal(h.requests[0].origin, 'https://geocoding-api.open-meteo.com');
  assert.equal(h.requests[0].searchParams.get('name'), args.location);
  assert.equal(h.requests[0].searchParams.get('count'), '5');
  assert.equal(h.requests[1].origin, 'https://api.open-meteo.com');
  assert.equal(h.requests[1].searchParams.get('latitude'), '48.85');
  assert.equal(h.requests[1].searchParams.get('longitude'), '2.35');
  assert.equal(h.requests[1].searchParams.get('timezone'), 'auto');
  assert.equal(h.requests[1].searchParams.get('forecast_days'), '1');
});

test('calls fetch without a receiver so the same tool works on Workers', async () => {
  const bodies = [{ results: [paris] }, weather()];
  const result = await run(args, async function (this: unknown) {
    assert.equal(this, undefined);
    return Response.json(bodies.shift());
  });
  assert.equal(result.ok, true);
});

test('uses manual redirect handling and rejects redirects without following another host', async () => {
  let calls = 0;
  const result = await run(args, async (_input, init) => {
    calls++;
    assert.equal(init?.redirect, 'manual');
    return Response.redirect('https://other.example/', 302);
  });
  assert.equal(calls, 1);
  assert.equal(result.error.code, 'weather_unavailable');
});

test('requests Fahrenheit and miles per hour without silently converting values', async () => {
  const data = weather();
  data.current.temperature_2m = 70;
  const h = responses({ results: [paris] }, data);
  const result = await run({ ...args, units: 'fahrenheit' }, h.send);
  assert.equal(h.requests[1].searchParams.get('temperature_unit'), 'fahrenheit');
  assert.equal(h.requests[1].searchParams.get('wind_speed_unit'), 'mph');
  assert.equal(result.current.temperature, 70);
  assert.deepEqual(result.units, { temperature: '°F', windSpeed: 'mph' });
});

test('asks for clarification instead of choosing between equally named cities', async () => {
  const h = responses({
    results: [
      {
        ...paris,
        name: 'Springfield',
        admin1: 'Illinois',
        country: 'United States',
        latitude: 39.78,
      },
      {
        ...paris,
        name: 'Springfield',
        admin1: 'Massachusetts',
        country: 'United States',
        latitude: 42.1,
      },
    ],
  });
  const result = await run({ ...args, location: 'Springfield' }, h.send);
  assert.equal(result.error.code, 'ambiguous_location');
  assert.equal(result.candidates.length, 2);
  assert.match(result.candidates[0], /Illinois/);
  assert.match(result.candidates[1], /Massachusetts/);
  assert.equal(h.requests.length, 1);
});

test('deduplicates repeated provider results for the same coordinates', async () => {
  const h = responses({ results: [paris, paris] }, weather());
  assert.equal((await run(args, h.send)).ok, true);
});

test('a missing location returns a useful follow-up without requesting a forecast', async () => {
  const h = responses({ results: [] });
  const result = await run(args, h.send);
  assert.equal(result.error.code, 'location_not_found');
  assert.match(result.error.message, /nearby city/);
  assert.equal(h.requests.length, 1);
});

test('rejects malformed arguments and unknown tools before any network request', async () => {
  let calls = 0;
  const send: typeof fetch = async () => {
    calls++;
    throw new Error('Must not run');
  };
  for (const input of [
    null,
    [],
    {},
    { location: 'Paris' },
    { ...args, units: ['celsius'] },
    { ...args, units: 'kelvin' },
    { ...args, extra: true },
    { ...args, location: '' },
    { ...args, location: 'https://other.example/' },
    { ...args, location: 'Paris, Texas, France' },
    { ...args, location: 'x'.repeat(121) },
  ]) {
    assert.equal((await run(input, send)).error.code, 'invalid_arguments');
  }
  for (const name of ['unknown', '__proto__', 'constructor']) {
    assert.equal(
      JSON.parse(await executeTool(name, '{}', { fetch: send })).error.code,
      'unknown_tool',
    );
  }
  for (const input of ['broken JSON', 'x'.repeat(5000)]) {
    assert.equal(
      JSON.parse(await executeTool('get_weather', input, { fetch: send })).error.code,
      'invalid_arguments',
    );
  }
  assert.equal(calls, 0);
});

test('rejects malformed geocoding data and out-of-range coordinates', async () => {
  for (const body of [
    null,
    [],
    { results: 'Paris' },
    { error: true },
    { results: [null] },
    { results: [{ ...paris, latitude: 100 }] },
    { results: [{ ...paris, longitude: '2.3' }] },
    { results: [{ ...paris, name: '   ' }] },
  ]) {
    const h = responses(body);
    assert.equal((await run(args, h.send)).error.code, 'invalid_weather_data');
    assert.equal(h.requests.length, 1);
  }
});

test('rejects incomplete or internally inconsistent forecasts', async () => {
  const wrongDay = weather();
  wrongDay.daily.time = ['2026-09-16'];
  const wrongTemperatures = weather();
  wrongTemperatures.daily.temperature_2m_min = [30];
  const unknownCode = weather();
  unknownCode.current.weather_code = 42;
  const wrongProbability = weather();
  wrongProbability.daily.precipitation_probability_max = [200];
  for (const body of [
    null,
    {},
    { ...weather(), current: {} },
    wrongDay,
    wrongTemperatures,
    unknownCode,
    wrongProbability,
  ]) {
    const h = responses({ results: [paris] }, body);
    assert.equal((await run(args, h.send)).error.code, 'invalid_weather_data');
  }
});

test('keeps an unavailable precipitation probability as null rather than inventing zero', async () => {
  const data = {
    ...weather(),
    daily: { ...weather().daily, precipitation_probability_max: [null] },
  };
  const h = responses({ results: [paris] }, data);
  const result = await run(args, h.send);
  assert.equal(result.ok, true);
  assert.equal(result.today.precipitationProbabilityPercent, null);
});

test('provider failures return stable errors without exposing raw bodies or URLs', async () => {
  for (const status of [429, 500]) {
    const output = await executeTool('get_weather', JSON.stringify(args), {
      fetch: async () => new Response('upstream-secret at https://private.example/', { status }),
    });
    assert.equal(
      JSON.parse(output).error.code,
      status === 429 ? 'rate_limited' : 'weather_unavailable',
    );
    assert.ok(!output.includes('upstream-secret'));
    assert.ok(!output.includes('private.example'));
  }
  const output = await executeTool('get_weather', JSON.stringify(args), {
    fetch: async () => {
      throw new Error('credential-detail');
    },
  });
  assert.equal(JSON.parse(output).error.code, 'weather_unavailable');
  assert.ok(!output.includes('credential-detail'));
});

test('bounds the upstream response body and does not parse HTML as weather', async () => {
  for (const response of [
    new Response('<html>not data</html>'),
    new Response('x'.repeat(70_000)),
    new Response('{}', { headers: { 'content-length': '70000' } }),
  ]) {
    const output = await executeTool('get_weather', JSON.stringify(args), {
      fetch: async () => response,
    });
    assert.equal(JSON.parse(output).error.code, 'invalid_weather_data');
  }
});

test('cancels oversized responses before reading their bodies', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const output = await executeTool('get_weather', JSON.stringify(args), {
    fetch: async () => new Response(body, { headers: { 'content-length': '70000' } }),
  });
  assert.equal(JSON.parse(output).error.code, 'invalid_weather_data');
  assert.equal(cancelled, true);
});

test('a pre-cancelled call makes no requests and does not expose the abort reason', async () => {
  const controller = new AbortController();
  controller.abort('private reason');
  let calls = 0;
  const output = await executeTool('get_weather', JSON.stringify(args), {
    signal: controller.signal,
    fetch: async () => {
      calls++;
      throw new Error();
    },
  });
  assert.equal(JSON.parse(output).error.code, 'tool_cancelled');
  assert.ok(!output.includes('private reason'));
  assert.equal(calls, 0);
});

test('cancelling an in-flight request aborts the fetch and returns promptly', async () => {
  const controller = new AbortController();
  let pendingSignal: AbortSignal | null | undefined;
  const pending = executeTool('get_weather', JSON.stringify(args), {
    signal: controller.signal,
    fetch: async (_url, init) => {
      pendingSignal = init?.signal;
      return new Promise(() => {});
    },
  });
  controller.abort();
  assert.equal(JSON.parse(await pending).error.code, 'tool_cancelled');
  assert.equal(pendingSignal?.aborted, true);
});

test('the ten-second tool deadline wins even if a transport ignores abort', async () => {
  const originalTimeout = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  let fire!: () => void;
  let pendingSignal: AbortSignal | null | undefined;
  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    assert.equal(delay, 10_000);
    fire = callback;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
  try {
    const pending = executeTool('get_weather', JSON.stringify(args), {
      fetch: async (_url, init) => {
        pendingSignal = init?.signal;
        return new Promise(() => {});
      },
    });
    fire();
    assert.equal(JSON.parse(await pending).error.code, 'tool_timeout');
    assert.equal(pendingSignal?.aborted, true);
  } finally {
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClear;
  }
});
