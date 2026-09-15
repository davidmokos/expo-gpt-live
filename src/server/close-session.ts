import { isRecord, LiveRequestError } from './http';
import {
  connectSideband,
  connectWorkerSideband,
  SidebandError,
  type Sideband,
  type SidebandOptions,
} from './sideband';

type CloseOptions = Pick<SidebandOptions, 'timeoutMs' | 'createSocket' | 'fetch'>;

function closeSession(
  sessionId: string,
  apiKey: string,
  options: CloseOptions,
  connect: typeof connectSideband,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let sideband: Sideband | undefined;
    let settled = false;

    function finish(error?: LiveRequestError) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.abort();
      sideband?.close();
      if (error) reject(error);
      else resolve();
    }

    const timeout = () =>
      finish(
        new LiveRequestError(
          'The connection closed without final session confirmation.',
          504,
          'close_timeout',
        ),
      );
    const unconfirmed = () =>
      finish(
        new LiveRequestError(
          'The connection closed without final session confirmation.',
          502,
          'close_unconfirmed',
        ),
      );
    const failed = () =>
      finish(
        new LiveRequestError(
          'Could not reach OpenAI to confirm the session ended.',
          502,
          'close_connection_failed',
        ),
      );
    const timer = setTimeout(timeout, options.timeoutMs ?? 8_000);

    void connect(sessionId, apiKey, {
      ...options,
      signal: controller.signal,
      onEvent(event) {
        if (!isRecord(event)) return;
        if (event.type === 'session.closed') finish();
        else if (event.type === 'error') {
          finish(
            new LiveRequestError(
              'OpenAI could not confirm that the session ended.',
              502,
              'close_rejected',
            ),
          );
        }
      },
      onClose: unconfirmed,
      onError: failed,
    })
      .then((connection) => {
        sideband = connection;
        if (settled) connection.close();
        else connection.send({ type: 'session.close' });
      })
      .catch((error: unknown) => {
        if (settled) return;
        if (error instanceof SidebandError) {
          // Closed sessions no longer expose an attachment endpoint.
          if (error.status === 404 || error.status === 410) return finish();
          if (error.code === 'timeout') return timeout();
          if (error.code === 'closed') return unconfirmed();
          if (error.code === 'upgrade_rejected') {
            return finish(
              new LiveRequestError(
                'OpenAI rejected the session close request.',
                502,
                'close_rejected',
              ),
            );
          }
        }
        failed();
      });
  });
}

export function closeLiveSession(
  sessionId: string,
  apiKey: string,
  options: CloseOptions = {},
): Promise<void> {
  return closeSession(sessionId, apiKey, options, connectSideband);
}

export function closeLiveSessionOnWorker(
  sessionId: string,
  apiKey: string,
  options: Pick<CloseOptions, 'timeoutMs' | 'fetch'> = {},
): Promise<void> {
  return closeSession(sessionId, apiKey, options, connectWorkerSideband);
}
