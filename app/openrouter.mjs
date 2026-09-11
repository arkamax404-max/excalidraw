export const OPENROUTER_ENDPOINT =
  "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_MODEL = "openrouter/free";
export const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b";
export const DEFAULT_GROQ_MODELS = Object.freeze([
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "qwen/qwen3.6-27b",
  "qwen/qwen3.8-27b",
]);
export const MAX_PROMPT_LENGTH = 4000;
export const MAX_MERMAID_LENGTH = 20000;
export const PROVIDER_TIMEOUT_MS = 20000;
export const GROQ_ATTEMPT_TIMEOUT_MS = 12000;
export const GROQ_CHAIN_TIMEOUT_MS = 30000;

const MAX_PROVIDER_RESPONSE_LENGTH = 100000;
const MAX_OUTPUT_TOKENS = 1800;
const GROQ_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const SYSTEM_PROMPT = `Create exactly one syntactically valid Mermaid flowchart from the user's request.
The result will be converted to Excalidraw, so use only broadly supported flowchart syntax.
Start with "flowchart TD" (or another explicit flowchart direction), use concise node labels, stable alphanumeric node IDs, and explicit edges.
Do not use HTML, click directives, scripts, external links, initialization directives, comments, Markdown fences, explanations, or any prose outside the diagram.`;

export class OpenRouterError extends Error {
  constructor(status, message, reason = "provider") {
    super(message);
    this.name = "DiagramGenerationError";
    this.status = status;
    this.reason = reason;
  }
}

export function validatePrompt(prompt) {
  if (typeof prompt !== "string") {
    throw new OpenRouterError(400, "The prompt must be text.", "local_validation");
  }

  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    throw new OpenRouterError(400, "Enter a diagram description.", "local_validation");
  }
  if (normalizedPrompt.length > MAX_PROMPT_LENGTH) {
    throw new OpenRouterError(
      400,
      `The prompt must be ${MAX_PROMPT_LENGTH} characters or fewer.`,
      "local_validation",
    );
  }

  return normalizedPrompt;
}

export function validateGroqModel(model) {
  const selectedModel = String(model || DEFAULT_GROQ_MODEL).trim();
  if (!GROQ_MODEL_PATTERN.test(selectedModel)) {
    throw new OpenRouterError(
      503,
      "The fallback AI model configuration is invalid.",
      "configuration",
    );
  }
  return selectedModel;
}

export function resolveGroqModels({ model, models } = {}) {
  if (models != null && typeof models !== "string") {
    throw new OpenRouterError(
      503,
      "The fallback AI model configuration is invalid.",
      "configuration",
    );
  }

  const configuredModels = typeof models === "string" ? models.trim() : "";
  let candidates;

  if (configuredModels) {
    candidates = configuredModels.split(",").map((candidate) => candidate.trim());
    if (candidates.some((candidate) => !candidate)) {
      throw new OpenRouterError(
        503,
        "The fallback AI model configuration is invalid.",
        "configuration",
      );
    }
  } else {
    const preferredModel = typeof model === "string" ? model.trim() : model;
    candidates = preferredModel
      ? [preferredModel, ...DEFAULT_GROQ_MODELS]
      : [...DEFAULT_GROQ_MODELS];
  }

  const validatedModels = candidates.map(validateGroqModel);
  return [...new Set(validatedModels)].slice(0, 4);
}

export function extractMermaid(content) {
  if (typeof content !== "string") {
    throw new OpenRouterError(
      502,
      "The AI provider returned an invalid response.",
      "malformed_response",
    );
  }

  const fencedBlocks = [...content.matchAll(/```(?:mermaid)?\s*\r?\n([\s\S]*?)```/gi)];
  const mermaid = (fencedBlocks[0]?.[1] ?? content).trim();

  if (!mermaid) {
    throw new OpenRouterError(502, "The AI provider returned an empty diagram.", "malformed_response");
  }
  if (mermaid.length > MAX_MERMAID_LENGTH) {
    throw new OpenRouterError(
      502,
      "The generated diagram is too large to import safely.",
      "malformed_response",
    );
  }
  if (mermaid.includes("```") || mermaid.includes("\0")) {
    throw new OpenRouterError(502, "The AI provider returned a malformed diagram.", "malformed_response");
  }

  const lines = mermaid.split(/\r?\n/).map((line) => line.trim());
  if (!/^flowchart\s+(TB|TD|BT|RL|LR)\b/i.test(lines[0] ?? "")) {
    throw new OpenRouterError(
      502,
      "The AI provider did not return a Mermaid flowchart.",
      "malformed_response",
    );
  }
  if (lines.length < 2 || lines.slice(1).every((line) => !line)) {
    throw new OpenRouterError(
      502,
      "The generated Mermaid flowchart is incomplete.",
      "malformed_response",
    );
  }

  return mermaid;
}

