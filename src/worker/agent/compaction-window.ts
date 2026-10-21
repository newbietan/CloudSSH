import type { ResponseInput } from './types';

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Validate, never normalize/prune: /responses/compact output is the canonical next window.
 * Hosted tools, privileged roles and unfinished tool transactions are outside our protocol boundary.
 * No item in this window is ever dispatched as a newly authorized tool call.
 */
export function validatedCompactionWindow(value: unknown): ResponseInput[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 4096) return null;
  let compaction = false;
  for (const item of value) {
    if (!record(item)) return null;
    if (item.id != null && !text(item.id)) return null;
    switch (item.type) {
      case 'compaction':
        if (!text(item.id) || !text(item.encrypted_content) ||
          (item.created_by != null && !text(item.created_by))) return null;
        compaction = true;
        break;
      case 'message':
        if (!['user', 'assistant'].includes(String(item.role)) || !Array.isArray(item.content) ||
          (item.status != null && !(item.role === 'user' ? ['completed'] : ['completed', 'incomplete', 'in_progress']).includes(String(item.status))) ||
          (item.phase != null && !['commentary', 'final_answer'].includes(String(item.phase)))) return null;
        for (const part of item.content) {
          if (!record(part)) return null;
          if (item.role === 'user') {
            if (part.type !== 'input_text' || typeof part.text !== 'string') return null;
          } else if (part.type === 'output_text') {
            if (typeof part.text !== 'string' || (part.annotations != null && !Array.isArray(part.annotations))) return null;
          } else if (part.type !== 'refusal' || typeof part.refusal !== 'string') return null;
        }
        break;
      case 'reasoning':
        if (!Array.isArray(item.summary) || !item.summary.every(part => record(part) &&
          part.type === 'summary_text' && typeof part.text === 'string') ||
          (item.encrypted_content != null && typeof item.encrypted_content !== 'string') ||
          (item.status != null && !['completed', 'incomplete', 'in_progress'].includes(String(item.status)))) return null;
        if (item.content != null && (!Array.isArray(item.content) || !item.content.every(part =>
          record(part) && part.type === 'reasoning_text' && typeof part.text === 'string'))) return null;
        break;
      case 'function_call':
        if (!text(item.call_id) || !text(item.name) || typeof item.arguments !== 'string' ||
          item.arguments.length > 64_000 || (item.status != null && item.status !== 'completed')) return null;
        break;
      case 'function_call_output':
        if (!text(item.call_id) || typeof item.output !== 'string') return null;
        break;
      case undefined:
        if (item.role !== 'user' || typeof item.content !== 'string') return null;
        break;
      default:
        return null;
    }
  }
  // SAFETY: every item shape was checked above; keep ALL original fields and ordering unchanged.
  return compaction ? structuredClone(value) as ResponseInput[] : null;
}
