import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_GROQ_MODEL,
  DEFAULT_GROQ_MODELS,
  GROQ_ENDPOINT,
  MAX_MERMAID_LENGTH,
  MAX_PROMPT_LENGTH,
  OPENROUTER_ENDPOINT,
  OPENROUTER_MODEL,
  OpenRouterError,
  createGenerationRateLimiter,
  extractMermaid,
  generateMermaidWithFallback,
  generateMermaidWithGroq,
  generateMermaidWithGroqChain,
  generateMermaidWithOpenRouter,
  resolveGroqModels,
  validateGroqModel,
  validatePrompt,
} from "./openrouter.mjs";

const validContent = "flowchart TD\n  A --> B";
const jsonResponse = (payload, status = 200, headers = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
const successResponse = (content = validContent) =>
  jsonResponse({ choices: [{ message: { content } }] });

test("sends bounded provider-specific chat completion requests", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return successResponse();
  };

  await generateMermaidWithOpenRouter({
    prompt: "  A request and approval flow  ",
    apiKey: "openrouter-test-key",
    fetchImpl,
  });
  await generateMermaidWithGroq({
    prompt: "A request and approval flow",
    apiKey: "groq-test-key",
    fetchImpl,
  });

  assert.equal(requests[0].url, OPENROUTER_ENDPOINT);
  assert.equal(requests[0].options.headers.Authorization, "Bearer openrouter-test-key");
  const openRouterBody = JSON.parse(requests[0].options.body);
  assert.equal(openRouterBody.model, OPENROUTER_MODEL);
  assert.ok(openRouterBody.max_tokens > 0 && openRouterBody.max_tokens <= 2000);
  assert.equal(openRouterBody.max_completion_tokens, undefined);
  assert.equal(openRouterBody.messages[1].content, "A request and approval flow");
  assert.match(openRouterBody.messages[0].content, /prose outside the diagram/i);

  assert.equal(requests[1].url, GROQ_ENDPOINT);
  assert.equal(requests[1].options.headers.Authorization, "Bearer groq-test-key");
  const groqBody = JSON.parse(requests[1].options.body);
  assert.equal(groqBody.model, DEFAULT_GROQ_MODEL);
  assert.ok(groqBody.max_completion_tokens > 0);
  assert.equal(groqBody.max_tokens, undefined);
});

test("validates conservative Groq model overrides", () => {
  assert.equal(DEFAULT_GROQ_MODEL, "openai/gpt-oss-20b");
  assert.equal(validateGroqModel(undefined), DEFAULT_GROQ_MODEL);
  assert.equal(validateGroqModel("vendor/model-v2"), "vendor/model-v2");
  assert.throws(() => validateGroqModel("model with spaces"), { status: 503 });
  assert.throws(() => validateGroqModel("../bad model"), { status: 503 });
});

test("resolves default, preferred, and ordered Groq model chains", () => {
  assert.deepEqual(resolveGroqModels(), DEFAULT_GROQ_MODELS);
  assert.deepEqual(resolveGroqModels({ model: "custom/model-v1" }), [
    "custom/model-v1",
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
    "qwen/qwen3.6-27b",
  ]);
  assert.deepEqual(
    resolveGroqModels({
      model: "ignored/model",
      models:
        "qwen/qwen3.8-27b, openai/gpt-oss-20b, qwen/qwen3.8-27b, openai/gpt-oss-120b, custom/fourth",
    }),
    [
      "qwen/qwen3.8-27b",
      "openai/gpt-oss-20b",
      "openai/gpt-oss-120b",
      "custom/fourth",
    ],
  );
});

test("invalid Groq chain configuration fails before any provider call", async () => {
  for (const groqModels of ["valid/model,,other/model", "a,b,c,d,bad model"]) {
    let callCount = 0;
    await assert.rejects(
      generateMermaidWithFallback({
        prompt: "A flow",
        openRouterApiKey: "primary-key",
        groqApiKey: "fallback-key",
        groqModels,
        fetchImpl: async () => {
          callCount += 1;
          return successResponse();
        },
      }),
      { status: 503 },
    );
    assert.equal(callCount, 0);
  }
});

