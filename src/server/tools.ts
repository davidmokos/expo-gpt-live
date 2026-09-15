// Open-Meteo's no-key endpoint is for non-commercial use. Weather is modeled,
// not a live station observation. See https://open-meteo.com/en/terms.
// API references: https://open-meteo.com/en/docs and /en/docs/geocoding-api.

const TOOL_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;
const SOURCE = {
  weather: 'Open-Meteo',
  weatherUrl: 'https://open-meteo.com/',
  locations: 'GeoNames',
  locationsUrl: 'https://www.geonames.org/',
};

type Options = { signal?: AbortSignal; fetch?: typeof fetch };
type Context = { signal: AbortSignal; fetch: typeof fetch };
type Place = { name: string; label: string; latitude: number; longitude: number };

class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
    public candidates?: string[],
  ) {
    super(message);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function number(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function text(value: unknown, max = 80): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f]/.test(value)
  );
}

function invalidData(): never {
  throw new ToolError(
    'invalid_weather_data',
    'The weather provider returned incomplete data. Try again later.',
  );
}

async function readJSON(url: URL, context: Context): Promise<unknown> {
  context.signal.throwIfAborted();
  // Workers fetch must not receive the context object as its receiver. Manual
  // redirects also work on Workers; the status check below rejects redirects.
  const send = context.fetch;
  const response = await send(url, { signal: context.signal, redirect: 'manual' });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    if (response.status === 429)
      throw new ToolError('rate_limited', 'The weather service is busy. Try again later.');
    throw new ToolError(
      'weather_unavailable',
      'The weather service is unavailable. Try again later.',
    );
  }
  if (!response.body || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    invalidData();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = '';
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        invalidData();
      }
      content += decoder.decode(value, { stream: true });
    }
    content += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(content);
  } catch {
    return invalidData();
  }
}

function place(value: unknown): Place | null {
  if (!record(value) || !text(value.name) || !number(value.latitude) || !number(value.longitude))
    return null;
  if (Math.abs(value.latitude) > 90 || Math.abs(value.longitude) > 180) return null;
  const parts = [value.name, value.admin1, value.country].filter((part): part is string =>
    text(part),
  );
  return {
    name: value.name,
    label: [...new Set(parts)].join(', '),
    latitude: value.latitude,
    longitude: value.longitude,
  };
}

function normalized(value: string) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

// WMO codes documented by Open-Meteo. These labels describe the returned code;
// they do not infer weather from temperature or precipitation probability.
const CONDITIONS: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Light rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Light snow',
  73: 'Moderate snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Light rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Light snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

