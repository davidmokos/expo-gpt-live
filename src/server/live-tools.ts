import {
  authorize,
  failure,
  isRecord,
  LiveRequestError,
  readBody,
  validSessionId,
  type ServerOptions,
} from './http';
import { connectSideband, type Sideband } from './sideband';
import { ToolRunner } from './tool-runner';
import type { executeTool } from './tools';

type Options = ServerOptions & {
  connect?: typeof connectSideband;
  execute?: typeof executeTool;
  heartbeatMs?: number;
  lifetimeMs?: number;
};

const CONNECTION_ERROR = 'The tool connection failed. Start a new conversation to reconnect.';

export function createLiveToolsHandler(options: Options) {
  return async function POST(request: Request) {
    try {
      const apiKey = authorize(request, options);
      const body = await readBody(request);
      if (!validSessionId(body.sessionId)) {
        throw new LiveRequestError('A valid session ID is required.', 400, 'invalid_session_id');
      }
      if (request.signal.aborted) {
        throw new LiveRequestError('The tool connection was canceled.', 499, 'request_canceled');
      }
      const sessionId = body.sessionId;
      const controller = new AbortController();
      const encoder = new TextEncoder();
      let socket: Sideband | undefined;
      let output: ReadableStreamDefaultController<Uint8Array>;
      let runner: ToolRunner;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let finished = false;

      function emit(event: Record<string, unknown>) {
        output.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      }

      function finish(type?: 'closed' | 'error', canceled = false) {
        if (finished) return;
        finished = true;
        clearInterval(heartbeat);
        clearTimeout(deadline);
        request.signal.removeEventListener('abort', onAbort);
        runner.close();
        if (type !== 'closed') {
          try {
            socket?.send({ type: 'session.close' });
          } catch {}
        }
        controller.abort();
        socket?.close();
        if (!canceled) {
          if (type) emit({ type, ...(type === 'error' ? { message: CONNECTION_ERROR } : {}) });
          output.close();
        }
      }

      function onAbort() {
        finish(undefined);
      }

      // Keeping this response open keeps the server executor alive on EAS Hosting.
      // Ending the request cancels its lookups and releases the OpenAI sideband.
      const stream = new ReadableStream<Uint8Array>({
        start(streamController) {
          output = streamController;
          runner = new ToolRunner({
            execute: options.execute,
            send: (event) => {
              if (!socket) throw new Error('The tool connection is not ready.');
              socket.send(event);
            },
            onFailure: () => finish('error'),
          });
          request.signal.addEventListener('abort', onAbort, { once: true });
          if (request.signal.aborted) return onAbort();
          deadline = setTimeout(() => finish('error'), options.lifetimeMs ?? 600_000);
          void (options.connect ?? connectSideband)(sessionId, apiKey, {
            signal: controller.signal,
            onEvent(event) {
              if (isRecord(event) && event.type === 'session.closed') finish('closed');
              else runner.handle(event);
            },
            onClose: () => finish('error'),
            onError: () => finish('error'),
          })
            .then((connection) => {
              if (finished) return connection.close();
              socket = connection;
              emit({ type: 'ready' });
              heartbeat = setInterval(() => emit({ type: 'ping' }), options.heartbeatMs ?? 10_000);
            })
            .catch(() => finish('error'));
        },
        cancel() {
          finish(undefined, true);
        },
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'application/x-ndjson',
          'Cache-Control': 'no-store, no-transform',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (error) {
      return failure(error, options);
    }
  };
}