test("primary success does not call Groq and reports provider metadata", async () => {
  const urls = [];
  const result = await generateMermaidWithFallback({
    prompt: "A flow",
    openRouterApiKey: "primary-key",
    groqApiKey: "fallback-key",
    fetchImpl: async (url) => {
      urls.push(url);
      return successResponse();
    },
  });

  assert.deepEqual(urls, [OPENROUTER_ENDPOINT]);
  assert.deepEqual(result, {
    mermaid: validContent,
    provider: "openrouter",
    model: OPENROUTER_MODEL,
  });
});

test("retryable OpenRouter failure calls Groq once and reports fallback metadata", async () => {
  const urls = [];
  const result = await generateMermaidWithFallback({
    prompt: "A flow",
    openRouterApiKey: "primary-key",
    groqApiKey: "fallback-key",
    groqModel: "custom/model-v1",
    fetchImpl: async (url, options) => {
      urls.push(url);
      if (url === OPENROUTER_ENDPOINT) {
        return jsonResponse({ error: "private primary failure" }, 429);
      }
      assert.equal(JSON.parse(options.body).model, "custom/model-v1");
      return successResponse();
    },
  });

  assert.deepEqual(urls, [OPENROUTER_ENDPOINT, GROQ_ENDPOINT]);
  assert.deepEqual(result, {
    mermaid: validContent,
    provider: "groq",
    model: "custom/model-v1",
  });
});

test("Groq chain continues in order and succeeds on a later model", async () => {
  const attemptedModels = [];
  const result = await generateMermaidWithFallback({
    prompt: "A flow",
    openRouterApiKey: "",
    groqApiKey: "fallback-key",
    fetchImpl: async (_url, options) => {
      const model = JSON.parse(options.body).model;
      attemptedModels.push(model);
      if (attemptedModels.length === 1) {
        return jsonResponse({ error: "model unavailable" }, 404);
      }
      if (attemptedModels.length === 2) {
        return jsonResponse({ error: "model deprecated" }, 400);
      }
      if (attemptedModels.length === 3) {
        return successResponse("not Mermaid");
      }
      return successResponse();
    },
  });

  assert.deepEqual(attemptedModels, DEFAULT_GROQ_MODELS);
  assert.equal(result.provider, "groq");
  assert.equal(result.model, "qwen/qwen3.8-27b");
});

test("Groq chain stops immediately on credential rejection", async () => {
  let callCount = 0;
  await assert.rejects(
    generateMermaidWithGroqChain({
      prompt: "A flow",
      apiKey: "rejected-key",
      models: DEFAULT_GROQ_MODELS.join(","),
      fetchImpl: async () => {
        callCount += 1;
        return jsonResponse({ error: "private credential detail" }, 401);
      },
    }),
    (error) => error.status === 503 && error.reason === "credential",
  );
  assert.equal(callCount, 1);
});

test("Groq chain enforces its total deadline", async () => {
  let currentTime = 0;
  let callCount = 0;
  await assert.rejects(
    generateMermaidWithGroqChain({
      prompt: "A flow",
      apiKey: "fallback-key",
      models: DEFAULT_GROQ_MODELS.join(","),
      chainTimeoutMs: 100,
      now: () => currentTime,
      fetchImpl: async () => {
        callCount += 1;
        currentTime = 101;
        return jsonResponse({ error: "transient" }, 502);
      },
    }),
    { status: 504 },
  );
  assert.equal(callCount, 1);
});

test("unconfigured OpenRouter falls back without making a primary request", async () => {
  const urls = [];
  const result = await generateMermaidWithFallback({
    prompt: "A flow",
    openRouterApiKey: "",
    groqApiKey: "fallback-key",
    fetchImpl: async (url) => {
      urls.push(url);
      return successResponse();
    },
  });

  assert.deepEqual(urls, [GROQ_ENDPOINT]);
  assert.equal(result.provider, "groq");
});

test("invalid prompt never calls either provider", async () => {
  let callCount = 0;
  await assert.rejects(
    generateMermaidWithFallback({
      prompt: " ",
      openRouterApiKey: "primary-key",
      groqApiKey: "fallback-key",
      fetchImpl: async () => {
        callCount += 1;
        return successResponse();
      },
    }),
    { status: 400 },
  );
  assert.equal(callCount, 0);
});

