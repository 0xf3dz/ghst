import { ollamaAnswer, customAnswer } from "./connections.js";
import { ANSWER_MODELS } from "./openai.js";
import { HttpError } from "./store.js";

function checkCancellation(signal) {
  if (signal.aborted)
    throw new HttpError(499, "The answer request was cancelled.");
}

export function answerClient(settings, createClient) {
  const client = createClient();
  if (!ANSWER_MODELS.has(settings.answerModel))
    throw new HttpError(400, "Choose a supported answer model in Settings.");
  return client;
}

export async function* answerEvents({
  settings,
  messages,
  agentRuntime,
  sessionId,
  question,
  signal,
  createClient,
  client,
}) {
  checkCancellation(signal);
  if (["ollama", "custom"].includes(settings.answerProvider)) {
    const generate = settings.answerProvider === "ollama" ? ollamaAnswer : customAnswer;
    for await (const text of generate({ settings, messages, signal })) yield { type: "delta", text };
    return;
  }
  if (["chatgpt", "claude", "gemini", "groq"].includes(settings.answerProvider)) {
    if (!agentRuntime || typeof agentRuntime.answer !== "function")
      throw new HttpError(503, "The agent runtime is unavailable. Restart the app and try again.");
    for await (const event of agentRuntime.answer({
      sessionId,
      settings,
      messages,
      question,
      signal,
    })) {
      checkCancellation(signal);
      yield event;
    }
    checkCancellation(signal);
    return;
  }
  checkCancellation(signal);
  client ||= answerClient(settings, createClient);
  const completion = await client.chat.completions.create(
    {
      model: settings.answerModel,
      messages,
      stream: true,
      max_completion_tokens: 4000,
    },
    { signal },
  );
  let finishReason;
  let hasText = false;
  for await (const chunk of completion) {
    checkCancellation(signal);
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta?.content || choice?.delta?.refusal || "";
    if (!delta) continue;
    hasText ||= Boolean(delta.trim());
    yield { type: "delta", text: delta };
  }
  checkCancellation(signal);
  if (!hasText)
    throw new HttpError(
      502,
      "OpenAI returned no answer text. Try a more specific question.",
    );
  if (!finishReason)
    throw new HttpError(502, "The answer stream ended unexpectedly. Try again.");
  if (finishReason === "length")
    yield {
      type: "delta",
      text: "\n\n[The model reached its response limit. Ask a narrower follow-up for the remaining detail.]",
    };
}
