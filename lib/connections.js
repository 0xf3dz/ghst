import { readFile } from "node:fs/promises";
import { ANSWER_MODELS, validateWav } from "./openai.js";
import { REALTIME_MODELS } from "./realtime.js";
import { HttpError } from "./store.js";
import { subscriptionProvider } from "./subscription.js";

export const ANSWER_PROVIDERS = new Set(["chatgpt", "claude", "gemini", "groq", "openai", "ollama", "custom"]);
export const OLLAMA_URL = "http://127.0.0.1:11434";
export const TRANSCRIBE_URL = "http://127.0.0.1:8080";
const MAX_BYTES = 8 * 1024 * 1024;
const modelId = (value) => typeof value === "string" && value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);
const invalid = (message) => new HttpError(400, message);
const failed = (message) => new HttpError(502, message);

function serviceUrl(value) {
  if (typeof value !== "string" || value.length > 2048) throw invalid("Enter an HTTP service URL.");
  let url;
  try { url = new URL(value); } catch { throw invalid("Enter an HTTP service URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw invalid("Use an HTTP or HTTPS URL without embedded credentials or fragments.");
  return url.href.replace(/\/$/, "");
}

export function validateConnectionSettings(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("Settings must be an object.");
  const result = {};
  if (body.answerProvider !== undefined) {
    if (!ANSWER_PROVIDERS.has(body.answerProvider)) throw invalid("Choose a supported answer provider.");
    result.answerProvider = body.answerProvider;
  }
  if (body.subscriptionModel !== undefined) {
    const provider = subscriptionProvider(body.subscriptionModel);
    const expected = { chatgpt: "openai-codex", claude: "anthropic", gemini: "google-gemini-cli", groq: "groq" }[body.answerProvider];
    if (expected && provider !== expected) throw invalid("Choose an exact model for the selected omp provider.");
    result.subscriptionModel = body.subscriptionModel;
  }
  if (body.answerModel !== undefined) {
    const local = body.answerModel?.startsWith?.("ollama:");
    if (!modelId(body.answerModel) || (local && !modelId(body.answerModel.slice(7))) ||
        (!["ollama", "custom"].includes(body.answerProvider) && !local && !ANSWER_MODELS.has(body.answerModel)) ||
        (body.answerProvider === "openai" && local))
      throw invalid("Choose a supported answer model, or ollama:model for local fallback.");
    result.answerModel = body.answerModel;
  }
  for (const key of ["ollamaUrl", "transcribeUrl"])
    if (body[key] !== undefined) result[key] = serviceUrl(body[key]);
  if (body.customCurl !== undefined) {
    if (typeof body.customCurl !== "string" || body.customCurl.length > 32768) throw invalid("The custom cURL template must be at most 32768 characters.");
    if (body.customCurl.trim()) parseCustomCurl(body.customCurl, { model: "validation-model", messages: [] });
    result.customCurl = body.customCurl;
  }
  if (body.transcribeProvider !== undefined) {
    if (!["openai", "local"].includes(body.transcribeProvider)) throw invalid("Choose openai or local transcription.");
    result.transcribeProvider = body.transcribeProvider;
  }
  if (body.transcribeModel !== undefined) {
    if (body.transcribeProvider === "local" ? !modelId(body.transcribeModel) : !REALTIME_MODELS.has(body.transcribeModel))
      throw invalid("Choose a supported transcription model.");
    result.transcribeModel = body.transcribeModel;
  }
  return result;
}

function checkSignal(signal) {
  if (signal?.aborted) throw new HttpError(499, "The request was cancelled.");
}

async function request(url, options, fetchImpl) {
  checkSignal(options.signal);
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000);
  try {
    const response = await fetchImpl(url, { ...options, signal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError([400, 401, 403, 404, 413, 422, 429].includes(response.status) ? response.status : 502,
        `The configured service rejected the request (HTTP ${response.status}). Check its credentials, model, and endpoint.`);
    }
    return response;
  } catch (error) {
    checkSignal(options.signal);
    if (signal.aborted) throw new HttpError(504, "The configured service request timed out.");
    if (error instanceof HttpError) throw error;
    throw failed("Could not reach the configured service. Check its URL and that the server is running.");
  }
}

async function* chunks(response, signal) {
  let bytes = 0;
  const decoder = new TextDecoder();
  try {
    if (!response.body) throw failed("The service returned no response body.");
    for await (const chunk of response.body) {
      checkSignal(signal);
      bytes += chunk.byteLength;
      if (bytes > MAX_BYTES) throw failed("The service returned too much data.");
      yield decoder.decode(chunk, { stream: true });
    }
    checkSignal(signal);
    yield decoder.decode();
  } catch (error) {
    checkSignal(signal);
    if (error instanceof HttpError) throw error;
    if (error.name === "TimeoutError") throw new HttpError(504, "The configured service request timed out.");
    throw failed("The service response was interrupted. Try again.");
  }
}

function json(text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    if (value.error) throw new Error();
    return value;
  } catch { throw failed("The service returned invalid JSON or an error response."); }
}

async function responseJson(response, signal) {
  let text = "";
  for await (const chunk of chunks(response, signal)) text += chunk;
  return json(text);
}

export async function localModels(settings, { fetchImpl = fetch, signal } = {}) {
  const response = await request(`${serviceUrl(settings.ollamaUrl || OLLAMA_URL)}/api/tags`, { signal }, fetchImpl);
  const data = await responseJson(response, signal);
  if (!Array.isArray(data.models) || data.models.some((row) => !modelId(row?.name))) throw failed("Ollama returned an invalid model catalog.");
  return [...new Set(data.models.map((row) => row.name))];
}

export async function localTranscribe({ settings, path, signal, fetchImpl = fetch }) {
  checkSignal(signal);
  await validateWav(path);
  checkSignal(signal);
  const form = new FormData();
  form.set("file", new Blob([await readFile(path)], { type: "audio/wav" }), "recording.wav");
  form.set("response_format", "json");
  if (settings.language) form.set("language", settings.language);
  // whisper.cpp loads its weights when the HTTP server starts, not per request.
  const response = await request(`${serviceUrl(settings.transcribeUrl || TRANSCRIBE_URL)}/inference`, { method: "POST", body: form, signal }, fetchImpl);
  const data = await responseJson(response, signal);
  if (typeof data.text !== "string") throw failed("The local service returned an invalid transcript.");
  return data.text.trim();
}

export async function* ollamaAnswer({ settings, messages, signal, fetchImpl = fetch }) {
  const model = settings.answerModel?.replace(/^ollama:/, "");
  if (!modelId(model)) throw invalid("Choose an Ollama model in Settings.");
  const response = await request(`${serviceUrl(settings.ollamaUrl || OLLAMA_URL)}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true }), signal,
  }, fetchImpl);
  let buffer = "";
  let done = false;
  let hasText = false;
  const parse = (line) => {
    const data = json(line);
    if (done || (data.message && (data.message.role !== "assistant" || typeof data.message.content !== "string" || data.message.tool_calls?.length)))
      throw failed("Ollama returned an invalid answer event.");
    if (typeof data.done !== "boolean" || (!data.message && !data.done)) throw failed("Ollama returned an invalid answer event.");
    done = data.done;
    const text = data.message?.content || "";
    hasText ||= Boolean(text.trim());
    return text;
  };
  for await (const chunk of chunks(response, signal)) {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) { const text = parse(line); if (text) yield text; }
    }
  }
  if (buffer.trim()) { const text = parse(buffer); if (text) yield text; }
  if (!done || !hasText) throw failed("Ollama returned an incomplete or empty answer.");
}

function curlTokens(source) {
  const tokens = [];
  let token = "";
  let quote = "";
  let active = false;
  if (/[`$\u0000]/.test(source)) throw invalid("Shell substitutions and variables are not supported in custom cURL.");
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "\\" && quote !== "'") {
      const next = source[++index];
      if (next === undefined) throw invalid("The cURL template has an unfinished escape.");
      if (next === "\n") continue;
      if (quote === '"' && !['"', "\\"].includes(next)) token += "\\";
      token += next; active = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else token += char;
    } else if (char === "'" || char === '"') { quote = char; active = true; }
    else if (/[;|&<>()\r\n]/.test(char)) throw invalid("Shell commands, redirects, and operators are not supported in custom cURL.");
    else if (/\s/.test(char)) {
      if (active) { tokens.push(token); token = ""; active = false; }
    } else { token += char; active = true; }
  }
  if (quote) throw invalid("The cURL template has an unclosed quote.");
  if (active) tokens.push(token);
  return tokens;
}

