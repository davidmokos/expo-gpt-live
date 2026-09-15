import type NodeWebSocket from 'ws';
import { DEFAULT_VOICE, isLiveVoice } from '../live/voices';

const LIVE_URL = 'https://api.openai.com/v1/live/sessions';
const MAX_BODY_BYTES = 65_536;

export const liveSessionConfig = {
  model: 'gpt-live-1',
  audio: { output: { voice: DEFAULT_VOICE } },
  store: false,
  instructions: `You are Aura, a warm, curious voice companion. Speak naturally and clearly, with short conversational answers. You are an AI assistant. Follow the user's language after they speak.

Backchannel policy: Use moderate backchannels. Acknowledge naturally without competing with the main response.

Interruption policy: Stop speaking when the user interrupts. Listen to what they say, including corrections.

Delegation policy:
Backend tools:
- Reasoning: answer questions that need careful reasoning, calculations, or general knowledge.
Delegate to the backend when:
- An answer needs careful reasoning or factual detail beyond a simple conversational reply.
- A correction changes the work already requested.
Do not delegate to the backend when:
- You can answer from the conversation or a still-current result.
- The user greets you, makes small talk, or needs a brief clarification.
Delegate before giving an answer that depends on backend work. Do not guess results while waiting. The backend cannot browse the web or act in external apps.`,
  delegation: {
    type: 'responses',
    responses: {
      model: 'gpt-5.6-luna',
      reasoning: { effort: 'low' },
      max_output_tokens: 600,
      instructions:
        'Help with reasoning, calculations, and general knowledge. Return a concise, accurate result for a spoken conversation. Say when information is uncertain or may be outdated. You have no browsing or external action tools.',
    },
  },
} as const;

export class LiveRequestError extends Error {
  constructor(
    message: string,
    public status = 502,
    public code = 'live_request_failed',
  ) {
    super(message);
  }
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validSessionId(value: unknown): value is string {
  // The ID is opaque. Validate path characters without assuming a prefix.
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
}

function sanitizeMessage(message: unknown, secrets: (string | undefined)[]) {
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

async function readBody(request: Request) {
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    throw new LiveRequestError('The session request is too large.', 413, 'request_too_large');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new LiveRequestError('The session request is too large.', 413, 'request_too_large');
  }
  try {
    const body: unknown = JSON.parse(text);
    if (isRecord(body)) return body;
  } catch {}
  throw new LiveRequestError('Send a JSON object.', 400, 'invalid_json');
}

type SocketFactory = (url: string, apiKey: string) => NodeWebSocket;

type WorkerSocket = Pick<WebSocket, 'readyState' | 'send' | 'close' | 'addEventListener'> & {
  accept(): void;
};

export function closeLiveSessionOnWorker(
  sessionId: string,
  apiKey: string,
  options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<void> {
  // Workers support authenticated outbound WebSockets through fetch's upgrade API.
  // Await finalization inside this request so no background worker lifetime is needed.
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let socket: WorkerSocket | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!socket) controller.abort();
      try {
        if (socket && socket.readyState !== 3) socket.close();
      } catch {}
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () =>
        finish(
          new LiveRequestError(
            'The connection closed without final session confirmation.',
            504,
            'close_timeout',
          ),
        ),
      options.timeoutMs ?? 8_000,
    );

    const send = options.fetch ?? fetch;
    void send(`https://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`, {
      headers: { Upgrade: 'websocket', Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    })
      .then((response) => {
        socket = (response as Response & { webSocket?: WorkerSocket }).webSocket;
        if (settled) {
          // A runtime may complete the upgrade just after the timeout aborted it.
          if (socket) {
            socket.accept();
            socket.close();
          }
          return;
        }
        if (response.status === 404 || response.status === 410) {
          void response.body?.cancel().catch(() => {});
          finish();
          return;
        }
        if (!socket || response.status !== 101) {
          void response.body?.cancel().catch(() => {});
          finish(
            new LiveRequestError(
              'OpenAI rejected the session close request.',
              502,
              'close_rejected',
            ),
          );
          return;
        }
        socket.addEventListener('message', (message) => {
          try {
            if (typeof message.data !== 'string') return;
            const event: unknown = JSON.parse(message.data);
            if (!isRecord(event)) return;
            if (event.type === 'session.closed') finish();
            if (event.type === 'error')
              finish(
                new LiveRequestError(
                  'OpenAI could not confirm that the session ended.',
                  502,
                  'close_rejected',
                ),
              );
          } catch {
            // Ignore unrelated or malformed sideband messages while waiting for closure.
          }
        });
        socket.addEventListener('error', () =>
          finish(
            new LiveRequestError(
              'Could not reach OpenAI to confirm the session ended.',
              502,
              'close_connection_failed',
            ),
          ),
        );
        socket.addEventListener('close', () =>
          finish(
            new LiveRequestError(
              'The connection closed without final session confirmation.',
              502,
              'close_unconfirmed',
            ),
          ),
        );
        socket.accept();
        socket.send(JSON.stringify({ type: 'session.close' }));
      })
      .catch(() =>
        finish(
          new LiveRequestError(
            'Could not reach OpenAI to confirm the session ended.',
            502,
            'close_connection_failed',
          ),
        ),
      );
  });
}

