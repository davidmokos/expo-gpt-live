import assert from 'node:assert/strict';
import test from 'node:test';

import { LiveSession } from '../src/live/session';
import type {
  AudioStats,
  LiveEvent,
  LiveTransport,
  SessionAPI,
  TransportCallbacks,
  TransportFactory,
} from '../src/live/types';
import type { LiveVoice } from '../src/live/voices';

// All transport and API operations are local fakes. These tests make no API calls.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

class ManualClock {
  private saved = { setTimeout, clearTimeout, setInterval, clearInterval, now: Date.now };
  private nextId = 0;
  private timers = new Map<number, { callback: () => void; delay: number; interval: boolean }>();
  now = 1_000_000;

  constructor() {
    const schedule = (callback: () => void, delay: number, interval: boolean) => {
      const id = ++this.nextId;
      this.timers.set(id, { callback, delay, interval });
      return id as unknown as ReturnType<typeof setTimeout>;
    };
    globalThis.setTimeout = ((callback: () => void, delay = 0) =>
      schedule(callback, delay, false)) as typeof setTimeout;
    globalThis.setInterval = ((callback: () => void, delay = 0) =>
      schedule(callback, delay, true)) as typeof setInterval;
    globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
      this.timers.delete(id as unknown as number);
    }) as typeof clearTimeout;
    globalThis.clearInterval = globalThis.clearTimeout as typeof clearInterval;
    Date.now = () => this.now;
  }

  async fire(delay: number) {
    const pending = [...this.timers].filter(([, timer]) => timer.delay === delay);
    for (const [id, timer] of pending) {
      if (!this.timers.has(id)) continue;
      if (!timer.interval) this.timers.delete(id);
      timer.callback();
    }
    await settle();
  }

  restore() {
    globalThis.setTimeout = this.saved.setTimeout;
    globalThis.clearTimeout = this.saved.clearTimeout;
    globalThis.setInterval = this.saved.setInterval;
    globalThis.clearInterval = this.saved.clearInterval;
    Date.now = this.saved.now;
  }
}

type Command = { type: string; event_id?: string };
class FakeTransport implements LiveTransport {
  commands: Command[] = [];
  muteChanges: boolean[] = [];
  answers: string[] = [];
  closed = false;
  statsCalls = 0;
  acknowledgeClose: 'sync' | 'microtask' | 'none' = 'microtask';
  onCommand?: (event: Command) => void;
  offerResult = async () => 'offer';
  statsResult = async (): Promise<AudioStats> => ({
    inputLevel: 0.1,
    outputLevel: 0.2,
    sentPackets: 10,
    receivedPackets: 20,
  });

  constructor(readonly callbacks: TransportCallbacks) {}
  offer() {
    return this.offerResult();
  }
  async answer(sdp: string) {
    this.answers.push(sdp);
    this.emit({ type: 'session.started' });
  }
  send(event: Command) {
    this.commands.push(event);
    this.onCommand?.(event);
    if (event.type === 'session.close') {
      if (this.acknowledgeClose === 'sync') this.emit({ type: 'session.closed' });
      if (this.acknowledgeClose === 'microtask')
        queueMicrotask(() => this.emit({ type: 'session.closed' }));
    }
    return true;
  }
  setMuted(muted: boolean) {
    this.muteChanges.push(muted);
  }
  async stats() {
    this.statsCalls++;
    return this.statsResult();
  }
  close() {
    this.closed = true;
  }
  emit(event: LiveEvent) {
    this.callbacks.onEvent(event);
  }
  acknowledge(command: Command) {
    this.emit({
      type:
        command.type === 'session.input_audio.mute'
          ? 'session.input_audio.muted'
          : 'session.input_audio.unmuted',
      client_event_id: command.event_id,
    });
  }
}

function harness() {
  const clock = new ManualClock();
  const transports: FakeTransport[] = [];
  const created: string[] = [];
  const voices: (LiveVoice | undefined)[] = [];
  const closed: string[] = [];
  const control = {
    prepare: () => {},
    create: async (sdp: string) => ({ sdp: `answer-${sdp}`, sessionId: `live_${created.length}` }),
    close: async (_id: string): Promise<void> => {},
    factory: async (callbacks: TransportCallbacks): Promise<LiveTransport> => {
      const transport = new FakeTransport(callbacks);
      transports.push(transport);
      return transport;
    },
  };
  const factory: TransportFactory = (callbacks) => control.factory(callbacks);
  const api: SessionAPI = {
    prepare: () => control.prepare(),
    create: (sdp, voice) => {
      created.push(sdp);
      voices.push(voice);
      return control.create(sdp);
    },
    close: async (id) => {
      closed.push(id);
      await control.close(id);
    },
  };
  const session = new LiveSession(factory, api);
  return {
    session,
    transports,
    created,
    voices,
    closed,
    control,
    clock,
    async cleanup() {
      const stop = session.stop();
      await settle();
      transports.forEach((transport) => transport.emit({ type: 'session.closed' }));
      await stop;
      clock.restore();
    },
  };
}

