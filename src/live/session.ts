import type { LiveEvent, LiveSnapshot, LiveTransport, SessionAPI, TransportFactory } from './types';
import { DEFAULT_VOICE, type LiveVoice } from './voices';

const initialSnapshot = (): LiveSnapshot => ({
  status: 'idle',
  error: null,
  muted: false,
  inputLevel: 0,
  outputLevel: 0,
  elapsedSeconds: 0,
  transcript: [],
});
const MAX_SESSION_SECONDS = 10 * 60;
const SESSION_LIMIT_MESSAGE =
  'This conversation reached the 10-minute limit. You can start another.';
const SESSION_CLOSE_MESSAGE =
  'Audio stopped, but the server could not confirm session closure. Check your network before starting another call.';

export class LiveSession {
  private snapshot = initialSnapshot();
  private listeners = new Set<() => void>();
  private transport: LiveTransport | null = null;
  private sessionId: string | null = null;
  private generation = 0;
  private statsTimer?: ReturnType<typeof setInterval>;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private durationTimer?: ReturnType<typeof setTimeout>;
  private muteTimer?: ReturnType<typeof setTimeout>;
  private startedAt = 0;
  private statsPending: LiveTransport | null = null;
  private serverClosed = false;
  private muteCommand: { id: string; muted: boolean } | null = null;
  private nextCommand = 0;
  private closing: Promise<void> | null = null;
  private confirmClosed?: () => void;
  private reportedDuplex = false;
  private lastSentPackets = 0;
  private appActive = true;

