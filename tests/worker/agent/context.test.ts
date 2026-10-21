import { describe, expect, it } from 'vitest';
import { AgentContext } from '../../../src/worker/agent/context';
import { MAX_CONTEXT_BYTES, bytes } from '../../../src/worker/agent/context-limits';
import type { ModelResponse, ResponseFunctionCall } from '../../../src/worker/agent/types';
import { functionCall, responseObject } from './responses-fixtures';

function response(id: string, text = 'Done', calls: ResponseFunctionCall[] = []): ModelResponse {
  return { ...responseObject(id, text, calls), text, calls } as ModelResponse;
}
function accept(context: AgentContext, value: ModelResponse) { context.accept(value, context.buildInput()); }

describe('Conversation context', () => {
  it('replays native history and adds observations only when they change', () => {
    const context = new AgentContext();
    context.beginTurn('Inspect'); context.observeTerminal('output'); context.observeMemory('v1', 'saved key');
    accept(context, response('first'));
    context.beginTurn('Continue'); context.observeTerminal('output'); context.observeMemory('v1', 'saved key');
    expect(context.pending).toEqual([{ role: 'user', content: 'Continue' }]);
    expect(context.history).toContainEqual(expect.objectContaining({ id: 'msg_first' }));
  });

  it('branches an edited turn and rejects an unavailable edit without changing history', () => {
    const context = new AgentContext();
    context.beginTurn('First'); accept(context, response('first'));
    context.beginTurn('Second'); accept(context, response('second'));
    context.beginTurn('Corrected second', 1);
    expect(JSON.stringify(context.buildInput())).toContain('msg_first');
    expect(JSON.stringify(context.buildInput())).not.toContain('msg_second');
    const before = context.buildInput();
    expect(() => context.beginTurn('Invalid', 5)).toThrow();
    expect(context.buildInput()).toEqual(before);
  });

  it('keeps native call/output pairs together when compacting and continuing after a failed request', () => {
    const context = new AgentContext(); context.beginTurn('Deploy');
    const call = functionCall(); accept(context, response('first', '', [call]));
    expect(() => context.replaceWithCompaction('too early')).toThrow();
    context.toolResult(call, 'actual command result');
    expect(() => context.toolResult(call, 'duplicate')).toThrow();
    const { recent } = context.splitForCompaction();
    context.replaceWithCompaction('Earlier work summarized', recent);
    context.beginTurn('Continue');
    expect(context.buildInput()).toContainEqual(call);
    expect(context.buildInput()).toContainEqual({ type: 'function_call_output', call_id: call.call_id, output: 'actual command result' });
  });

  it('does not turn missing token usage into a byte-sized token count', () => {
    const context = new AgentContext(); context.beginTurn('Inspect');
    const value = response('first', 'x'.repeat(5000)); delete value.usage;
    accept(context, value);
    expect(context.needsCheckpoint(6000, '')).toBe(false);
    expect(context.needsCheckpoint(2000, '')).toBe(true);
  });

  it('keeps memory use bounded without corrupting completed history', () => {
    const context = new AgentContext(); context.beginTurn('Inspect');
    const before = context.buildInput();
    expect(() => accept(context, response('huge', 'x'.repeat(MAX_CONTEXT_BYTES)))).toThrow();
    expect(context.buildInput()).toEqual(before);
    const call = functionCall(); accept(context, response('tool', '', [call]));
    context.toolResult(call, JSON.stringify({ status: 'unknown', stdout: '界'.repeat(100_000) }));
    expect(bytes(context.pending[0])).toBeLessThan(64 * 1024);
  });

  it('keeps supplied credential text intact in the conversation used for memory', () => {
    const context = new AgentContext(); const key = 'TOKEN-' + 'A'.repeat(1500);
    context.beginTurn('Use this key: ' + key); accept(context, response('saved', 'I will use it.'));
    expect(context.formatItemsForCompaction()).toContain(key);
  });
});
