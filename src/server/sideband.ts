import type { ClientRequest, IncomingMessage } from 'node:http';
import type NodeWebSocket from 'ws';

export type Sideband = {
  send(event: Record<string, unknown>): void;
  close(): void;
};

export type SidebandOptions = {
  onEvent: (event: unknown) => void;
  onClose: () => void;
  onError: () => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof fetch;
  createSocket?: (url: string, apiKey: string) => NodeWebSocket;
};

export class SidebandError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code = 'connection_failed',
  ) {
    super(message);
    this.name = 'SidebandError';
  }
}

type Transport = { send(data: string): void; dispose(): void };
type Connection = {
  attach(transport: Transport): void;
  open(): void;
  message(data: string): void;
  error(status?: number): void;
  closed(): void;
};

function connect(
  options: SidebandOptions,
  start: (connection: Connection, signal: AbortSignal) => void | Promise<void>,
): Promise<Sideband> {
  return new Promise((resolve, reject) => {
    let state: 'connecting' | 'open' | 'closed' = 'connecting';
    let transport: Transport | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    function finish(kind: 'intentional' | 'error' | 'closed', error?: SidebandError) {
      if (state === 'closed') return;
      const wasOpen = state === 'open';
      state = 'closed';
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      controller.abort();
      transport?.dispose();
      if (!wasOpen) {
        reject(
          error ??
            new SidebandError('The live sideband closed before it connected.', 502, 'closed'),
        );
      } else if (kind === 'error') {
        options.onError();
      } else if (kind === 'closed') {
        options.onClose();
      }
    }

    function onAbort() {
      finish(
        'intentional',
        new SidebandError('The live sideband connection was canceled.', 499, 'canceled'),
      );
    }

    const connection: Connection = {
      attach(value) {
        if (state === 'closed') value.dispose();
        else transport = value;
      },
      open() {
        if (state !== 'connecting' || !transport) return;
        state = 'open';
        clearTimeout(timer);
        resolve({
          send(event) {
            if (state !== 'open') throw new SidebandError('The live sideband is not connected.');
            try {
              transport!.send(JSON.stringify(event));
            } catch {
              const error = new SidebandError(
                'Could not send to the live sideband.',
                502,
                'send_failed',
              );
              finish('error', error);
              throw error;
            }
          },
          close() {
            finish('intentional');
          },
        });
      },
      message(data) {
        if (state === 'closed') return;
        let event: unknown;
        try {
          event = JSON.parse(data);
        } catch {
          return;
        }
        options.onEvent(event);
      },
      error(status) {
        finish(
          'error',
          new SidebandError(
            'Could not connect to the live sideband.',
            status,
            status === undefined ? 'connection_failed' : 'upgrade_rejected',
          ),
        );
      },
      closed() {
        finish('closed');
      },
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(
      () =>
        finish(
          'error',
          new SidebandError('The live sideband connection timed out.', 504, 'timeout'),
        ),
      options.timeoutMs ?? 8_000,
    );
    try {
      void Promise.resolve(start(connection, controller.signal)).catch(() => connection.error());
    } catch {
      connection.error();
    }
  });
}

function attachmentURL(sessionId: string, protocol: 'https' | 'wss') {
  return `${protocol}://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`;
}

export function connectSideband(
  sessionId: string,
  apiKey: string,
  options: SidebandOptions,
): Promise<Sideband> {
  if (!options.createSocket && 'WebSocketPair' in globalThis) {
    return connectWorkerSideband(sessionId, apiKey, options);
  }
  return connect(options, async (connection, signal) => {
    let createSocket = options.createSocket;
    if (!createSocket) {
      const { default: WebSocket } = await import('ws');
      createSocket = (url, key) =>
        new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });
    }
    if (signal.aborted) return;
    const socket = createSocket(attachmentURL(sessionId, 'wss'), apiKey);
    const onOpen = () => connection.open();
    const onMessage = (data: NodeWebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) connection.message(data.toString());
    };
    const onError = () => connection.error();
    const onClose = () => connection.closed();
    const onRejected = (_request: ClientRequest, response: IncomingMessage) => {
      response.resume();
      connection.error(response.statusCode);
    };
    socket.on('open', onOpen);
    socket.on('message', onMessage);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.on('unexpected-response', onRejected);
    connection.attach({
      send(data) {
        if (socket.readyState !== 1) throw new SidebandError('The live sideband is not connected.');
        socket.send(data, (error) => {
          if (error) connection.error();
        });
      },
      dispose() {
        socket.off('open', onOpen);
        socket.off('message', onMessage);
        socket.off('error', onError);
        socket.off('close', onClose);
        socket.off('unexpected-response', onRejected);
        // ws can emit an error while a pending handshake is being terminated.
        const ignoreError = () => {};
        const release = () => {
          socket.off('error', ignoreError);
          socket.off('close', release);
        };
        socket.on('error', ignoreError);
        socket.once('close', release);
        try {
          if (socket.readyState === 1) socket.close();
          else if (socket.readyState !== 3) socket.terminate();
        } catch {}
        if (socket.readyState === 3) release();
      },
    });
    if (socket.readyState === 1) connection.open();
  });
}

type WorkerSocket = Pick<
  WebSocket,
  'readyState' | 'send' | 'close' | 'addEventListener' | 'removeEventListener'
> & { accept(): void };

export function connectWorkerSideband(
  sessionId: string,
  apiKey: string,
  options: SidebandOptions,
): Promise<Sideband> {
  return connect(options, async (connection, signal) => {
    const response = await (options.fetch ?? fetch)(attachmentURL(sessionId, 'https'), {
      headers: { Upgrade: 'websocket', Authorization: `Bearer ${apiKey}` },
      signal,
    });
    const socket = (response as Response & { webSocket?: WorkerSocket }).webSocket;
    if (response.status !== 101 || !socket) {
      void response.body?.cancel().catch(() => {});
      connection.error(response.status >= 400 ? response.status : 502);
      return;
    }
    let accepted = false;
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') connection.message(event.data);
    };
    const onError = () => connection.error();
    const onClose = () => connection.closed();
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
    connection.attach({
      send: (data) => socket.send(data),
      dispose() {
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onClose);
        try {
          // Accept late upgrades too, so an aborted request cannot leak a socket.
          if (!accepted) {
            accepted = true;
            socket.accept();
          }
          if (socket.readyState !== 3) socket.close();
        } catch {}
      },
    });
    if (signal.aborted) return;
    accepted = true;
    socket.accept();
    connection.open();
  });
}