  constructor(
    private factory: TransportFactory,
    private api: SessionAPI,
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(change: Partial<LiveSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    this.listeners.forEach((listener) => listener());
  }

  start = async (voice: LiveVoice = DEFAULT_VOICE) => {
    if (
      this.closing ||
      this.snapshot.status === 'connecting' ||
      this.snapshot.status === 'connected'
    )
      return;
    const generation = ++this.generation;
    this.snapshot = initialSnapshot();
    this.serverClosed = false;
    this.statsPending = null;
    this.update({ status: 'connecting' });
    const isCurrent = () => generation === this.generation;
    let transport: LiveTransport | undefined;
    try {
      // Validate setup before asking for microphone access or allocating audio.
      this.api.prepare?.();
      transport = await this.factory({
        onEvent: (event) => {
          if (
            isCurrent() ||
            (event.type === 'session.closed' && this.closing && transport === this.transport)
          )
            this.onEvent(event);
        },
        onFailure: (message) => {
          if (isCurrent() && !this.closing) void this.stop(message);
        },
      });
      if (!isCurrent()) {
        transport.close();
        return;
      }
      this.transport = transport;
      const sdp = await transport.offer();
      if (!isCurrent()) return;
      const session = await this.api.create(sdp, voice);
      // A cancelled create can still finish on the server. Close its returned session.
      if (!isCurrent()) {
        try {
          await this.api.close(session.sessionId);
        } catch {
          const message = SESSION_CLOSE_MESSAGE;
          if (this.generation === generation + 1) {
            // The local close may still be publishing its final idle state.
            // Surface this warning afterward without touching a newer call.
            await this.closing;
            if (this.generation === generation + 1)
              this.update({ status: 'error', error: message });
            else console.warn('[Live] A cancelled session could not be confirmed closed.');
          } else console.warn('[Live] A cancelled session could not be confirmed closed.');
        }
        return;
      }
      this.sessionId = session.sessionId;
      this.startupTimer = setTimeout(() => {
        void this.stop('The voice session did not start. Please try again.');
      }, 25000);
      await transport.answer(session.sdp);
      if (!isCurrent()) return;
    } catch (error) {
      if (isCurrent())
        await this.stop(
          error instanceof Error ? error.message : 'Could not start the conversation.',
        );
      else transport?.close();
    }
  };

  private onEvent(event: LiveEvent) {
    if (
      event.type !== 'session.closed' &&
      this.snapshot.status === 'connected' &&
      !this.refreshElapsed()
    )
      return;
    switch (event.type) {
      case 'session.started':
        clearTimeout(this.startupTimer);
        if (this.snapshot.status !== 'connecting') break;
        this.startedAt = Date.now();
        this.reportedDuplex = false;
        this.lastSentPackets = 0;
        this.update({ status: 'connected' });
        this.scheduleDurationLimit();
        this.startStats();
        break;
      case 'session.input_transcript.delta':
      case 'session.output_transcript.delta': {
        if (typeof event.delta !== 'string' || !event.delta) break;
        const role = event.type === 'session.input_transcript.delta' ? 'user' : 'assistant';
        const entries = [...this.snapshot.transcript];
        // Each speaker has an independent caption stream, so overlapping speech
        // must not split a sentence every time the other speaker emits a delta.
        let index = entries.findLastIndex((entry) => entry.role === role);
        const previous = entries[index];
        const startMs = event.start_ms ?? this.snapshot.elapsedSeconds * 1000;
        if (!previous || startMs - (previous.endMs ?? previous.startMs) > 2000) {
          entries.push({
            id: `${role}-${startMs}-${entries.length}`,
            role,
            text: event.delta,
            startMs,
            endMs: event.end_ms ?? startMs,
          });
        } else {
          entries[index] = {
            ...previous,
            text: previous.text + event.delta,
            endMs: event.end_ms ?? startMs,
          };
        }
        entries.sort((a, b) => a.startMs - b.startMs);
        this.update({ transcript: entries.slice(-200) });
        break;
      }
      case 'session.input_audio.muted':
      case 'session.input_audio.unmuted': {
        const command = this.muteCommand;
        if (
          !command ||
          event.client_event_id !== command.id ||
          (event.type === 'session.input_audio.muted') !== command.muted
        )
          break;
        clearTimeout(this.muteTimer);
        this.muteCommand = null;
        if (!command.muted && !this.snapshot.muted) this.transport?.setMuted(false);
        break;
      }
      case 'session.closed':
        this.serverClosed = true;
        this.confirmClosed?.();
        if (!this.closing) void this.stop();
        break;
      case 'error':
      case 'session.error':
        void this.stop(
          event.error?.message || 'The voice service reported an error. Start again to retry.',
        );
        break;
    }
  }

  setAppActive = (active: boolean) => {
    this.appActive = active;
    clearInterval(this.statsTimer);
    if (!this.refreshElapsed()) return;
    if (active) {
      this.startStats();
      void this.poll();
    } else {
      this.update({ inputLevel: 0, outputLevel: 0 });
    }
  };

  private startStats() {
    if (this.appActive && this.snapshot.status === 'connected') {
      this.statsTimer = setInterval(() => {
        void this.poll();
      }, 120);
    }
  }

  private refreshElapsed() {
    if (this.snapshot.status !== 'connected') return false;
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
    if (elapsedSeconds >= MAX_SESSION_SECONDS) {
      void this.stop(SESSION_LIMIT_MESSAGE);
      return false;
    }
    if (elapsedSeconds !== this.snapshot.elapsedSeconds) this.update({ elapsedSeconds });
    return true;
  }

  private scheduleDurationLimit() {
    clearTimeout(this.durationTimer);
    // This deadline remains scheduled when visual stats are paused. Native RN
    // timers run during an active iOS background audio session; foreground and
    // data events also reconcile wall time if iOS delayed JavaScript execution.
    const remaining = MAX_SESSION_SECONDS * 1000 - (Date.now() - this.startedAt);
    this.durationTimer = setTimeout(
      () => {
        if (this.refreshElapsed()) this.scheduleDurationLimit();
      },
      Math.max(1, remaining),
    );
  }

  private async poll() {
    if (!this.transport || !this.appActive || !this.refreshElapsed()) return;
    const transport = this.transport;
    if (this.statsPending === transport) return;
    this.statsPending = transport;
    try {
      const stats = await transport.stats();
      if (transport !== this.transport || !this.appActive || !this.refreshElapsed()) return;
      this.update({
        inputLevel: this.snapshot.muted ? 0 : Math.min(1, stats.inputLevel * 5),
        outputLevel: Math.min(1, stats.outputLevel * 5),
      });
      if (
        typeof __DEV__ !== 'undefined' &&
        __DEV__ &&
        !this.reportedDuplex &&
        !this.snapshot.muted &&
        stats.outputLevel > 0.005 &&
        stats.sentPackets > this.lastSentPackets
      ) {
        console.info(
          '[Live] Duplex transport verified: microphone RTP continues during assistant audio.',
          { sentPackets: stats.sentPackets, receivedPackets: stats.receivedPackets },
        );
        this.reportedDuplex = true;
      }
      this.lastSentPackets = stats.sentPackets;
    } catch {
      /* A stats failure does not interrupt the audio connection. */
    } finally {
      if (this.statsPending === transport) this.statsPending = null;
    }
  }

  toggleMute = () => {
    if (this.snapshot.status !== 'connected' || !this.transport) return;
    clearTimeout(this.muteTimer);
    const muted = !this.snapshot.muted;
    if (muted) this.transport.setMuted(true);
    this.update({ muted, inputLevel: 0 });
    const id = `mute-${++this.nextCommand}`;
    this.muteCommand = { id, muted };
    this.muteTimer = setTimeout(() => {
      void this.stop('The microphone change was not confirmed. Please reconnect.');
    }, 5000);
    const sent = this.transport.send({
      type: muted ? 'session.input_audio.mute' : 'session.input_audio.unmute',
      event_id: id,
    });
    if (!sent) {
      void this.stop('The voice connection is unavailable. Start again to reconnect.');
    }
  };

  stop = (reason?: string): Promise<void> => {
    if (this.closing) return this.closing;
    if (!this.transport && this.snapshot.status !== 'connecting') {
      if (reason) this.update({ status: 'error', error: reason });
      return Promise.resolve();
    }
    ++this.generation;
    clearInterval(this.statsTimer);
    clearTimeout(this.startupTimer);
    clearTimeout(this.durationTimer);
    clearTimeout(this.muteTimer);
    this.muteCommand = null;
    this.statsPending = null;
    const transport = this.transport;
    const id = this.sessionId;
    this.update({ status: 'disconnecting', inputLevel: 0, outputLevel: 0 });
    // Silence capture immediately; session.close preserves final usage events.
    transport?.setMuted(true);
    this.closing = Promise.resolve().then(async () => {
      let confirmed = this.serverClosed;
      if (transport && !confirmed) {
        confirmed = await new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => {
            this.confirmClosed = undefined;
            resolve(false);
          }, 1500);
          this.confirmClosed = () => {
            clearTimeout(timeout);
            resolve(true);
          };
          if (!transport.send({ type: 'session.close' })) {
            clearTimeout(timeout);
            resolve(false);
          }
        });
      }
      transport?.close();
      this.transport = null;
      this.sessionId = null;
      let closeError: string | null = null;
      if (!confirmed && id) {
        try {
          await this.api.close(id);
        } catch {
          closeError = SESSION_CLOSE_MESSAGE;
        }
      }
      this.confirmClosed = undefined;
      this.update({
        status: reason || closeError ? 'error' : 'idle',
        error: reason || closeError,
        muted: false,
      });
      this.closing = null;
    });
    return this.closing;
  };
}
