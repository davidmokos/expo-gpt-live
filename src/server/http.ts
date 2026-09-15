export type ServerOptions = {
  apiKey?: string;
  apiToken?: string;
  requireApiToken?: boolean;
};

const MAX_BODY_BYTES = 65_536;

export class LiveRequestError extends Error {
  constructor(
    message: string,
    public status = 502,
    public code = 'live_request_failed',
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validSessionId(value: unknown): value is string {
  // The ID is opaque. Validate path characters without assuming a prefix.
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
}

export function sanitizeMessage(message: unknown, secrets: (string | undefined)[]) {
  if (typeof message !== 'string') return 'OpenAI could not complete the Live request.';
  let safe = message;
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join('[redacted]');
  }
  return safe
    .replace(/sk-[a-zA-Z0-9_*.-]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500);
}

export async function readBody(request: Request) {
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    void request.body?.cancel().catch(() => {});
    throw new LiveRequestError('The session request is too large.', 413, 'request_too_large');
  }
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BODY_BYTES) {
          void reader.cancel().catch(() => {});
          throw new LiveRequestError('The session request is too large.', 413, 'request_too_large');
        }
        text += decoder.decode(value, { stream: true });
      }
    }
    text += decoder.decode();
  } finally {
    reader?.releaseLock();
  }
  try {
    const body: unknown = JSON.parse(text);
    if (isRecord(body)) return body;
  } catch {}
  throw new LiveRequestError('Send a JSON object.', 400, 'invalid_json');
}

export function authorize(request: Request, options: ServerOptions) {
  if (options.requireApiToken && !options.apiToken) {
    throw new LiveRequestError(
      'Set API_TOKEN on the voice server and use the same token in the app.',
      503,
      'missing_api_token',
    );
  }
  if (options.apiToken && request.headers.get('authorization') !== `Bearer ${options.apiToken}`) {
    throw new LiveRequestError(
      'This app is not authorized to access the voice service.',
      401,
      'unauthorized',
    );
  }
  if (!options.apiKey) {
    throw new LiveRequestError(
      'Set OPENAI_API_KEY on the voice server, then restart or redeploy the server.',
      503,
      'missing_api_key',
    );
  }
  return options.apiKey;
}

export function failure(error: unknown, options: ServerOptions) {
  if (error instanceof LiveRequestError) {
    return json(
      {
        error: sanitizeMessage(error.message, [options.apiKey, options.apiToken]),
        code: error.code,
      },
      error.status,
    );
  }
  return json(
    {
      error: 'Could not connect to OpenAI. Check your connection and try again.',
      code: 'connection_failed',
    },
    502,
  );
}
