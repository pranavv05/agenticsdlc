import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Bedrock model/inference-profile id from SDD_MODEL (CLAUDE_MODEL for the direct API). */
function modelId(): string {
  return process.env.SDD_MODEL || process.env.CLAUDE_MODEL || (process.env.LLM_PROVIDER === "bedrock" ? "" : "claude-sonnet-5-5");
}

async function completeBedrock(system: string, prompt: string, maxTokens: number): Promise<string> {
  const key = process.env.BEDROCK_API_KEY || process.env.AWS_BEARER_TOKEN_BEDROCK;
  const region = process.env.AWS_REGION;
  const model = modelId();
  if (!key) throw new Error("BEDROCK_API_KEY is not set");
  if (!region) throw new Error("AWS_REGION is not set");
  if (!model) throw new Error("SDD_MODEL (Bedrock model or inference-profile id) is not set");

  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/invoke`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (res.ok) {
      const json = (await res.json()) as { content: { type: string; text?: string }[] };
      return json.content.map((b) => (b.type === "text" ? b.text ?? "" : "")).join("").trim();
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 5) throw new Error(`Bedrock invoke failed (${model}): ${res.status} ${await res.text()}`);
    await sleep(Math.min(20_000, 1000 * 2 ** attempt));
  }
}

async function completeAnthropic(system: string, prompt: string, maxTokens: number): Promise<string> {
  client ??= new Anthropic(); // reads ANTHROPIC_API_KEY
  const res = await client.messages.create({
    model: modelId(),
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  return res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
}

/** LLM call routed by LLM_PROVIDER ("bedrock", otherwise direct Anthropic API). */
export async function complete(system: string, prompt: string, maxTokens = 4000): Promise<string> {
  return process.env.LLM_PROVIDER === "bedrock" ? completeBedrock(system, prompt, maxTokens) : completeAnthropic(system, prompt, maxTokens);
}

/** Run `fn` over items with bounded concurrency, preserving order. */
export async function pMap<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}