export function closeLiveSession(
  sessionId: string,
  apiKey: string,
  options: { timeoutMs?: number; createSocket?: SocketFactory } = {},
): Promise<void> {
  if (options.createSocket)
    return closeLiveSessionOnNode(sessionId, apiKey, options.createSocket, options.timeoutMs);
  if ('WebSocketPair' in globalThis) return closeLiveSessionOnWorker(sessionId, apiKey, options);
  // Load Node-only networking code only on the local development server.
  return import('ws').then(({ default: WebSocket }) =>
    closeLiveSessionOnNode(
      sessionId,
      apiKey,
      (url, key) => new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } }),
      options.timeoutMs,
    ),
  );
}

function closeLiveSessionOnNode(
  sessionId: string,
  apiKey: string,
  createSocket: SocketFactory,
  timeoutMs = 8_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(
      `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`,
      apiKey,
    );
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Keep the error listener installed until the socket has closed.
      if (socket.readyState === 1) socket.close();
      else if (socket.readyState !== 3) socket.terminate();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () =>
        finish(
          new LiveRequestError(
            'The connection closed without final session confirmation.',
            504,
            'close_timeout',
          ),
        ),
      timeoutMs,
    );

    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'session.close' }));
    });
    socket.on('message', (data) => {
      try {
        const event: unknown = JSON.parse(data.toString());
        if (!isRecord(event)) return;
        if (event.type === 'session.closed') finish();
        if (event.type === 'error')
          finish(
            new LiveRequestError(
              'OpenAI could not confirm that the session ended.',
              502,
              'close_rejected',
            ),
          );
      } catch {
        // Ignore unrelated or malformed sideband messages while waiting for closure.
      }
    });
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      // A completed session no longer has a sideband to attach to.
      if (response.statusCode === 404 || response.statusCode === 410) finish();
      else
        finish(
          new LiveRequestError('OpenAI rejected the session close request.', 502, 'close_rejected'),
        );
    });
    socket.on('error', () =>
      finish(
        new LiveRequestError(
          'Could not reach OpenAI to confirm the session ended.',
          502,
          'close_connection_failed',
        ),
      ),
    );
    socket.on('close', () =>
      finish(
        new LiveRequestError(
          'The connection closed without final session confirmation.',
          502,
          'close_unconfirmed',
        ),
      ),
    );
  });
}

type HandlerOptions = {
  apiKey?: string;
  apiToken?: string;
  requireApiToken?: boolean;
  fetch?: typeof fetch;
  closeSession?: typeof closeLiveSession;
  timeoutMs?: number;
};

export function createLiveSessionHandlers(options: HandlerOptions) {
  const send = options.fetch ?? fetch;
  const close = options.closeSession ?? closeLiveSession;

  function authorize(request: Request) {
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

  function failure(error: unknown) {
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

  return {
    async POST(request: Request) {
      try {
        const apiKey = authorize(request);
        const body = await readBody(request);
        if (request.signal.aborted) {
          return json({ error: 'Session connection was canceled.', code: 'request_canceled' }, 499);
        }
        if (
          typeof body.sdp !== 'string' ||
          !/^v=0\r?\n/.test(body.sdp) ||
          !/^m=audio /m.test(body.sdp)
        ) {
          throw new LiveRequestError('A WebRTC audio SDP offer is required.', 400, 'invalid_sdp');
        }
        const voice = body.voice === undefined ? DEFAULT_VOICE : body.voice;
        if (!isLiveVoice(voice)) {
          throw new LiveRequestError('Choose a supported voice in settings.', 400, 'invalid_voice');
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
        let result: unknown;
        try {
          // Do not retry creation. Even initialization consumes voice duration.
          const response = await send(LIVE_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              session: { ...liveSessionConfig, audio: { output: { voice } } },
              transport: { type: 'webrtc', sdp: body.sdp },
            }),
            signal: controller.signal,
          });
          result = await response.json().catch(() => null);
          if (!response.ok) {
            const upstream = isRecord(result) && isRecord(result.error) ? result.error : {};
            const code =
              typeof upstream.code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(upstream.code)
                ? upstream.code
                : 'openai_error';
            throw new LiveRequestError(
              sanitizeMessage(upstream.message, [apiKey, options.apiToken]),
              response.status >= 400 && response.status < 500 ? response.status : 502,
              code,
            );
          }
        } catch (error) {
          if (controller.signal.aborted) {
            throw new LiveRequestError(
              'OpenAI took too long to create the session. Try again.',
              504,
              'session_timeout',
            );
          }
          throw error;
        } finally {
          clearTimeout(timer);
        }

        const session = isRecord(result) && isRecord(result.session) ? result.session : {};
        const transport = isRecord(result) && isRecord(result.transport) ? result.transport : {};
        if (
          !validSessionId(session.id) ||
          typeof transport.sdp !== 'string' ||
          !transport.sdp.startsWith('v=0')
        ) {
          if (validSessionId(session.id)) {
            await close(session.id, apiKey).catch(() => {});
          }
          throw new LiveRequestError(
            'OpenAI returned an incomplete session answer.',
            502,
            'invalid_session_response',
          );
        }
        if (request.signal.aborted) {
          await close(session.id, apiKey);
          return json({ error: 'Session connection was canceled.', code: 'request_canceled' }, 499);
        }
        return json({ sdp: transport.sdp, sessionId: session.id }, 201);
      } catch (error) {
        return failure(error);
      }
    },
    async DELETE(request: Request) {
      try {
        const apiKey = authorize(request);
        const body = await readBody(request);
        if (!validSessionId(body.sessionId)) {
          throw new LiveRequestError('A valid session ID is required.', 400, 'invalid_session_id');
        }
        await close(body.sessionId, apiKey);
        return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
      } catch (error) {
        return failure(error);
      }
    },
  };
}