function mapProviderError(status) {
  if (status === 429) {
    return new OpenRouterError(429, "The AI service is busy. Try again shortly.", "rate_limit");
  }
  if (status === 401 || status === 403) {
    return new OpenRouterError(
      503,
      "AI generation is unavailable because the server credential was rejected.",
      "credential",
    );
  }
  if (status === 402) {
    return new OpenRouterError(
      503,
      "AI generation is temporarily unavailable because the provider quota was reached.",
      "quota",
    );
  }
  if (status === 400) {
    return new OpenRouterError(502, "The AI provider could not process this request.", "provider_request");
  }

  return new OpenRouterError(502, "The AI provider is temporarily unavailable.", "transient");
}

async function requestMermaidCompletion({
  prompt,
  apiKey,
  endpoint,
  model,
  tokenField,
  fetchImpl,
  timeoutMs,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let providerResponse;
    try {
      providerResponse = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          [tokenField]: MAX_OUTPUT_TOKENS,
          temperature: 0.2,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") {
        throw new OpenRouterError(504, "AI generation timed out. Try again.", "timeout");
      }
      throw new OpenRouterError(502, "The AI provider could not be reached.", "transient");
    }

    if (!providerResponse.ok) {
      throw mapProviderError(providerResponse.status);
    }

    const declaredLength = Number(providerResponse.headers.get("content-length") || 0);
    if (declaredLength > MAX_PROVIDER_RESPONSE_LENGTH) {
      throw new OpenRouterError(502, "The AI provider response was too large.", "malformed_response");
    }

    const responseText = await providerResponse.text();
    if (responseText.length > MAX_PROVIDER_RESPONSE_LENGTH) {
      throw new OpenRouterError(502, "The AI provider response was too large.", "malformed_response");
    }

    let payload;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new OpenRouterError(502, "The AI provider returned an invalid response.", "malformed_response");
    }

    return extractMermaid(payload?.choices?.[0]?.message?.content);
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateMermaidWithOpenRouter({
  prompt,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = PROVIDER_TIMEOUT_MS,
}) {
  const normalizedPrompt = validatePrompt(prompt);
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new OpenRouterError(503, "AI generation is not configured on this server.", "configuration");
  }

  return requestMermaidCompletion({
    prompt: normalizedPrompt,
    apiKey,
    endpoint: OPENROUTER_ENDPOINT,
    model: OPENROUTER_MODEL,
    tokenField: "max_tokens",
    fetchImpl,
    timeoutMs,
  });
}

export async function generateMermaidWithGroq({
  prompt,
  apiKey,
  model,
  fetchImpl = fetch,
  timeoutMs = PROVIDER_TIMEOUT_MS,
}) {
  const normalizedPrompt = validatePrompt(prompt);
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new OpenRouterError(503, "Fallback AI generation is not configured.", "configuration");
  }

  return requestMermaidCompletion({
    prompt: normalizedPrompt,
    apiKey,
    endpoint: GROQ_ENDPOINT,
    model: validateGroqModel(model),
    tokenField: "max_completion_tokens",
    fetchImpl,
    timeoutMs,
  });
}

function summarizeGroqErrors(errors) {
  if (errors.some((error) => error.status === 429)) {
    return new OpenRouterError(429, "AI generation is busy. Try again shortly.", "rate_limit");
  }
  if (errors.some((error) => error.status === 504)) {
    return new OpenRouterError(504, "AI generation timed out. Try again.", "timeout");
  }

  return new OpenRouterError(
    502,
    "AI generation is temporarily unavailable. Try again later.",
    "exhausted",
  );
}

