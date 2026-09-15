import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import test from 'node:test';

import { ToolRunner } from '../src/server/tool-runner';

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup(options: Partial<ConstructorParameters<typeof ToolRunner>[0]> = {}) {
  const sent: Record<string, unknown>[] = [];
  const failures: string[] = [];
  const jobs: {
    name: string;
    argumentsJson: string;
    signal?: AbortSignal;
    result: ReturnType<typeof deferred>;
  }[] = [];
  const runner = new ToolRunner({
    send: (event) => sent.push(event),
    onFailure: (message) => failures.push(message),
    execute: async (name, argumentsJson, options) => {
      const result = deferred();
      jobs.push({ name, argumentsJson, signal: options?.signal, result });
      return result.promise;
    },
    ...options,
  });
  function event(event: Record<string, unknown>, delegation: string | null = 'delegation-1') {
    runner.handle({ type: 'response.event', delegation_id: delegation, event });
  }
  function created(id = 'response-1', delegation: string | null = 'delegation-1') {
    event(
      { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
      delegation,
    );
  }
  function item(callId = 'call-1', delegation: string | null = 'delegation-1') {
    event(
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: callId,
          name: 'get_weather',
          arguments: '{"location":"Paris, France","units":"celsius"}',
          status: 'completed',
        },
      },
      delegation,
    );
  }
  function completed(id = 'response-1', delegation: string | null = 'delegation-1') {
    event(
      { type: 'response.completed', response: { id, status: 'completed', output: [] } },
      delegation,
    );
  }
  return { runner, sent, failures, jobs, event, created, item, completed };
}

test('collects granular calls despite empty terminal output and waits for every result', async () => {
  const flow = setup();
  flow.created();
  flow.item('call-1');
  flow.item('call-2');
  flow.completed();
  await flush();
  assert.equal(flow.jobs.length, 2);
  assert.equal(flow.jobs[0].name, 'get_weather');
  assert.equal(JSON.parse(flow.jobs[0].argumentsJson).location, 'Paris, France');
  flow.jobs[1].result.resolve('{"temperature":19}');
  await flush();
  assert.deepEqual(flow.sent, []);
  flow.jobs[0].result.resolve('{"temperature":18}');
  await flush();
  assert.deepEqual(flow.sent, [
    {
      type: 'response.item.create',
      event_id: 'tool-1',
      item: { type: 'function_call_output', call_id: 'call-1', output: '{"temperature":18}' },
    },
    {
      type: 'response.item.create',
      event_id: 'tool-2',
      item: { type: 'function_call_output', call_id: 'call-2', output: '{"temperature":19}' },
    },
    { type: 'response.create', event_id: 'tool-3' },
  ]);
  assert.deepEqual(flow.failures, []);
});

test('completed tools wait for the response to finish and duplicate events do not repeat work', async () => {
  const flow = setup();
  flow.created();
  flow.created();
  flow.item();
  flow.item();
  await flush();
  assert.equal(flow.jobs.length, 1);
  flow.jobs[0].result.resolve('{}');
  await flush();
  assert.equal(flow.sent.length, 0);
  flow.completed();
  flow.completed();
  flow.item();
  await flush();
  assert.equal(flow.sent.length, 2);
  assert.equal(flow.jobs.length, 1);
});

test('ignores unwrapped events, arguments-only events, non-function items and unfinished items', async () => {
  const flow = setup();
  flow.created();
  flow.runner.handle({ type: 'response.output_item.done', item: { type: 'function_call' } });
  flow.event({ type: 'response.function_call_arguments.done', arguments: '{}' });
  flow.event({ type: 'response.output_item.done', item: { type: 'message' } });
  for (const status of ['in_progress', 'incomplete']) {
    flow.event({
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: status,
        name: 'get_weather',
        arguments: '{}',
        status,
      },
    });
  }
  flow.completed();
  await flush();
  assert.deepEqual(flow.jobs, []);
  assert.deepEqual(flow.sent, []);
  assert.deepEqual(flow.failures, []);
});