export function parseCustomCurl(source, { model, messages }) {
  if (typeof source !== "string" || source.length > 32768) throw invalid("Enter a bounded custom cURL template.");
  const tokens = curlTokens(source.trim());
  if (tokens.shift() !== "curl") throw invalid("The custom template must start with curl.");
  let url;
  let method = "POST";
  let body;
  const headers = new Headers();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (["-X", "--request", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--url"].includes(token)) {
      const value = tokens[++index];
      if (value === undefined) throw invalid("The cURL option is missing its value.");
      if (["-X", "--request"].includes(token)) method = value.toUpperCase();
      else if (["-H", "--header"].includes(token)) {
        const colon = value.indexOf(":");
        if (colon < 1 || /[\r\n]/.test(value)) throw invalid("Use literal HTTP headers, not files.");
        const name = value.slice(0, colon).trim();
        if (/^(host|content-length|connection|transfer-encoding|proxy-.*)$/i.test(name)) throw invalid("That custom HTTP header is not supported.");
        try { headers.append(name, value.slice(colon + 1).trim()); } catch { throw invalid("The custom HTTP header is invalid."); }
      } else if (token === "--url") {
        if (url) throw invalid("Use exactly one custom URL.");
        url = value;
      } else {
        if (body !== undefined || value.startsWith("@")) throw invalid("Use one inline JSON body, never a file reference.");
        body = value;
      }
    } else if (!token.startsWith("-") && !url) url = token;
    else throw invalid("Unsupported cURL option. Only URL, -X, -H, and inline -d options are allowed.");
  }
  if (method !== "POST" || !url || !body) throw invalid("Use a POST request with one URL and an inline JSON body.");
  url = serviceUrl(url);
  if (!body.includes("{{model}}") || !body.includes("{{messages}}")) throw invalid("The JSON body must contain {{model}} and {{messages}} placeholders.");
  let data;
  try {
    data = JSON.parse(body.replace(/"\{\{messages\}\}"|\{\{messages\}\}/g, JSON.stringify(messages)).replace(/"\{\{model\}\}"|\{\{model\}\}/g, JSON.stringify(model)));
  } catch { throw invalid("The custom cURL body must be valid JSON with model and messages placeholders as complete values."); }
  if (!data || Array.isArray(data) || typeof data !== "object" || data.model !== model || !Array.isArray(data.messages))
    throw invalid("The custom JSON body must have model and messages fields using the placeholders.");
  if (data.tools?.length || data.functions?.length) throw invalid("Custom answer requests cannot enable tools.");
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return { url, method, headers, body: JSON.stringify(data) };
}

