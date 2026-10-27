import { ANSWER_MODELS } from "./openai.js";
import { HttpError } from "./store.js";

function checkCancellation(signal) {
  if (signal.aborted)
    throw new HttpError(499, "The answer request was cancelled.");
}

function cancelled(error) {
  return (
    error?.status === 499 ||
    error?.name === "AbortError" ||
    error?.name === "APIUserAbortError"
  );
}

export function answerClient(settings, createClient) {
  const client = createClient();
  if (!ANSWER_MODELS.has(settings.answerModel))
    throw new HttpError(400, "Choose a supported answer model in Settings.");
  return client;
}

// Only provider iteration belongs inside the fallback boundary. The caller owns
// response writes, response-size limits, and persistence; those must never retry.
export async function* answerEvents({
  settings,
  messages,
  subscription,
  signal,
  createClient,
  client,
}) {
  checkCancellation(signal);
  if (settings.answerProvider === "chatgpt") {
    let partial = false;
    let hasText = false;
    let reason;
    try {
      for await (const delta of subscription.answer({
        messages,
        model: settings.subscriptionModel,
        signal,
      })) {
        checkCancellation(signal);
        if (!delta) continue;
        partial = true;
        hasText ||= Boolean(delta.trim());
        yield { type: "delta", text: delta };
      }
      checkCancellation(signal);
      if (!hasText)
        throw new HttpError(
          502,
          "ChatGPT returned no answer text. Try a more specific question.",
        );
      return;
    } catch (error) {
      checkCancellation(signal);
      if (
        cancelled(error) ||
        !(error instanceof HttpError) ||
        error.status === 500
      )
        throw error;
      reason = error.message;
    }
    checkCancellation(signal);
    client = answerClient(settings, createClient);
    if (partial) yield { type: "reset", reason };
    checkCancellation(signal);
    yield { type: "fallback", provider: "openai", reason };
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