test('accepts done function items whose optional status is omitted', async () => {
  const flow = setup();
  flow.created();
  flow.event({
    type: 'response.output_item.done',
    item: { type: 'function_call', call_id: 'call-1', name: 'get_weather', arguments: '{}' },
  });
  flow.completed();
  await flush();
  flow.jobs[0].result.resolve('{}');
  await flush();
  assert.equal(flow.sent.length, 2);
});

test('a continuation uses a fresh response ID within the same delegation', async () => {
  const flow = setup();
  for (let index = 1; index <= 2; index++) {
    flow.created(`response-${index}`);
    flow.item(`call-${index}`);
    flow.completed(`response-${index}`);
    await flush();
    flow.jobs[index - 1].result.resolve('{}');
    await flush();
  }
  assert.equal(flow.jobs.length, 2);
  assert.deepEqual(
    flow.sent
      .filter((event) => event.item)
      .map((event) => (event.item as { call_id: string }).call_id),
    ['call-1', 'call-2'],
  );
  assert.equal(flow.sent.filter((event) => event.type === 'response.create').length, 2);
});

test('a successor cancels old work and late results cannot continue the new response', async () => {
  const flow = setup();
  flow.created();
  flow.item();
  flow.completed();
  await flush();
  flow.created('response-2');
  assert.equal(flow.jobs[0].signal?.aborted, true);
  flow.created('response-1'); // Replayed creation must not restore the old mapping.
  flow.completed('response-1');
  flow.item('call-2');
  flow.completed('response-2');
  await flush();
  flow.jobs[0].result.resolve('{"stale":true}');
  await flush();
  assert.equal(flow.sent.length, 0);
  flow.jobs[1].result.resolve('{"fresh":true}');
  await flush();
  assert.equal(flow.sent.length, 2);
  assert.equal((flow.sent[0].item as { call_id: string }).call_id, 'call-2');
});

test('interleaved delegation streams keep their function calls separate', async () => {
  const flow = setup();
  flow.created('response-a', 'delegation-a');
  flow.created('response-b', 'delegation-b');
  flow.item('call-b', 'delegation-b');
  flow.item('call-a', 'delegation-a');
  flow.completed('response-a', 'delegation-a');
  await flush();
  flow.jobs[0].result.resolve('{}');
  await flush();
  assert.equal(flow.sent.length, 0);
  flow.jobs[1].result.resolve('{}');
  await flush();
  assert.equal((flow.sent[0].item as { call_id: string }).call_id, 'call-a');
  flow.completed('response-b', 'delegation-b');
  assert.equal((flow.sent[2].item as { call_id: string }).call_id, 'call-b');
});

test('uncorrelated response streams can omit their delegation ID', async () => {
  const flow = setup();
  flow.created('response-1', null);
  flow.item('call-1', null);
  flow.completed('response-1', null);
  await flush();
  flow.jobs[0].result.resolve('{}');
  await flush();
  assert.equal(flow.sent.length, 2);
});

test('failed, incomplete and canceled responses abort lookups and suppress their results', async () => {
  for (const type of [
    'response.failed',
    'response.incomplete',
    'response.cancelled',
    'response.completed',
  ]) {
    const flow = setup();
    flow.created();
    flow.item();
    await flush();
    flow.event({ type, response: { id: 'response-1', status: 'incomplete', output: [] } });
    assert.equal(flow.jobs[0].signal?.aborted, true);
    flow.jobs[0].result.resolve('{}');
    flow.completed();
    await flush();
    assert.deepEqual(flow.sent, []);
  }
});