async function getWeather(args: Record<string, unknown>, context: Context) {
  if (
    Object.keys(args).length !== 2 ||
    typeof args.location !== 'string' ||
    typeof args.units !== 'string' ||
    !['celsius', 'fahrenheit'].includes(args.units)
  ) {
    throw new ToolError(
      'invalid_arguments',
      'Provide location and units, where units is celsius or fahrenheit.',
    );
  }
  const location = args.location.trim();
  if (
    location.length < 2 ||
    location.length > 120 ||
    !/^[\p{L}\p{M}\p{N} .,'’()-]+$/u.test(location) ||
    location.split(',').length > 2
  ) {
    throw new ToolError(
      'invalid_arguments',
      'Use a city name, optionally followed by one country or region, such as Paris, France.',
    );
  }
  const geocoding = new URL('https://geocoding-api.open-meteo.com/v1/search');
  geocoding.search = new URLSearchParams({
    name: location,
    count: '5',
    language: 'en',
    format: 'json',
  }).toString();
  const matches = await readJSON(geocoding, context);
  if (!record(matches) || (matches.results !== undefined && !Array.isArray(matches.results)))
    invalidData();
  if (matches.error) invalidData();
  const results = matches.results ?? [];
  if (!results.length) {
    throw new ToolError(
      'location_not_found',
      'No matching city was found. Ask for a nearby city and its country or region.',
    );
  }
  const places = results.map(place);
  if (places.some((candidate) => !candidate)) invalidData();
  const distinct = [
    ...new Map(
      (places as Place[]).map((candidate) => [
        `${candidate.latitude},${candidate.longitude}`,
        candidate,
      ]),
    ).values(),
  ];
  // Prefix search can include nearby names such as Paris and Parisot. Prefer
  // exact city names, but never silently choose between multiple exact cities.
  const city = normalized(location.split(',')[0].trim());
  const exact = distinct.filter((candidate) => normalized(candidate.name) === city);
  const candidates = exact.length ? exact : distinct;
  if (candidates.length !== 1) {
    throw new ToolError(
      'ambiguous_location',
      'Several locations match. Ask which country or region the user means.',
      candidates.slice(0, 5).map((candidate) => candidate.label),
    );
  }
  const resolved = candidates[0];
  const fahrenheit = args.units === 'fahrenheit';
  const forecast = new URL('https://api.open-meteo.com/v1/forecast');
  forecast.search = new URLSearchParams({
    latitude: String(resolved.latitude),
    longitude: String(resolved.longitude),
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    temperature_unit: String(args.units),
    wind_speed_unit: fahrenheit ? 'mph' : 'kmh',
    timezone: 'auto',
    forecast_days: '1',
  }).toString();
  const data = await readJSON(forecast, context);
  if (!record(data) || !record(data.current) || !record(data.daily)) invalidData();
  const current = data.current;
  const daily = data.daily;
  const first = (key: string) =>
    Array.isArray(daily[key]) && daily[key].length === 1 ? daily[key][0] : undefined;
  const high = first('temperature_2m_max');
  const low = first('temperature_2m_min');
  const rain = first('precipitation_probability_max');
  const date = first('time');
  if (
    !text(data.timezone, 64) ||
    !text(current.time, 25) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(current.time) ||
    date !== current.time.slice(0, 10) ||
    !number(current.temperature_2m) ||
    !number(current.apparent_temperature) ||
    !number(current.wind_speed_10m) ||
    current.wind_speed_10m < 0 ||
    !number(current.weather_code) ||
    !Object.hasOwn(CONDITIONS, current.weather_code) ||
    !number(high) ||
    !number(low) ||
    low > high ||
    (rain !== null && (!number(rain) || rain < 0 || rain > 100))
  )
    invalidData();
  return {
    ok: true,
    location: resolved.label,
    timezone: data.timezone,
    basis: 'Weather model estimate',
    units: { temperature: fahrenheit ? '°F' : '°C', windSpeed: fahrenheit ? 'mph' : 'km/h' },
    current: {
      time: current.time,
      temperature: current.temperature_2m,
      feelsLike: current.apparent_temperature,
      condition: CONDITIONS[current.weather_code],
      windSpeed: current.wind_speed_10m,
    },
    today: { date, high, low, precipitationProbabilityPercent: rain },
    source: SOURCE,
  };
}

// Add another entry here to publish its schema and route execution together.
const registry = {
  get_weather: {
    definition: {
      type: 'function' as const,
      name: 'get_weather',
      description:
        "Get current modeled weather and today's forecast for a city. Include a country or region after one comma when known. Ask the user to clarify ambiguous locations. Credit Open-Meteo in the answer.",
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'City, optionally with one country or region, for example Paris, France.',
          },
          units: { type: 'string', enum: ['celsius', 'fahrenheit'] },
        },
        required: ['location', 'units'],
        additionalProperties: false,
      },
    },
    execute: getWeather,
  },
};

export const toolDefinitions = Object.values(registry).map((tool) => tool.definition);

export async function executeTool(
  name: string,
  argumentsJson: string,
  options: Options = {},
): Promise<string> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      'abort',
      () =>
        reject(
          new ToolError(
            timedOut ? 'tool_timeout' : 'tool_cancelled',
            timedOut
              ? 'The weather lookup took too long. Try again later.'
              : 'The tool request was cancelled.',
          ),
        ),
      { once: true },
    );
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TOOL_TIMEOUT_MS);
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (options.signal?.aborted) {
      throw new ToolError('tool_cancelled', 'The tool request was cancelled.');
    }
    if (!Object.hasOwn(registry, name))
      throw new ToolError('unknown_tool', 'This tool is not available.');
    if (typeof argumentsJson !== 'string' || argumentsJson.length > 4096) {
      throw new ToolError('invalid_arguments', 'Tool arguments must be a small JSON object.');
    }
    let args: unknown;
    try {
      args = JSON.parse(argumentsJson);
    } catch {
      throw new ToolError('invalid_arguments', 'Tool arguments must be a JSON object.');
    }
    if (!record(args))
      throw new ToolError('invalid_arguments', 'Tool arguments must be a JSON object.');
    const tool = registry[name as keyof typeof registry];
    const result = await Promise.race([
      tool.execute(args, { signal: controller.signal, fetch: options.fetch ?? fetch }),
      aborted,
    ]);
    return JSON.stringify(result);
  } catch (error) {
    if (controller.signal.aborted) {
      error = new ToolError(
        timedOut ? 'tool_timeout' : 'tool_cancelled',
        timedOut
          ? 'The weather lookup took too long. Try again later.'
          : 'The tool request was cancelled.',
      );
    }
    if (error instanceof ToolError) {
      return JSON.stringify({
        ok: false,
        error: { code: error.code, message: error.message },
        ...(error.candidates ? { candidates: error.candidates, source: SOURCE } : {}),
      });
    }
    return JSON.stringify({
      ok: false,
      error: {
        code: 'weather_unavailable',
        message: 'Could not retrieve weather data. Try again later.',
      },
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancel);
  }
}
