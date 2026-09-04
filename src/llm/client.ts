/**
 * LLM client — OpenAI-compatible chat completions over our own inference
 * infrastructure (AiAS PIN → hearth on the A6000, model GLM-4-32B by Mark's
 * call). Swappable by env; nothing in CHALK depends on which model answers.
 *
 * Env:
 *   CHALK_LLM_URL      default https://api.aiassist.net/api/v1/pin/chat/completions
 *   CHALK_LLM_KEY      bearer token (falls back to AIASSIST_API_KEY)
 *   CHALK_LLM_MODEL    default GLM-4-32B
 *   CHALK_LLM_PROVIDER default pin  (sent as X-AiAssist-Provider; empty string disables)
 *   CHALK_LLM_MAX_TOKENS default 2048 — ALWAYS sent explicitly. An omitted
 *                      max_tokens is not "unlimited"; it is the server default.
 *
 * Streaming: the only deadline is INACTIVITY (reset on every delta). A model
 * that keeps producing may run as long as it needs; a socket that stops
 * making progress is aborted. First-token deadline covers connect+headers.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmConfig {
  url: string;
  key: string | undefined;
  model: string;
  provider: string;
  maxTokens: number;
  temperature: number;
  /** ms with no bytes before we abort a stream. */
  inactivityMs: number;
  /** ms allowed for connect + headers + first byte. */
  firstByteMs: number;
  fetchImpl?: typeof fetch;
}

export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  return {
    url: env.CHALK_LLM_URL ?? "https://api.aiassist.net/api/v1/pin/chat/completions",
    key: env.CHALK_LLM_KEY || env.AIASSIST_API_KEY || undefined,
    model: env.CHALK_LLM_MODEL ?? "GLM-4-32B",
    provider: env.CHALK_LLM_PROVIDER ?? "pin",
    maxTokens: Number(env.CHALK_LLM_MAX_TOKENS ?? 2048),
    temperature: Number(env.CHALK_LLM_TEMPERATURE ?? 0.2),
    inactivityMs: Number(env.CHALK_LLM_INACTIVITY_MS ?? 90_000),
    firstByteMs: Number(env.CHALK_LLM_FIRST_BYTE_MS ?? 60_000),
  };
}

export interface CompletionResult {
  content: string;
  model: string;
  finish_reason: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  latency_ms: number;
  raw?: unknown;
}

export class LlmError extends Error {
  readonly status: number | null;
  readonly body: string;
  constructor(message: string, status: number | null, body: string) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.body = body;
  }
}

function headers(cfg: LlmConfig): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (cfg.key) h.authorization = `Bearer ${cfg.key}`;
  if (cfg.provider) h["x-aiassist-provider"] = cfg.provider;
  return h;
}

export async function complete(cfg: LlmConfig, messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number } = {}): Promise<CompletionResult> {
  const f = cfg.fetchImpl ?? fetch;
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.firstByteMs + cfg.inactivityMs);
  try {
    const res = await f(cfg.url, {
      method: "POST",
      headers: headers(cfg),
      signal: ctl.signal,
      body: JSON.stringify({
        model: cfg.model,
        messages,
        max_tokens: opts.maxTokens ?? cfg.maxTokens,
        temperature: opts.temperature ?? cfg.temperature,
        stream: false,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new LlmError(`llm ${res.status} from ${cfg.url}: ${text.slice(0, 500)}`, res.status, text);
    const body = JSON.parse(text) as {
      model?: string;
      choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null; reasoning_content?: string; thinking?: string } }>;
      usage?: CompletionResult["usage"];
    };
    const choice = body.choices?.[0];
    const content = choice?.message?.content ?? "";
    return {
      content,
      model: body.model ?? cfg.model,
      finish_reason: choice?.finish_reason ?? null,
      usage: body.usage,
      latency_ms: Date.now() - started,
      raw: body,
    };
  } catch (e) {
    if (e instanceof LlmError) throw e;
    throw new LlmError(`llm request failed: ${(e as Error).message}`, null, "");
  } finally {
    clearTimeout(timer);
  }
}

export interface StreamEvent {
  type: "delta" | "done" | "error";
  text?: string;
  finish_reason?: string | null;
  usage?: CompletionResult["usage"];
  error?: string;
}

/**
 * Streamed completion. Yields text deltas as they arrive; the final event
 * carries finish_reason. Deadline is inactivity-only.
 */
export async function* stream(cfg: LlmConfig, messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number } = {}): AsyncGenerator<StreamEvent> {
  const f = cfg.fetchImpl ?? fetch;
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  let why = "first byte";
  const arm = (ms: number, reason: string) => {
    if (timer) clearTimeout(timer);
    why = reason;
    timer = setTimeout(() => ctl.abort(), ms);
  };
  arm(cfg.firstByteMs, "first byte");
  let res: Response;
  try {
    res = await f(cfg.url, {
      method: "POST",
      headers: { ...headers(cfg), accept: "text/event-stream" },
      signal: ctl.signal,
      body: JSON.stringify({
        model: cfg.model,
        messages,
        max_tokens: opts.maxTokens ?? cfg.maxTokens,
        temperature: opts.temperature ?? cfg.temperature,
        stream: true,
      }),
    });
  } catch (e) {
    if (timer) clearTimeout(timer);
    yield { type: "error", error: `llm connect failed (${why} deadline ${cfg.firstByteMs}ms): ${(e as Error).message}` };
    return;
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    if (timer) clearTimeout(timer);
    yield { type: "error", error: `llm ${res.status} from ${cfg.url}: ${text.slice(0, 500)}` };
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let finish: string | null = null;
  let usage: CompletionResult["usage"] | undefined;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      arm(cfg.inactivityMs, "inactivity");
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let obj: { choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>; usage?: CompletionResult["usage"] };
        try {
          obj = JSON.parse(data);
        } catch {
          yield { type: "error", error: `llm stream: unparseable SSE data line: ${data.slice(0, 200)}` };
          continue;
        }
        const ch = obj.choices?.[0];
        if (ch?.delta?.content) yield { type: "delta", text: ch.delta.content };
        if (ch?.finish_reason) finish = ch.finish_reason;
        if (obj.usage) usage = obj.usage;
      }
    }
    yield { type: "done", finish_reason: finish, usage };
  } catch (e) {
    yield { type: "error", error: `llm stream aborted (${why} deadline): ${(e as Error).message}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
