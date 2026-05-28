// Anthropic Messages API (streaming) over fetch — no SDK dep, same lean approach as embeddings.ts.
// Powers /search/ask RAG Q&A. Yields text deltas as they arrive so the route can relay SSE tokens.
import { env } from "./env.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export function llmEnabled(): boolean {
  return !!env.ANTHROPIC_API_KEY;
}

/**
 * Stream a completion. Yields incremental text chunks (text_delta) until the message ends.
 * Throws if the LLM isn't configured or the API returns a non-2xx.
 */
export async function* streamText(args: {
  system: string;
  prompt: string;
  maxTokens?: number;
  signal?: AbortSignal;
}): AsyncGenerator<string> {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL,
      max_tokens: args.maxTokens ?? env.ANTHROPIC_MAX_TOKENS,
      system: args.system,
      messages: [{ role: "user", content: args.prompt }],
      stream: true,
    }),
    signal: args.signal,
  });
  if (!res.ok || !res.body) throw new Error(`Anthropic error ${res.status}: ${await res.text().catch(() => "")}`);

  // Parse the SSE stream: events are separated by blank lines; we only care about
  // content_block_delta → delta.text_delta. message_stop / errors end the stream.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    // process complete lines; SSE data lines start with "data: "
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let evt: any;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }
      if (evt?.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
        yield evt.delta.text as string;
      } else if (evt?.type === "error") {
        throw new Error(`Anthropic stream error: ${evt.error?.message ?? "unknown"}`);
      }
    }
  }
}