export async function* customAnswer({ settings, messages, signal, fetchImpl = fetch }) {
  const { url, ...options } = parseCustomCurl(settings.customCurl, { model: settings.answerModel, messages });
  const response = await request(url, { ...options, signal }, fetchImpl);
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    const data = await responseJson(response, signal);
    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? choice?.message?.refusal ?? choice?.text;
    if (typeof text !== "string" || !text.trim() || choice.message?.tool_calls?.length || choice.message?.function_call)
      throw failed("The custom service returned an invalid or empty completion.");
    if (choice.finish_reason && !["stop", "length"].includes(choice.finish_reason)) throw failed("The custom completion did not finish successfully.");
    yield text;
    return;
  }
  let buffer = "";
  let finished = false;
  let terminal = false;
  let hasText = false;
  const parse = (block) => {
    const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return "";
    if (terminal) throw failed("The custom service returned data after completion.");
    if (data === "[DONE]") { terminal = true; return ""; }
    const value = json(data);
    if (!Array.isArray(value.choices)) throw failed("The custom service returned an invalid streaming event.");
    if (value.choices.length === 0 && value.usage) return "";
    const choice = value.choices[0];
    if (!choice || (!choice.delta && choice.text === undefined) || choice.delta?.tool_calls?.length || choice.delta?.function_call)
      throw failed("The custom service returned an invalid streaming event.");
    const text = choice.delta?.content ?? choice.delta?.refusal ?? choice.text ?? "";
    if (typeof text !== "string" || (finished && (text || choice.finish_reason))) throw failed("The custom service returned an invalid text delta.");
    if (choice.finish_reason) {
      if (!["stop", "length"].includes(choice.finish_reason)) throw failed("The custom answer did not finish successfully.");
      finished = true;
    }
    hasText ||= Boolean(text.trim());
    return text;
  };
  for await (const chunk of chunks(response, signal)) {
    buffer += chunk;
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, match.index).replace(/\r\n/g, "\n");
      buffer = buffer.slice(match.index + match[0].length);
      const text = parse(block); if (text) yield text;
    }
  }
  if (buffer.trim() || !hasText || !finished) throw failed("The custom answer stream ended unexpectedly.");
}