test("absent Groq key preserves the safe primary error", async () => {
  await assert.rejects(
    generateMermaidWithFallback({
      prompt: "A flow",
      openRouterApiKey: "primary-key",
      groqApiKey: "",
      fetchImpl: async () => jsonResponse({ error: "private detail" }, 429),
    }),
    (error) =>
      error.status === 429 &&
      error.message === "The AI service is busy. Try again shortly.",
  );
});

test("rejects malformed Groq output after primary failure", async () => {
  await assert.rejects(
    generateMermaidWithFallback({
      prompt: "A flow",
      openRouterApiKey: "",
      groqApiKey: "fallback-key",
      fetchImpl: async () => successResponse("This is not Mermaid."),
    }),
    { status: 502 },
  );
});

test("both-provider failure returns one safe error", async () => {
  const attemptedModels = [];
  await assert.rejects(
    generateMermaidWithFallback({
      prompt: "A flow",
      openRouterApiKey: "primary-key",
      groqApiKey: "fallback-key",
      fetchImpl: async (url, options) => {
        if (url === GROQ_ENDPOINT) {
          attemptedModels.push(JSON.parse(options.body).model);
        }
        return jsonResponse(
          { error: url === OPENROUTER_ENDPOINT ? "primary-secret" : "fallback-secret" },
          502,
        );
      },
    }),
    (error) =>
      error instanceof OpenRouterError &&
      error.status === 502 &&
      !/primary-secret|fallback-secret|openrouter|groq/i.test(error.message),
  );
  assert.deepEqual(attemptedModels, DEFAULT_GROQ_MODELS);
});

test("timeout aborts a provider request and can fall back", async () => {
  let primaryAborted = false;
  const result = await generateMermaidWithFallback({
    prompt: "A flow",
    openRouterApiKey: "primary-key",
    groqApiKey: "fallback-key",
    timeoutMs: 5,
    fetchImpl: (url, { signal }) => {
      if (url === GROQ_ENDPOINT) {
        return Promise.resolve(successResponse());
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          primaryAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    },
  });

  assert.equal(primaryAborted, true);
  assert.equal(result.provider, "groq");
});

test("preserves timeout semantics when both providers time out", async () => {
  await assert.rejects(
    generateMermaidWithFallback({
      prompt: "A flow",
      openRouterApiKey: "primary-key",
      groqApiKey: "fallback-key",
      timeoutMs: 5,
      groqAttemptTimeoutMs: 5,
      groqChainTimeoutMs: 30,
      fetchImpl: (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    }),
    { status: 504 },
  );
});

test("extracts valid Mermaid and rejects invalid local input and output", () => {
  assert.equal(
    extractMermaid("Here is it:\n```mermaid\nflowchart LR\n A --> B\n```"),
    "flowchart LR\n A --> B",
  );
  assert.throws(() => validatePrompt(42), { status: 400 });
  assert.throws(() => validatePrompt("x".repeat(MAX_PROMPT_LENGTH + 1)), {
    status: 400,
  });
  assert.throws(() => extractMermaid("flowchart TD"), { status: 502 });
  assert.throws(
    () => extractMermaid(`flowchart TD\n${"A".repeat(MAX_MERMAID_LENGTH)}`),
    { status: 502 },
  );
});

test("rate limiter counts one user request independently of provider attempts", async () => {
  let time = 0;
  const rateLimit = createGenerationRateLimiter({
    maxRequests: 2,
    windowMs: 1000,
    now: () => time,
  });

  assert.equal(rateLimit("user-1"), 0);
  const attemptedModels = [];
  await generateMermaidWithFallback({
    prompt: "A flow",
    openRouterApiKey: "",
    groqApiKey: "fallback-key",
    fetchImpl: async (_url, options) => {
      attemptedModels.push(JSON.parse(options.body).model);
      return attemptedModels.length === 4
        ? successResponse()
        : jsonResponse({ error: "unavailable" }, 404);
    },
  });
  assert.deepEqual(attemptedModels, DEFAULT_GROQ_MODELS);
  assert.equal(rateLimit("user-1"), 0);
  assert.equal(rateLimit("user-2"), 0);
  assert.equal(rateLimit("user-1"), 1);
  time = 1001;
  assert.equal(rateLimit("user-1"), 0);
});