test('configuration errors and a canceled browser token prompt do not open the microphone', async () => {
  const h = harness();
  h.control.prepare = () => {
    throw new Error('An access token is required.');
  };
  try {
    await h.session.start();
    assert.equal(h.session.getSnapshot().status, 'error');
    assert.match(h.session.getSnapshot().error ?? '', /access token is required/);
    assert.equal(h.transports.length, 0);
    assert.equal(h.created.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('uses the selected voice only when starting a new session and defaults to Marin', async () => {
  const h = harness();
  try {
    await h.session.start('cedar');
    await h.session.start('quartz');
    assert.deepEqual(h.voices, ['cedar']);
    await h.session.stop();
    await h.session.start('quartz');
    assert.deepEqual(h.voices, ['cedar', 'quartz']);
    await h.session.stop();
    await h.session.start();
    assert.deepEqual(h.voices, ['cedar', 'quartz', 'marin']);
  } finally {
    await h.cleanup();
  }
});

test('keeps both audio directions active during assistant speech and overlapping captions', async () => {
  const h = harness();
  try {
    await h.session.start();
    const transport = h.transports[0];
    transport.emit({
      type: 'session.input_transcript.delta',
      delta: 'Could you',
      start_ms: 100,
      end_ms: 400,
    });
    transport.emit({
      type: 'session.output_transcript.delta',
      delta: 'Sure,',
      start_ms: 250,
      end_ms: 450,
    });
    transport.emit({
      type: 'session.input_transcript.delta',
      delta: ' explain this?',
      start_ms: 400,
      end_ms: 700,
    });
    transport.emit({
      type: 'session.output_transcript.delta',
      delta: ' tell me more.',
      start_ms: 450,
      end_ms: 900,
    });
    await h.clock.fire(120);
    const snapshot = h.session.getSnapshot();
    assert.equal(snapshot.status, 'connected');
    assert.deepEqual(
      snapshot.transcript.map(({ role, text }) => ({ role, text })),
      [
        { role: 'user', text: 'Could you explain this?' },
        { role: 'assistant', text: 'Sure, tell me more.' },
      ],
    );
    assert.ok(snapshot.inputLevel > 0 && snapshot.outputLevel > 0);
    assert.deepEqual(transport.muteChanges, []);
    assert.deepEqual(transport.commands, []);
  } finally {
    await h.cleanup();
  }
});

test('allows a fresh start after cancellation while microphone permission is pending', async () => {
  const h = harness();
  const ready = deferred<LiveTransport>();
  const originalFactory = h.control.factory;
  let callbacks!: TransportCallbacks;
  h.control.factory = async (value) => {
    callbacks = value;
    return ready.promise;
  };
  try {
    const starting = h.session.start();
    await h.session.stop();
    assert.equal(h.session.getSnapshot().status, 'idle');
    const lateTransport = new FakeTransport(callbacks);
    ready.resolve(lateTransport);
    await starting;
    assert.equal(lateTransport.closed, true);
    assert.equal(h.created.length, 0);
    h.control.factory = originalFactory;
    await h.session.start();
    assert.equal(h.session.getSnapshot().status, 'connected');
  } finally {
    await h.cleanup();
  }
});

test('a late session creation is closed without applying its answer after cancellation', async () => {
  const h = harness();
  const response = deferred<{ sdp: string; sessionId: string }>();
  h.control.create = () => response.promise;
  try {
    const starting = h.session.start();
    await settle();
    const transport = h.transports[0];
    transport.acknowledgeClose = 'none';
    const stopping = h.session.stop();
    response.resolve({ sdp: 'late-answer', sessionId: 'live_late' });
    await starting;
    assert.deepEqual(transport.answers, []);
    assert.deepEqual(h.closed, ['live_late']);
    transport.emit({ type: 'session.closed' });
    await stopping;
    assert.equal(h.session.getSnapshot().status, 'idle');
  } finally {
    await h.cleanup();
  }
});

test('late creation cleanup failure is visible after cancellation has finished', async () => {
  const h = harness();
  const response = deferred<{ sdp: string; sessionId: string }>();
  h.control.create = () => response.promise;
  h.control.close = async () => {
    throw new Error('Network unavailable');
  };
  try {
    const starting = h.session.start();
    await settle();
    await h.session.stop();
    response.resolve({ sdp: 'late-answer', sessionId: 'live_late_failure' });
    await starting;
    assert.equal(h.session.getSnapshot().status, 'error');
    assert.match(h.session.getSnapshot().error ?? '', /server could not confirm session closure/);
    assert.deepEqual(h.closed, ['live_late_failure']);
    assert.equal(h.transports[0].closed, true);
    assert.deepEqual(h.transports[0].answers, []);
  } finally {
    await h.cleanup();
  }
});

test('stop finalization cannot erase a late creation cleanup failure', async () => {
  const h = harness();
  const response = deferred<{ sdp: string; sessionId: string }>();
  h.control.create = () => response.promise;
  h.control.close = async () => {
    throw new Error('Network unavailable');
  };
  try {
    const starting = h.session.start();
    await settle();
    const transport = h.transports[0];
    transport.acknowledgeClose = 'none';
    const stopping = h.session.stop();
    response.resolve({ sdp: 'late-answer', sessionId: 'live_late_failure' });
    await settle();
    assert.deepEqual(h.closed, ['live_late_failure']);
    transport.emit({ type: 'session.closed' });
    await Promise.all([starting, stopping]);
    assert.equal(h.session.getSnapshot().status, 'error');
    assert.match(h.session.getSnapshot().error ?? '', /server could not confirm session closure/);
    assert.equal(transport.closed, true);
  } finally {
    await h.cleanup();
  }
});

test('late creation cleanup failure preserves a newer connected conversation', async () => {
  const h = harness();
  const response = deferred<{ sdp: string; sessionId: string }>();
  const cleanup = deferred<void>();
  const originalCreate = h.control.create;
  h.control.create = () => response.promise;
  h.control.close = () => cleanup.promise;
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...messages: unknown[]) => {
    warnings.push(messages);
  };
  try {
    const starting = h.session.start();
    await settle();
    await h.session.stop();
    response.resolve({ sdp: 'late-answer', sessionId: 'live_old_failure' });
    await settle();
    assert.deepEqual(h.closed, ['live_old_failure']);

    h.control.create = originalCreate;
    await h.session.start();
    h.transports[1].emit({
      type: 'session.input_transcript.delta',
      delta: 'New conversation',
      start_ms: 0,
      end_ms: 100,
    });
    const current = h.session.getSnapshot();
    cleanup.reject(new Error('Old cleanup failed'));
    await starting;

    assert.strictEqual(h.session.getSnapshot(), current);
    assert.equal(current.status, 'connected');
    assert.equal(current.error, null);
    assert.equal(h.transports[1].closed, false);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /cancelled session could not be confirmed closed/);
  } finally {
    await h.cleanup();
    console.warn = originalWarn;
  }
});

test('accepts a synchronous close acknowledgment and can restart', async () => {
  const h = harness();
  try {
    await h.session.start();
    h.transports[0].acknowledgeClose = 'sync';
    await h.session.stop();
    assert.equal(h.session.getSnapshot().status, 'idle');
    assert.deepEqual(h.closed, []);
    await h.session.start();
    assert.equal(h.session.getSnapshot().status, 'connected');
    assert.equal(h.created.length, 2);
  } finally {
    await h.cleanup();
  }
});

test('server-initiated finalization cleans up without another close command or HTTP request', async () => {
  const h = harness();
  try {
    await h.session.start();
    const transport = h.transports[0];
    transport.emit({ type: 'session.closed', usage: { seconds: 12 } });
    await settle();
    assert.equal(h.session.getSnapshot().status, 'idle');
    assert.equal(transport.closed, true);
    assert.deepEqual(transport.commands, []);
    assert.deepEqual(h.closed, []);
  } finally {
    await h.cleanup();
  }
});

test('stale mute acknowledgments cannot satisfy the current unmute command', async () => {
  const h = harness();
  try {
    await h.session.start();
    const transport = h.transports[0];
    h.session.toggleMute();
    h.session.toggleMute();
    const [mute, unmute] = transport.commands;
    assert.ok(mute.event_id && unmute.event_id && mute.event_id !== unmute.event_id);
    transport.acknowledge(mute);
    assert.deepEqual(transport.muteChanges, [true]);
    await h.clock.fire(5000);
    assert.equal(h.session.getSnapshot().status, 'error');
    assert.match(h.session.getSnapshot().error ?? '', /microphone change was not confirmed/);
  } finally {
    await h.cleanup();
  }
});

test('only the newest unmute acknowledgment resumes local microphone capture', async () => {
  const h = harness();
  try {
    await h.session.start();
    const transport = h.transports[0];
    h.session.toggleMute();
    h.session.toggleMute();
    h.session.toggleMute();
    h.session.toggleMute();
    transport.acknowledge(transport.commands[1]);
    assert.deepEqual(transport.muteChanges, [true, true]);
    transport.acknowledge(transport.commands[3]);
    assert.deepEqual(transport.muteChanges, [true, true, false]);
    await h.clock.fire(5000);
    assert.equal(h.session.getSnapshot().status, 'connected');
  } finally {
    await h.cleanup();
  }
});

test('synchronous mute acknowledgment clears the confirmation timeout', async () => {
  const h = harness();
  try {
    await h.session.start();
    const transport = h.transports[0];
    transport.onCommand = (command) => {
      if (command.type.startsWith('session.input_audio.')) transport.acknowledge(command);
    };
    h.session.toggleMute();
    await h.clock.fire(5000);
    assert.equal(h.session.getSnapshot().status, 'connected');
    assert.equal(h.session.getSnapshot().muted, true);
  } finally {
    await h.cleanup();
  }
});

test('a stalled stats operation cannot prevent the 10-minute cap', async () => {
  const h = harness();
  try {
    await h.session.start();
    h.transports[0].statsResult = () => new Promise(() => {});
    await h.clock.fire(120);
    h.clock.now += 600_000;
    await h.clock.fire(120);
    assert.equal(h.session.getSnapshot().status, 'error');
    assert.match(h.session.getSnapshot().error ?? '', /10-minute limit/);
    assert.equal(h.transports[0].closed, true);
  } finally {
    await h.cleanup();
  }
});

test('backgrounding preserves the live transport and captions while pausing visual stats', async () => {
  const h = harness();
  try {
    await h.session.start();
    const transport = h.transports[0];
    await h.clock.fire(120);
    assert.equal(transport.statsCalls, 1);
    h.session.setAppActive(false);
    h.clock.now += 45_000;
    transport.emit({
      type: 'session.input_transcript.delta',
      delta: 'Still here',
      start_ms: 45_000,
      end_ms: 45_400,
    });
    transport.emit({
      type: 'session.output_transcript.delta',
      delta: 'I can hear you.',
      start_ms: 45_200,
      end_ms: 45_800,
    });
    await h.clock.fire(120);
    assert.equal(h.session.getSnapshot().status, 'connected');
    assert.equal(h.session.getSnapshot().transcript.length, 2);
    assert.equal(transport.statsCalls, 1);
    assert.equal(transport.closed, false);
    assert.deepEqual(transport.muteChanges, []);
    assert.deepEqual(transport.commands, []);

    h.session.setAppActive(true);
    await settle();
    assert.equal(h.session.getSnapshot().elapsedSeconds, 45);
    assert.equal(transport.statsCalls, 2);
    assert.equal(h.created.length, 1);
    assert.deepEqual(transport.muteChanges, []);
  } finally {
    await h.cleanup();
  }
});

test('a muted microphone stays muted when returning from the background', async () => {
  const h = harness();
  try {
    await h.session.start();
    const transport = h.transports[0];
    h.session.toggleMute();
    transport.acknowledge(transport.commands[0]);
    h.session.setAppActive(false);
    h.session.setAppActive(true);
    await settle();
    assert.equal(h.session.getSnapshot().muted, true);
    assert.equal(h.session.getSnapshot().inputLevel, 0);
    assert.deepEqual(transport.muteChanges, [true]);
    assert.equal(transport.commands.length, 1);
  } finally {
    await h.cleanup();
  }
});

test('a session connecting during background transition is kept without starting visual stats', async () => {
  const h = harness();
  const response = deferred<{ sdp: string; sessionId: string }>();
  h.control.create = () => response.promise;
  try {
    const starting = h.session.start();
    await settle();
    h.session.setAppActive(false);
    response.resolve({ sdp: 'background-answer', sessionId: 'live_background' });
    await starting;
    await h.clock.fire(120);
    assert.equal(h.session.getSnapshot().status, 'connected');
    assert.equal(h.transports[0].statsCalls, 0);
    assert.equal(h.transports[0].closed, false);
    assert.deepEqual(h.transports[0].muteChanges, []);
    await h.session.stop();
    assert.equal(h.transports[0].closed, true);
  } finally {
    await h.cleanup();
  }
});

test('the 10-minute deadline closes background audio without any visual stats ticks', async () => {
  const h = harness();
  try {
    await h.session.start();
    h.session.setAppActive(false);
    h.clock.now += 600_000;
    await h.clock.fire(600_000);
    assert.equal(h.transports[0].statsCalls, 0);
    assert.equal(h.transports[0].closed, true);
    assert.deepEqual(h.transports[0].muteChanges, [true]);
    assert.match(h.session.getSnapshot().error ?? '', /10-minute limit/);
  } finally {
    await h.cleanup();
  }
});

test('foregrounding reconciles the deadline after JavaScript timers were suspended', async () => {
  const h = harness();
  try {
    await h.session.start();
    h.session.setAppActive(false);
    h.clock.now += 615_000;
    h.session.setAppActive(true);
    await settle();
    assert.equal(h.transports[0].closed, true);
    assert.equal(h.transports[0].statsCalls, 0);
    assert.match(h.session.getSnapshot().error ?? '', /10-minute limit/);
  } finally {
    await h.cleanup();
  }
});

test('incoming events also reconcile the background deadline after timers were delayed', async () => {
  const h = harness();
  try {
    await h.session.start();
    h.session.setAppActive(false);
    h.clock.now += 601_000;
    h.transports[0].emit({
      type: 'session.output_transcript.delta',
      delta: 'Late output',
      start_ms: 601_000,
    });
    await settle();
    assert.equal(h.transports[0].closed, true);
    assert.deepEqual(h.session.getSnapshot().transcript, []);
    assert.match(h.session.getSnapshot().error ?? '', /10-minute limit/);
  } finally {
    await h.cleanup();
  }
});

test('a stats result arriving in the background does not restore visual levels', async () => {
  const h = harness();
  const pending = deferred<AudioStats>();
  try {
    await h.session.start();
    h.transports[0].statsResult = () => pending.promise;
    await h.clock.fire(120);
    h.session.setAppActive(false);
    pending.resolve({ inputLevel: 0.2, outputLevel: 0.3, sentPackets: 10, receivedPackets: 20 });
    await settle();
    assert.equal(h.session.getSnapshot().inputLevel, 0);
    assert.equal(h.session.getSnapshot().outputLevel, 0);
    assert.equal(h.session.getSnapshot().status, 'connected');
  } finally {
    await h.cleanup();
  }
});

test('an earlier stalled stats operation cannot block a new session', async () => {
  const h = harness();
  try {
    await h.session.start();
    h.transports[0].statsResult = () => new Promise(() => {});
    await h.clock.fire(120);
    await h.session.stop();
    await h.session.start();
    await h.clock.fire(120);
    assert.equal(h.transports[1].statsCalls, 1);
    assert.ok(h.session.getSnapshot().outputLevel > 0);
  } finally {
    await h.cleanup();
  }
});

test('missing close acknowledgment uses the server fallback once', async () => {
  const h = harness();
  try {
    await h.session.start();
    h.transports[0].acknowledgeClose = 'none';
    const stopping = h.session.stop();
    await settle();
    await h.clock.fire(1500);
    await stopping;
    assert.deepEqual(h.closed, ['live_1']);
    assert.equal(h.session.getSnapshot().status, 'idle');
    assert.equal(h.transports[0].closed, true);
  } finally {
    await h.cleanup();
  }
});

test('old transport events cannot alter a later conversation', async () => {
  const h = harness();
  try {
    await h.session.start();
    const old = h.transports[0];
    await h.session.stop();
    await h.session.start();
    old.emit({ type: 'session.closed' });
    old.emit({
      type: 'session.output_transcript.delta',
      delta: 'Old speech',
      start_ms: 10,
      end_ms: 20,
    });
    old.callbacks.onFailure('Old failure');
    await settle();
    assert.equal(h.session.getSnapshot().status, 'connected');
    assert.deepEqual(h.session.getSnapshot().transcript, []);
  } finally {
    await h.cleanup();
  }
});
