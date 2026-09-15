import type { ToolConnection } from './types';

type Options = {
  open: (signal: AbortSignal) => Promise<Response>;
  onFailure: (message: string) => void;
  readyTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
};

const MAX_BUFFER_LENGTH = 64 * 1024;
const CONNECTION_ERROR = 'The tool connection was interrupted. Please start another conversation.';

export function createToolConnection(options: Options): ToolConnection {
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let finished = false;
  let readyReceived = false;
  let appActive = true;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Closing before a caller awaits readiness is still a handled cancellation.
  void ready.catch(() => {});

  function finish(message?: string) {
    if (finished) return;
    finished = true;
    clearTimeout(startup);
    clearTimeout(heartbeat);
    abort.abort();
    void reader?.cancel().catch(() => {});
    if (!readyReceived) {
      rejectReady(new Error(message ?? 'The conversation was canceled.'));
    } else if (message) {
      options.onFailure(message);
    }
  }

  function watchHeartbeat() {
    clearTimeout(heartbeat);
    if (!finished && readyReceived && appActive) {
      heartbeat = setTimeout(() => finish(CONNECTION_ERROR), options.heartbeatTimeoutMs ?? 30_000);
    }
  }

  const startup = setTimeout(
    () => finish('The tool service did not become ready. Please try again.'),
    options.readyTimeoutMs ?? 10_000,
  );

  function acceptLine(line: string) {
    if (!line.trim()) return;
    const frame: unknown = JSON.parse(line);
    if (!frame || typeof frame !== 'object' || !('type' in frame)) throw new Error();
    switch (frame.type) {
      case 'ready':
        if (readyReceived) throw new Error();
        readyReceived = true;
        clearTimeout(startup);
        resolveReady();
        watchHeartbeat();
        break;
      case 'ping':
        if (!readyReceived) throw new Error();
        watchHeartbeat();
        break;
      case 'closed':
        finish();
        break;
      case 'error':
        finish(CONNECTION_ERROR);
        break;
      default:
        throw new Error();
    }
  }

  async function read() {
    try {
      const response = await options.open(abort.signal);
      if (finished) {
        void response.body?.cancel().catch(() => {});
        return;
      }
      if (
        !response.ok ||
        response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
          'application/x-ndjson' ||
        !response.body
      ) {
        void response.body?.cancel().catch(() => {});
        throw new Error();
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!finished) {
        const { value, done } = await reader.read();
        if (finished) break;
        if (buffer.length + (value?.byteLength ?? 0) > MAX_BUFFER_LENGTH) throw new Error();
        buffer += decoder.decode(value, { stream: !done });
        let newline: number;
        while (!finished && (newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          acceptLine(line);
        }
        if (done && !finished) {
          if (buffer.trim()) acceptLine(buffer);
          if (!finished) finish(CONNECTION_ERROR);
        }
      }
    } catch {
      finish(CONNECTION_ERROR);
    }
  }
  void read();

  return {
    ready,
    close: () => finish(),
    setAppActive(active) {
      if (appActive === active) return;
      appActive = active;
      // iOS may suspend JavaScript while audio continues. Resume with a fresh
      // heartbeat window so a delayed timer cannot end a healthy call.
      watchHeartbeat();
    },
  };
}
