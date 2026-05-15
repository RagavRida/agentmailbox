/**
 * LLM wrapper used by both researcher and writer. Calls Anthropic if
 * ANTHROPIC_API_KEY is set; otherwise falls back to a clearly-labeled
 * stub so the demo runs offline / in CI without an API key.
 */

const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";

if (!HAS_KEY) {
  process.stderr.write(
    "[demo] ANTHROPIC_API_KEY unset — using stub responses\n"
  );
}

export interface LlmReply {
  text: string;
  stub: boolean;
}

export async function complete(system: string, prompt: string): Promise<LlmReply> {
  if (!HAS_KEY) {
    return { text: stubReply(system, prompt), stub: true };
  }
  // Lazy-load so the dependency is only required when actually used.
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic();
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  const parts = resp.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("");
  return { text: parts.trim(), stub: false };
}

function stubReply(system: string, prompt: string): string {
  const role = system.toLowerCase().includes("research") ? "researcher" : "writer";
  if (role === "researcher") {
    return [
      "[STUB] Found 3 papers on the topic:",
      "  - Ho et al. 2020 — Denoising Diffusion Probabilistic Models",
      "  - Song et al. 2021 — Score-Based Generative Modeling",
      "  - Karras et al. 2022 — Elucidating the Design Space of Diffusion Models",
      `(stubbed because ANTHROPIC_API_KEY is unset; prompt was: ${prompt.slice(0, 80)}...)`,
    ].join("\n");
  }
  return [
    "[STUB] Draft summary:",
    "Diffusion models generate samples by reversing a gradual noising",
    "process. They've replaced GANs as the dominant approach to image",
    "synthesis because they are easier to train and scale.",
    `(stubbed because ANTHROPIC_API_KEY is unset; prompt was: ${prompt.slice(0, 80)}...)`,
  ].join("\n");
}
