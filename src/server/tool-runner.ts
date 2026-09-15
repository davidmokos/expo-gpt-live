import { executeTool } from './tools';

type Command = Record<string, unknown>;
type ToolCall = { id: string; result?: string };
type PendingResponse = {
  calls: Map<string, ToolCall>;
  controller: AbortController;
  complete: boolean;
  finished: boolean;
};
type Options = {
  send: (event: Command) => void;
  onFailure: (message: string) => void;
  execute?: typeof executeTool;
  maxCalls?: number;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Live wraps Responses events. Collect completed function items, since terminal
// response snapshots deliberately omit their output. Continue only after every result.
export class ToolRunner {
  private responses = new Map<string, PendingResponse>();
  private delegations = new Map<string, string>();
  private callIds = new Set<string>();
  private commandIds = new Set<string>();
  private closed = false;
  private sequence = 0;

  constructor(private options: Options) {}

  handle(envelope: unknown) {
    if (this.closed || !record(envelope)) return;
    if (envelope.type === 'session.closed') return this.close();
    if (envelope.type === 'error' && record(envelope.error)) {
      const id = envelope.error.client_event_id ?? envelope.client_event_id;
      if (typeof id === 'string' && this.commandIds.has(id)) {
        this.fail();
      }
      return;
    }
    if (envelope.type !== 'response.event' || !record(envelope.event)) return;
    const event = envelope.event;
    const response = record(event.response) ? event.response : undefined;
    const delegation = typeof envelope.delegation_id === 'string' ? envelope.delegation_id : '';
    const id =
      typeof response?.id === 'string'
        ? response.id
        : typeof event.response_id === 'string'
          ? event.response_id
          : this.delegations.get(delegation);

    if (event.type === 'response.created') {
      if (typeof response?.id !== 'string' || !response.id) return;
      if (this.responses.has(response.id)) return;
      if (this.responses.size >= 128) return this.fail();
      const previousId = this.delegations.get(delegation);
      const previous = previousId ? this.responses.get(previousId) : undefined;
      // Granular events do not carry a response ID. A successor owns this
      // delegation's stream, so unfinished work must not continue it later.
      if (previous) this.finish(previous);
      this.delegations.set(delegation, response.id);
      this.responses.set(response.id, {
        calls: new Map(),
        controller: new AbortController(),
        complete: false,
        finished: false,
      });
      return;
    }
    const pending = id ? this.responses.get(id) : undefined;
    if (!pending || pending.finished) return;

    if (event.type === 'response.output_item.done' && record(event.item)) {
      const item = event.item;
      if (item.type !== 'function_call') return;
      if (item.status !== undefined && item.status !== 'completed') return;
      if (
        typeof item.call_id !== 'string' ||
        !item.call_id ||
        typeof item.name !== 'string' ||
        typeof item.arguments !== 'string'
      ) {
        return this.fail();
      }
      if (this.callIds.has(item.call_id)) return;
      if (this.callIds.size >= (this.options.maxCalls ?? 20)) return this.fail();
      this.callIds.add(item.call_id);
      const call: ToolCall = { id: item.call_id };
      pending.calls.set(call.id, call);
      const execute = this.options.execute ?? executeTool;
      const name = item.name;
      const argumentsJson = item.arguments;
      void Promise.resolve()
        .then(() => {
          if (pending.controller.signal.aborted) return;
          return execute(name, argumentsJson, { signal: pending.controller.signal });
        })
        .catch(() => toolFailure())
        .then((result) => {
          if (this.closed || pending.finished || pending.controller.signal.aborted) return;
          call.result = typeof result === 'string' ? result : toolFailure();
          this.continue(pending);
        })
        .catch(() => this.fail());
    }
    if (event.type === 'response.completed') {
      if (response?.status !== 'completed') {
        this.finish(pending);
        return;
      }
      pending.complete = true;
      this.continue(pending);
    }
    if (
      ['response.failed', 'response.cancelled', 'response.incomplete'].includes(String(event.type))
    ) {
      this.finish(pending);
    }
  }

  private continue(pending: PendingResponse) {
    if (this.closed || pending.finished || !pending.complete) return;
    const calls = [...pending.calls.values()];
    if (calls.some((call) => call.result === undefined)) return;
    pending.finished = true;
    if (!calls.length) return;
    try {
      for (const call of calls) {
        this.send({
          type: 'response.item.create',
          item: { type: 'function_call_output', call_id: call.id, output: call.result },
        });
      }
      this.send({ type: 'response.create' });
    } catch {
      this.fail();
    }
  }

  private send(event: Command) {
    if (this.closed) return;
    const id = `tool-${++this.sequence}`;
    this.commandIds.add(id);
    this.options.send({ ...event, event_id: id });
  }

  private finish(pending: PendingResponse) {
    pending.finished = true;
    pending.controller.abort();
  }

  private fail() {
    if (this.closed) return;
    this.close();
    this.options.onFailure('The tool connection failed. Start a new conversation to reconnect.');
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.responses.values()) pending.controller.abort();
    this.responses.clear();
    this.delegations.clear();
    this.callIds.clear();
    this.commandIds.clear();
  }
}

function toolFailure() {
  return JSON.stringify({
    ok: false,
    error: { code: 'tool_failed', message: 'The tool could not finish. Try again later.' },
  });
}
