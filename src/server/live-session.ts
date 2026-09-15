import { createSessionConfig } from './live-config';
import { closeLiveSession } from './close-session';
export { closeLiveSession, closeLiveSessionOnWorker } from './close-session';
import { DEFAULT_VOICE, isLiveVoice } from '../live/voices';
import {
  authorize,
  failure,
  isRecord,
  json,
  LiveRequestError,
  readBody,
  sanitizeMessage,
  validSessionId,
} from './http';
export { LiveRequestError } from './http';

const LIVE_URL = 'https://api.openai.com/v1/live/sessions';

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

  return {
    async POST(request: Request) {
      try {
        const apiKey = authorize(request, options);
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

        if (body.tools !== undefined && typeof body.tools !== 'boolean') {
          throw new LiveRequestError('The tools flag must be a boolean.', 400, 'invalid_tools');
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
              session: createSessionConfig(voice, body.tools === true),
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
        return json(
          {
            sdp: transport.sdp,
            sessionId: session.id,
            ...(body.tools === true ? { tools: true } : {}),
          },
          201,
        );
      } catch (error) {
        return failure(error, options);
      }
    },
    async DELETE(request: Request) {
      try {
        const apiKey = authorize(request, options);
        const body = await readBody(request);
        if (!validSessionId(body.sessionId)) {
          throw new LiveRequestError('A valid session ID is required.', 400, 'invalid_session_id');
        }
        await close(body.sessionId, apiKey);
        return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
      } catch (error) {
        return failure(error, options);
      }
    },
  };
}
