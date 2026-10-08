import { describe, expect, it } from 'vitest';
import { AgentContext } from '../../../src/worker/agent/context';
import { functionCall } from './responses-fixtures';

const response = (id: string) => ({ id, text: 'Complete.', calls: [], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } });

describe('bounded Responses context and branch checkpoints', () => {
  it('sends new input only and deduplicates unchanged observations', () => {
    const context = new AgentContext();
    context.beginTurn('First'); context.observeTerminal('output'); context.observeMemory('v1', 'memory');
    context.accept(response('resp_1'), context.pending.length);
    context.beginTurn('Second'); context.observeTerminal('output'); context.observeMemory('v1', 'memory');
    expect(context.responseId).toBe('resp_1');
    expect(context.pending).toEqual([{ role: 'user', content: 'Second' }]);
    context.observeMemory('v2', 'changed memory');
    expect(context.pending).toHaveLength(2);
  });

  it('branches before the edited turn without rolling back actual remote state', () => {
    const context = new AgentContext();
    context.beginTurn('First'); context.accept(response('resp_1'), context.pending.length);
    context.beginTurn('Second'); context.accept(response('resp_2'), context.pending.length);
    context.beginTurn('Corrected second', 1);
    expect(context.responseId).toBe('resp_1');
    expect(JSON.stringify(context.pending)).toContain('does not undo remote operations');
    expect(JSON.stringify(context.pending)).not.toContain('First');
    expect(() => context.beginTurn('Unavailable', 2)).toThrow();
  });

  it('retains earlier evidence for compaction after editing, but discards the edited future', () => {
    const context = new AgentContext();
    context.beginTurn('Earlier request'); context.accept(response('resp_1'), context.pending.length);
    context.toolResult(functionCall(), 'Earlier remote fact');
    context.beginTurn('Discarded future'); context.accept(response('resp_2'), context.pending.length);
    context.toolResult(functionCall('future'), 'Discarded future result');
    context.beginTurn('Corrected request', 1);
    expect(context.checkpointInput()).toContain('Earlier remote fact');
    expect(context.checkpointInput()).toContain('Corrected request');
    expect(context.checkpointInput()).not.toContain('Discarded future');
  });

  it('closes unsent tool calls on supersede and preserves exact outputs on edit', () => {
    const context = new AgentContext();
    context.beginTurn('First'); context.accept(response('resp_1'), context.pending.length);
    context.toolResult(functionCall(), 'Actual remote result');
    context.beginTurn('Second'); context.accept(response('resp_2'), context.pending.length);
    context.beginTurn('Corrected second', 1);
    expect(context.pending[0]).toMatchObject({ type: 'function_call_output', call_id: 'call_1', output: 'Actual remote result' });
  });

  it('evicts old edit checkpoints by count without changing the live chain', () => {
    const context = new AgentContext();
    for (let i = 0; i < 65; i++) { context.beginTurn(`Turn ${i}`); context.accept(response(`resp_${i}`), context.pending.length); }
    expect(() => context.beginTurn('Old edit', 0)).toThrow();
    expect(context.responseId).toBe('resp_64');
    context.beginTurn('Recent edit', 64);
    expect(context.responseId).toBe('resp_63');
  });

  it('bounds edit checkpoint characters after interrupted large tool batches', () => {
    const context = new AgentContext();
    context.responseId = 'resp_remote';
    for (let i = 0; i < 9; i++) context.toolResult(functionCall(`call_${i}`), 'x'.repeat(64_000));
    context.beginTurn('Continue');
    expect(context.pending.filter(item => 'type' in item)).toHaveLength(9);
    expect(() => context.beginTurn('Edit evicted large checkpoint', 0)).toThrow();
    expect(context.responseId).toBe('resp_remote');
  });

  it('restarts from a checkpoint without orphaned tool results or replayed calls', () => {
    const context = new AgentContext();
    context.beginTurn('Inspect'); context.responseId = 'resp_1';
    context.toolResult(functionCall(), 'status unknown: interrupted');
    expect(context.needsCheckpoint(100, 'Stable instructions')).toBe(true);
    expect(context.checkpointInput()).toContain('status unknown');
    context.replaceWithCheckpoint('Inspect before retrying the unknown command.');
    expect(context.responseId).toBeUndefined();
    expect(context.pending.every(item => 'role' in item)).toBe(true);
    expect(JSON.stringify(context.pending)).toContain('context checkpoint');
  });
});
