import type { SessionAPI } from './types';

type Options = {
  fetch: typeof globalThis.fetch;
  isWeb: boolean;
  apiUrl?: string;
  getAccessToken: (interactive?: boolean) => string;
  clearAccessToken?: () => void;
  timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createSessionAPI(options: Options): SessionAPI {
  function endpoint() {
    if (options.isWeb) return '/api/live-session';
    const origin = options.apiUrl?.trim().replace(/\/+$/, '');
    if (!origin) {
      throw new Error(
        'Set EXPO_PUBLIC_API_URL to your voice server URL, then restart or rebuild the app.',
      );
    }
    try {
      const url = new URL(origin);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
    } catch {
      throw new Error(
        'EXPO_PUBLIC_API_URL must be an http:// or https:// server URL without credentials, a query, or a fragment.',
      );
    }
    return `${origin}/api/live-session`;
  }

  function accessToken(interactive = false) {
    const token = options.getAccessToken(interactive).trim();
    if (!token) {
      throw new Error(
        options.isWeb
          ? 'An access token is required. Start again and enter the API_TOKEN configured on your voice server.'
          : 'Set EXPO_PUBLIC_API_TOKEN to match API_TOKEN on your voice server, then restart or rebuild the app.',
      );
    }
    return token;
  }

  async function request(method: 'POST' | 'DELETE', body: unknown) {
    const url = endpoint();
    // Cleanup can run in the background. Only prepare(), called by Start,
    // may ask the browser user for a token.
    const token = accessToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 35_000);
    try {
      const response = await options.fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.status === 204) return null;
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 401 && isRecord(result) && result.code === 'unauthorized')
          options.clearAccessToken?.();
        const error = isRecord(result) ? result.error : undefined;
        const message =
          typeof error === 'string'
            ? error
            : isRecord(error) && typeof error.message === 'string'
              ? error.message
              : null;
        throw new Error(
          message ||
            `The voice service returned HTTP ${response.status}. Check the server URL and try again.`,
        );
      }
      return result;
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof Error && ['AbortError', 'NetworkError'].includes(error.name))
      ) {
        throw new Error(
          'Cannot reach the voice service. Check your internet connection and try again.',
        );
      }
      if (
        error instanceof Error &&
        ['Network request failed', 'Failed to fetch', 'fetch failed'].includes(error.message)
      ) {
        throw new Error(
          'Cannot reach the voice service. Check your internet connection and try again.',
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    prepare() {
      endpoint();
      accessToken(true);
    },
    async create(sdp, voice) {
      const result = await request('POST', { sdp, voice });
      if (
        !isRecord(result) ||
        typeof result.sdp !== 'string' ||
        !result.sdp ||
        typeof result.sessionId !== 'string' ||
        !result.sessionId
      ) {
        throw new Error(
          'The voice server returned an invalid connection. Check that the server URL points to this app.',
        );
      }
      return { sdp: result.sdp, sessionId: result.sessionId };
    },
    async close(sessionId) {
      await request('DELETE', { sessionId });
    },
  };
}