export async function generateMermaidWithGroqChain({
  prompt,
  apiKey,
  models,
  fetchImpl = fetch,
  attemptTimeoutMs = GROQ_ATTEMPT_TIMEOUT_MS,
  chainTimeoutMs = GROQ_CHAIN_TIMEOUT_MS,
  now = Date.now,
}) {
  const normalizedPrompt = validatePrompt(prompt);
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new OpenRouterError(503, "Fallback AI generation is not configured.", "configuration");
  }

  const modelChain = resolveGroqModels({ models });
  const deadline = now() + chainTimeoutMs;
  const errors = [];

  for (const model of modelChain) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      errors.push(new OpenRouterError(504, "AI generation timed out. Try again.", "timeout"));
      break;
    }

    try {
      const mermaid = await generateMermaidWithGroq({
        prompt: normalizedPrompt,
        apiKey,
        model,
        fetchImpl,
        timeoutMs: Math.max(1, Math.min(attemptTimeoutMs, remainingMs)),
      });
      return { mermaid, provider: "groq", model };
    } catch (error) {
      if (!(error instanceof OpenRouterError)) {
        errors.push(
          new OpenRouterError(502, "AI generation failed unexpectedly.", "transient"),
        );
        continue;
      }
      if (error.reason === "credential") {
        throw error;
      }
      errors.push(error);
    }
  }

  throw summarizeGroqErrors(errors);
}

function combineProviderErrors(primaryError, fallbackError) {
  if (primaryError.status === 429 || fallbackError.status === 429) {
    return new OpenRouterError(429, "AI generation is busy. Try again shortly.");
  }
  if (primaryError.status === 504 || fallbackError.status === 504) {
    return new OpenRouterError(504, "AI generation timed out. Try again.");
  }
  if (primaryError.status === 503 && fallbackError.status === 503) {
    return new OpenRouterError(503, "AI generation is not configured or available.");
  }

  return new OpenRouterError(502, "AI generation is temporarily unavailable. Try again later.");
}

export async function generateMermaidWithFallback({
  prompt,
  openRouterApiKey,
  groqApiKey,
  groqModel,
  groqModels,
  fetchImpl = fetch,
  timeoutMs = PROVIDER_TIMEOUT_MS,
  groqAttemptTimeoutMs = GROQ_ATTEMPT_TIMEOUT_MS,
  groqChainTimeoutMs = GROQ_CHAIN_TIMEOUT_MS,
  now = Date.now,
}) {
  const normalizedPrompt = validatePrompt(prompt);
  const modelChain = resolveGroqModels({ model: groqModel, models: groqModels });
  let primaryError;

  try {
    const mermaid = await generateMermaidWithOpenRouter({
      prompt: normalizedPrompt,
      apiKey: openRouterApiKey,
      fetchImpl,
      timeoutMs,
    });
    return { mermaid, provider: "openrouter", model: OPENROUTER_MODEL };
  } catch (error) {
    if (!(error instanceof OpenRouterError) || error.status === 400) {
      throw error;
    }
    primaryError = error;
  }

  if (typeof groqApiKey !== "string" || !groqApiKey.trim()) {
    throw primaryError;
  }

  try {
    return await generateMermaidWithGroqChain({
      prompt: normalizedPrompt,
      apiKey: groqApiKey,
      models: modelChain.join(","),
      fetchImpl,
      attemptTimeoutMs: groqAttemptTimeoutMs,
      chainTimeoutMs: groqChainTimeoutMs,
      now,
    });
  } catch (error) {
    if (!(error instanceof OpenRouterError)) {
      throw new OpenRouterError(502, "AI generation failed unexpectedly.");
    }
    throw combineProviderErrors(primaryError, error);
  }
}

export function createGenerationRateLimiter({
  maxRequests = 5,
  windowMs = 60000,
  now = Date.now,
} = {}) {
  const requestsByKey = new Map();

  return (key) => {
    const currentTime = now();
    const recentRequests = (requestsByKey.get(key) ?? []).filter(
      (timestamp) => currentTime - timestamp < windowMs,
    );

    if (recentRequests.length >= maxRequests) {
      return Math.max(1, Math.ceil((windowMs - (currentTime - recentRequests[0])) / 1000));
    }

    recentRequests.push(currentTime);
    requestsByKey.set(key, recentRequests);
    return 0;
  };
}
