import { normalizeAIBaseUrl } from '../ai-endpoint';
import { resolveAIModelBudgets } from '../ai-model-policy';
import { probeNativeCompaction } from './agent/capability-probe';
import { ResponsesError } from './agent/responses-client';

const MAX_BODY_BYTES = 16 * 1024;
const COOLDOWN_MS = 60_000;
const MAX_ENTRIES = 256;

async function readJSON(body: Request | Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const reader = body.body?.getReader();
  if (!reader) throw new ResponsesError('responses_input');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let length = 0;
  let text = '';
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) throw new ResponsesError('responses_input');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ResponsesError('responses_input');
    return parsed as Record<string, unknown>;
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Per-isolate shedding only, NOT an authoritative distributed billing/rate limit.
 * Fresh factory instances isolate tests; production uses the one exported handler below.
 */
export function createAICapabilityHandler() {
  const active = new Map<string, { inFlight: boolean; expiresAt: number }>();
  return async (request: Request, userId: number, ownerId: string, stub: DurableObjectStub): Promise<Response> => {
    let origin: string;
    try { origin = new URL(request.url).origin; }
    catch { return Response.json({ code: 'responses_input' }, { status: 400 }); }
    if (request.method !== 'POST') return Response.json({ code: 'responses_input' }, { status: 405 });
    // Unlike a read-only model list, this operation can spend money. Missing Origin fails closed.
    if (request.headers.get('Origin') !== origin) return Response.json({ error: 'Forbidden' }, { status: 403 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('probe_request_timeout'), 65_000);
    const signal = AbortSignal.any([request.signal, controller.signal]);
    let gate: { inFlight: boolean; expiresAt: number } | undefined;
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new ResponsesError('responses_timeout'));
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([cancelled, (async () => {
        let body: Record<string, unknown>;
        try { body = await readJSON(request, signal); }
        catch { throw new ResponsesError('responses_input'); }
        if (body.acknowledge_cost !== true) throw new ResponsesError('responses_probe_consent');
        if (typeof body.base_url !== 'string' || body.base_url.length > 2048 ||
          typeof body.model !== 'string' || !body.model.trim() || body.model.length > 256 ||
          (body.api_key != null && (typeof body.api_key !== 'string' || body.api_key.length > 8192))) {
          throw new ResponsesError('responses_input');
        }
        let root: string;
        try { root = normalizeAIBaseUrl(body.base_url); }
        catch { throw new ResponsesError('responses_address'); }
        let budgets: ReturnType<typeof resolveAIModelBudgets>;
        try { budgets = resolveAIModelBudgets(body); }
        catch { throw new ResponsesError('responses_limits'); }
        const now = Date.now();
        for (const [key, value] of active) if (!value.inFlight && value.expiresAt <= now) active.delete(key);
        const key = `${ownerId}:${userId}`;
        if (active.has(key) || active.size >= MAX_ENTRIES) {
          return Response.json({ code: 'responses_probe_busy' }, { status: 429, headers: { 'Retry-After': '60' } });
        }
        gate = { inFlight: true, expiresAt: now + COOLDOWN_MS };
        active.set(key, gate);
        let apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
        if (!apiKey) {
          const savedRes = await stub.fetch(new Request(`http://internal/internal/ai-config/decrypt?user_id=${userId}`, { signal }));
          signal.throwIfAborted();
          if (!savedRes.ok) {
            void savedRes.body?.cancel();
            throw new ResponsesError('ai_not_configured');
          }
          const saved = await readJSON(savedRes, signal);
          let savedRoot: string;
          try { savedRoot = normalizeAIBaseUrl(String(saved.base_url ?? '')); }
          catch { throw new ResponsesError('responses_key_required'); }
          if (root !== savedRoot) throw new ResponsesError('responses_key_required');
          if (typeof saved.api_key !== 'string' || !saved.api_key.trim() || saved.api_key.length > 8192) {
            throw new ResponsesError('ai_not_configured');
          }
          apiKey = saved.api_key.trim();
        }
        signal.throwIfAborted();
        const result = await probeNativeCompaction({ base_url: root, api_key: apiKey,
          model: body.model.trim(), ...budgets }, signal);
        return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
      })()]);
    } catch (error) {
      const code = signal.aborted ? 'responses_timeout'
        : error instanceof ResponsesError ? error.code : 'responses_failed';
      return Response.json({ code }, { status: code === 'responses_timeout' ? 504 : code === 'responses_failed' ? 502 : 400,
        headers: { 'Cache-Control': 'no-store' } });
    } finally {
      if (gate) gate.inFlight = false;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  };
}

export const handleAICapabilityProbe = createAICapabilityHandler();