test('closing before execution avoids the lookup; closing during execution aborts it', async () => {
  for (const started of [false, true]) {
    const flow = setup();
    flow.created();
    flow.item();
    flow.completed();
    if (started) await flush();
    flow.runner.handle({ type: 'session.closed' });
    flow.runner.close();
    if (started) {
      assert.equal(flow.jobs[0].signal?.aborted, true);
      flow.jobs[0].result.resolve('{}');
    }
    flow.created('response-2');
    flow.item('call-2');
    await flush();
    assert.equal(flow.jobs.length, started ? 1 : 0);
    assert.deepEqual(flow.sent, []);
    assert.deepEqual(flow.failures, []);
  }
});

test('tool exceptions produce a sanitized result and allow the backend to continue', async () => {
  const flow = setup();
  flow.created();
  flow.item();
  flow.completed();
  await flush();
  flow.jobs[0].result.reject(new Error('private service details'));
  await flush();
  const output = JSON.parse((flow.sent[0].item as { output: string }).output);
  assert.equal(output.error.code, 'tool_failed');
  assert.equal(JSON.stringify(flow.sent).includes('private service details'), false);
  assert.equal(flow.sent[1].type, 'response.create');
});

test('malformed function items fail once and cancel all unfinished tools', async () => {
  const flow = setup();
  flow.created();
  flow.item();
  await flush();
  flow.event({ type: 'response.output_item.done', item: { type: 'function_call', call_id: '' } });
  flow.event({ type: 'response.output_item.done', item: { type: 'function_call' } });
  assert.equal(flow.failures.length, 1);
  assert.equal(flow.jobs[0].signal?.aborted, true);
  flow.jobs[0].result.resolve('{}');
  flow.completed();
  await flush();
  assert.deepEqual(flow.sent, []);
});

test('the per-session call limit prevents further execution without counting duplicates', async () => {
  const flow = setup({ maxCalls: 1 });
  flow.created();
  flow.item();
  flow.item();
  await flush();
  assert.equal(flow.failures.length, 0);
  flow.item('call-2');
  await flush();
  assert.equal(flow.jobs.length, 1);
  assert.equal(flow.jobs[0].signal?.aborted, true);
  assert.equal(flow.failures.length, 1);
  flow.jobs[0].result.resolve('{}');
});

test('the response history limit bounds retained state', () => {
  const flow = setup();
  for (let index = 0; index < 128; index++) {
    flow.created(`response-${index}`);
    flow.completed(`response-${index}`);
  }
  assert.deepEqual(flow.failures, []);
  flow.created('response-limit');
  assert.equal(flow.failures.length, 1);
});

test('only errors correlated to tool commands fail the runner', async () => {
  for (const nested of [true, false]) {
    const flow = setup();
    flow.created();
    flow.item();
    flow.completed();
    await flush();
    flow.jobs[0].result.resolve('{}');
    await flush();
    flow.runner.handle({ type: 'error', error: { client_event_id: 'unrelated-command' } });
    assert.deepEqual(flow.failures, []);
    const correlation = { client_event_id: flow.sent[0].event_id };
    const error = nested ? { error: correlation } : { error: {}, ...correlation };
    flow.runner.handle({ type: 'error', ...error });
    flow.runner.handle({ type: 'error', ...error });
    assert.equal(flow.failures.length, 1);
  }
});

test('a failed result send stops the batch before requesting a continuation', async () => {
  const flow = setup({
    send: () => {
      throw new Error('private socket details');
    },
  });
  flow.created();
  flow.item();
  flow.completed();
  await flush();
  flow.jobs[0].result.resolve('{}');
  await flush();
  assert.equal(flow.failures.length, 1);
  assert.equal(flow.failures[0].includes('private socket details'), false);
});

test('a synchronous close during a send prevents the remaining commands', async () => {
  let sends = 0;
  const flow = setup({
    send: () => {
      sends++;
      flow.runner.close();
    },
  });
  flow.created();
  flow.item('call-1');
  flow.item('call-2');
  flow.completed();
  await flush();
  for (const job of flow.jobs) job.result.resolve('{}');
  await flush();
  assert.equal(sends, 1);
});
