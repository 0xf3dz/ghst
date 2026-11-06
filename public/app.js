const $ = (selector) => document.querySelector(selector);
document.body.classList.toggle("desktop-mac", window.desktop?.platform === "darwin");
let state,
  currentId,
  answering = false,
  uploading = false,
  capture = null,
  pin = false,
  compact = false;
let transcriptionQueue = Promise.resolve(),
  queuedAudio = 0,
  pendingWrites = 0,
  startingAudio = false,
  answerQueue = Promise.resolve(),
  toastTimer;
const audioBusy = () =>
  capture || startingAudio || queuedAudio > 0 || pendingWrites > 0;
const session = () => state?.sessions[0];
const sessionDocuments = () => state.documents.filter(doc => doc.sessionId === currentId);
const ompProviders = {
  chatgpt: { label: "ChatGPT subscription", prefix: "openai-codex" },
  claude: { label: "Claude subscription", prefix: "anthropic" },
  gemini: { label: "Gemini account", prefix: "google-gemini-cli" },
  groq: { label: "Groq credentials", prefix: "groq" },
};
const defaultApiModels = ["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4o", "gpt-4o-mini"];
let modelCatalog;
let activeAnswer = null;
const agentText = (value) => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
async function agentCommand(id, command, args = {}) {
  const result = await post(`/api/sessions/${id}/agent/command`, { command, ...args });
  if (result?.ok === false || result?.error)
    throw new Error(agentText(result.error || `${command} failed.`));
  return result;
}
function showAgentInteraction(view, request, id) {
  if (!request || request.id == null || view.interactions.has(request.id)) return;
  const method = String(request.method || "").toLowerCase();
  if (method === "cancel") {
    const pending = view.interactions.get(request.targetId);
    if (pending) {
      pending.querySelectorAll("button, input, textarea, select").forEach(input => { input.disabled = true; });
      pending.append(element("p", "", "The runtime closed this request."));
      view.interactions.delete(request.targetId);
    }
    return;
  }
  const card = element("section", "agent-interaction");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", request.title || "Agent request");
  card.append(element("strong", "", request.title || "Agent request"));
  if (request.message) card.append(element("p", "", agentText(request.message)));
  const controls = element("div", "agent-actions");
  const error = element("p", "agent-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  card.append(controls, error);
  view.node.append(card);
  view.interactions.set(request.id, card);
  async function respond(value) {
    const inputs = card.querySelectorAll("button, input, textarea, select");
    inputs.forEach(input => { input.disabled = true; });
    error.hidden = true;
    try {
      await agentCommand(id, "respond", { requestId: request.id, value });
      controls.replaceChildren(element("span", "", "Response sent."));
      view.interactions.delete(request.id);
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
      inputs.forEach(input => { input.disabled = !answering || !view.interactions.has(request.id); });
    }
  }
  function action(label, value) {
    const button = element("button", "", label);
    button.type = "button";
    button.onclick = () => respond(value);
    controls.append(button);
  }
  if (["confirm", "approval", "approve"].includes(method)) {
    action("Deny", false);
    action("Allow", true);
  } else if (method === "select" && Array.isArray(request.options)) {
    for (const option of request.options) {
      const object = option !== null && typeof option === "object";
      action(object ? agentText(option.label ?? option.title ?? option.value) : String(option),
        object && Object.hasOwn(option, "value") ? option.value : option);
    }
    action("Dismiss request", null);
  } else if (["input", "editor"].includes(method)) {
    const input = element(method === "editor" ? "textarea" : "input");
    input.setAttribute("aria-label", request.title || "Response");
    input.placeholder = request.placeholder || "";
    input.value = request.prefill ?? request.defaultValue ?? "";
    const send = element("button", "", "Send response");
    send.type = "button";
    send.onclick = () => respond(input.value);
    controls.append(input, send);
    action("Dismiss request", null);
  } else if (method === "ask" && Array.isArray(request.questions)) {
    const questions = request.questions.map((question, index) => {
      const group = element("fieldset", "agent-question");
      group.append(element("legend", "", question.header || question.question));
      if (question.header) group.append(element("p", "", question.question));
      const choices = (question.options || []).map(option => {
        const label = element("label", "agent-choice");
        const input = element("input");
        input.type = question.multi ? "checkbox" : "radio";
        input.name = `agent-${request.id}-${index}`;
        input.value = option.label;
        label.append(input, document.createTextNode(option.label));
        if (option.description) label.append(element("small", "", option.description));
        if (option.preview) label.append(element("pre", "agent-payload", option.preview));
        group.append(label);
        return input;
      });
      const custom = element("textarea");
      custom.placeholder = "Or write your own response";
      custom.setAttribute("aria-label", `Custom response: ${question.question}`);
      group.append(custom);
      controls.append(group);
      return { id: question.id, choices, custom };
    });
    const submit = element("button", "", "Send answers");
    submit.type = "button";
    submit.onclick = () => {
      const answers = questions.map(question => ({
        id: question.id,
        selectedOptions: question.choices.filter(input => input.checked).map(input => input.value),
        customInput: question.custom.value,
      }));
      if (answers.some(answer => !answer.selectedOptions.length && !answer.customInput.trim())) {
        error.textContent = "Choose an option or write a response for each question.";
        error.hidden = false;
        return;
      }
      void respond({ answers });
    };
    controls.append(submit);
    action("Dismiss request", null);
  } else {
    controls.append(element("p", "", `This runtime request (${request.method || "unknown"}) has no supported response control. Nothing was approved. Cancel the answer if it cannot continue.`));
  }
}
$("#cancel-answer").onclick = async () => {
  const active = activeAnswer;
  if (!active) return;
  $("#cancel-answer").disabled = true;
  try {
    if (ompProviders[active.provider]) await agentCommand(active.id, "cancel");
    active.cancelled = true;
    active.controller.abort();
  } catch (error) {
    notify(error.message);
    const failure = element("p", "agent-error", `Cancellation failed: ${error.message}`);
    failure.setAttribute("role", "alert");
    active.view.node.append(failure);
  } finally {
    $("#cancel-answer").disabled = false;
  }
};
async function loadModelCatalog() {
  try { modelCatalog = await api("/api/models"); }
  catch { modelCatalog = { subscriptionModels: [], apiModels: defaultApiModels, ollamaModels: [] }; }
  $("#answer-models").replaceChildren(...[...(modelCatalog.apiModels || defaultApiModels), ...(modelCatalog.ollamaModels || []).map(model => `ollama:${model}`)].map(model => new Option(model, model)));
  $("#subscription-models").replaceChildren(...(modelCatalog.subscriptionModels || []).map(model => new Option(model, model)));
}
function renderModelPicker() {
  const picker = $("#answer-model-picker");
  const settings = state.settings;
  const groups = [];
  for (const [provider, details] of Object.entries(ompProviders)) {
    const selected = settings.answerProvider === provider ? settings.subscriptionModel : "";
    const models = (modelCatalog?.subscriptionModels || []).filter(model => model.startsWith(`${details.prefix}/`));
    groups.push([provider, `${details.label} through omp`, models, selected]);
  }
  const localModels = (modelCatalog?.ollamaModels || []).map(model => model.replace(/^ollama:/, ""));
  groups.push(["openai", "OpenAI API", modelCatalog?.apiModels || defaultApiModels, settings.answerProvider === "openai" ? settings.answerModel : ""]);
  groups.push(["ollama", "Ollama local", localModels, settings.answerProvider === "ollama" ? settings.answerModel : ""]);
  if (settings.answerProvider === "custom")
    groups.push(["custom", "Custom cURL — experimental", [], settings.answerModel]);
  picker.replaceChildren();
  for (const [provider, label, models, selected] of groups) {
    const values = new Set([selected, ...models].filter(Boolean));
    if (!values.size) continue;
    const group = element("optgroup");
    group.label = label;
    for (const model of values) {
      const option = new Option(model, `${provider}:${model}`);
      option.selected = provider === settings.answerProvider && model === selected;
      group.append(option);
    }
    picker.append(group);
  }
  picker.disabled = answering || uploading;
}
$("#answer-model-picker").onchange = async (event) => {
  if (answering || uploading || audioBusy()) { renderModelPicker(); return notify("Wait for active requests before you change the model."); }
  const [answerProvider, ...parts] = event.target.value.split(":");
  const model = parts.join(":");
  event.target.disabled = true;
  try {
    await post("/api/settings", { answerProvider, [ompProviders[answerProvider] ? "subscriptionModel" : "answerModel"]: model });
    await refresh();
    notify("Answer model selected.");
  } catch (error) { notify(error.message); renderModelPicker(); }
};
$("#close-citation").onclick = () => $("#citation-dialog").close();
function notify(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("#toast").hidden = true;
  }, 8500);
}
async function api(path, options = {}) {
  const response = await fetch(
    path,
    options.body instanceof FormData
      ? options
      : {
          ...options,
          headers: { "Content-Type": "application/json", ...options.headers },
        },
  );
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}
const post = (path, body) =>
  api(path, { method: "POST", body: JSON.stringify(body) });
async function applyOpacity(value) {
  const opacity = Number(value);
  if (window.desktop?.isDesktop)
    return window.desktop.setOpacity(opacity);
  document.documentElement.style.opacity = String(opacity);
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
async function refresh() {
  state = await api("/api/state");
  await applyOpacity(state.settings.opacity);
  await loadModelCatalog();
  currentId = session().id;
  render();
}
function render() {
  renderLibrary();
  renderMessages();
  renderTranscript();
  renderModelPicker();
  const documents = sessionDocuments();
  $("#context-label").textContent = documents.length
    ? `${documents.length} reference${documents.length === 1 ? "" : "s"} attached`
    : "No references attached";
}
function renderLibrary() {
  $("#documents").replaceChildren();
  const documents = sessionDocuments();
  for (const doc of documents) {
    const row = element("div", `document ${doc.type}`);
    row.setAttribute("role", "listitem");
    row.append(
      element("span", "document-icon", doc.type === "pdf" ? "PDF" : "MD"),
    );
    const info = element("div", "document-info");
    const name = element("span", "document-name", doc.name);
    name.title = doc.name;
    info.append(name);
    row.title = doc.type === "pdf" ? `${doc.name} · ${doc.pages} pages` : `${doc.name} · Markdown instructions`;
    const remove = element("button", "", "×");
    remove.type = "button";
    remove.title = `Remove ${doc.name}`;
    remove.setAttribute("aria-label", remove.title);
    remove.onclick = async () => {
      if (answering || uploading)
        return notify("Wait for the current request to finish.");
      if (!confirm(`Remove ${doc.name} from the context library?`)) return;
      try {
        await api(`/api/sessions/${doc.sessionId}/documents/${doc.id}`, { method: "DELETE" });
        await refresh();
        $("#upload-files").focus();
      } catch (error) {
        notify(error.message);
      }
    };
    row.append(info, remove);
    $("#documents").append(row);
  }
}
function addMessage(message) {
  const node = element("article", `message ${message.role}`);
  node.append(
    element(
      "div",
      `message-role ${message.role}`,
      message.role === "user" ? "YOUR QUESTION" : "✧  SUGGESTED ANSWER",
    ),
  );
  const content = element("div", "message-content");
  node.append(content);
  node.citationSources = message.sources || [];
  if (message.role === "assistant") renderAnswerContent(content, message.text, node.citationSources);
  else content.textContent = message.text;
  if (message.role === "assistant") {
    const actions = element("div", "message-actions");
    const copy = element("button", "text-button", "Copy answer");
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(content.textContent);
        notify("Answer copied.");
      } catch {
        notify("Clipboard access failed. Select and copy the answer text.");
      }
    };
    actions.append(copy);
    node.append(actions);
  }
  $("#messages").append(node);
  return { node, content, interactions: new Map() };
}
function renderAnswerContent(content, text, sources = []) {
  const fragment = document.createDocumentFragment();
  let start = 0;
  for (const match of text.matchAll(/\[(\d+)\]/g)) {
    fragment.append(document.createTextNode(text.slice(start, match.index)));
    const source = sources[Number(match[1]) - 1];
    if (source) {
      const button = element("button", "citation-button", match[0]);
      button.type = "button";
      button.setAttribute("aria-label", `Reference ${match[1]}`);
      button.onclick = () => {
        $("#citation-title").textContent = `${match[0]} ${source.name}${source.page ? ` · Page ${source.page}` : ""}`;
        $("#citation-text").textContent = source.text;
        $("#citation-dialog").showModal();
      };
      fragment.append(button);
    } else fragment.append(document.createTextNode(match[0]));
    start = match.index + match[0].length;
  }
  fragment.append(document.createTextNode(text.slice(start)));
  content.replaceChildren(fragment);
}
function renderMessages() {
  $("#messages").replaceChildren();
  if (!session().messages.length)
    $("#messages").append($("#welcome-template").content.cloneNode(true));
  else session().messages.forEach(addMessage);
  $("#messages").scrollTop = session().messages.length
    ? $("#messages").scrollHeight
    : 0;
}
function renderTranscript() {
  if (!session().transcript.length) {
    if (!$("#transcript .transcript-empty")) {
      const empty = element("div", "transcript-empty");
      empty.append(
        element("h3", "", "The conversation starts here"),
        element(
          "p",
          "",
          "Start listening. You can also paste a transcript below.",
        ),
      );
      $("#transcript").replaceChildren(empty);
    }
    return;
  }
  $("#transcript").replaceChildren();
  for (const entry of session().transcript) {
    const node = element("div", "transcript-entry");
    node.append(
      element(
        "time",
        "",
        new Date(entry.time).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      ),
      element("p", "", entry.text),
    );
    const use = element("button", "", "Answer this ↗");
    use.onclick = () => enqueueAnswer(entry.text, currentId);
    node.append(use);
    $("#transcript").append(node);
  }
  $("#transcript").scrollTop = $("#transcript").scrollHeight;
}
async function upload(files) {
  if (uploading || answering)
    return notify("Wait for the current request to finish.");
  if (!files.length) return;
  const ownerId = currentId;
  const form = new FormData();
  for (const file of files) {
    if (!/\.(pdf|md)$/i.test(file.name))
      return notify("Select PDF or Markdown (.md) files.");
    if (file.size > 100 * 1024 * 1024)
      return notify("Each file must be 100 MB or less.");
    form.append("files", file);
  }
  uploading = true;
  $("#upload-label").textContent = "Reading and indexing references…";
  $("#upload-files").disabled = true;
  $("#files").disabled = true;
  try {
    await api(`/api/sessions/${ownerId}/documents`, { method: "POST", body: form });
    await refresh();
    notify("References are ready.");
  } catch (error) {
    notify(error.message);
  } finally {
    uploading = false;
    $("#upload-label").textContent = "";
    $("#upload-files").disabled = false;
    $("#files").disabled = false;
    $("#files").value = "";
    renderModelPicker();
  }
}
$("#files").onchange = (event) => upload([...event.target.files]);
$("#upload-files").onclick = () => $("#files").click();
for (const name of ["dragover", "dragleave", "drop"])
  $("#upload-zone").addEventListener(name, (event) => {
    event.preventDefault();
    $("#upload-zone").classList.toggle("dragover", name === "dragover");
    if (name === "drop") upload([...event.dataTransfer.files]);
  });
let subscriptionPreview = null;
let disguiseAvailable = false;
let disguiseEnabled = false;
function renderDisguise() {
  $("#disguise-toggle").disabled = !disguiseAvailable;
  $("#disguise-toggle").setAttribute("aria-pressed", String(disguiseEnabled));
  $("#disguise-name").disabled = !disguiseAvailable || !disguiseEnabled;
  $("#disguise-name").required = disguiseAvailable && disguiseEnabled;
  $("#disguise-status").textContent = disguiseAvailable
    ? disguiseEnabled ? "Disguise enabled. Save settings to apply." : "Disguise off. Save settings to restore Ghst."
    : "Requires the desktop app.";
}
async function loadDisguise() {
  disguiseAvailable = false;
  disguiseEnabled = false;
  $("#disguise-name").value = "";
  renderDisguise();
  if (typeof window.desktop?.getDisguise !== "function" ||
      typeof window.desktop?.setDisguise !== "function") return;
  try {
    const disguise = await window.desktop.getDisguise();
    disguiseAvailable = true;
    disguiseEnabled = disguise.enabled;
    $("#disguise-name").value = disguise.name;
    renderDisguise();
  } catch (error) {
    $("#disguise-status").textContent = `Cannot read desktop disguise settings: ${error.message}`;
  }
}
$("#disguise-toggle").onclick = () => {
  if (!disguiseAvailable) return;
  disguiseEnabled = !disguiseEnabled;
  renderDisguise();
  if (disguiseEnabled) $("#disguise-name").focus();
};
async function openSettings() {
  if (!state) return notify("Wait for the application to load.");
  const settings = state.settings;
  const secrets = await api("/api/key");
  $("#api-key").type = "password";
  $("#api-key").value = secrets.apiKey;
  $("#custom-curl").value = secrets.customCurl;
  $("#ollama-url").value = settings.ollamaUrl;
  $("#transcribe-url").value = settings.transcribeUrl;
  $("#transcribe-provider").value = settings.transcribeProvider;
  $("#local-transcribe-model").value = settings.transcribeProvider === "local" ? settings.transcribeModel : "whisper";
  $("#answer-provider").value = settings.answerProvider;
  $("#subscription-model").value = settings.subscriptionModel;
  subscriptionPreview = state.subscription;
  renderProviderSettings();
  $("#answer-model").value = settings.answerModel;
  $("#transcribe-model").value = settings.transcribeModel;
  $("#language").value = settings.language;
  renderTranscriptionSettings();
  const opacityPercent = Math.round(settings.opacity * 100);
  $("#window-opacity").value = String(opacityPercent);
  $("#window-opacity-value").value = `${opacityPercent}%`;
  await loadDisguise();
  $("#settings-dialog").showModal();
}
function renderProviderSettings() {
  const details = ompProviders[$("#answer-provider").value];
  $("#subscription-settings").hidden = !details;
  $("#custom-settings").hidden = $("#answer-provider").value !== "custom";
  $("#subscription-model").required = Boolean(details);
  $("#omp-login-command").textContent = details ? `omp login ${details.prefix}` : "";
  const status = subscriptionPreview;
  $("#subscription-status").textContent =
    status?.model !== $("#subscription-model").value.trim()
      ? "Select Check connection to inspect this model."
      : status?.connected
        ? "ChatGPT sign-in configured in omp. Online access and subscription limits apply."
        : status?.error ||
          (status?.installed
            ? "Sign in with omp, then check the connection."
            : "Install omp and sign in to openai-codex.");
}
$("#subscription-model").oninput = renderProviderSettings;
$("#answer-provider").onchange = () => {
  const details = ompProviders[$("#answer-provider").value];
  if (details && !$("#subscription-model").value.startsWith(`${details.prefix}/`)) $("#subscription-model").value = `${details.prefix}/`;
  renderProviderSettings();
};
function renderTranscriptionSettings() {
  const local = $("#transcribe-provider").value === "local";
  $("#local-transcription-settings").hidden = !local;
  $("#openai-transcription-settings").hidden = local;
}
$("#transcribe-provider").onchange = renderTranscriptionSettings;
$("#toggle-key").onclick = () => {
  const reveal = $("#api-key").type === "password";
  $("#api-key").type = reveal ? "text" : "password";
  $("#toggle-key").setAttribute("aria-label", reveal ? "Hide key" : "Show key");
  $("#toggle-key").setAttribute("aria-pressed", String(reveal));
};
$("#check-subscription").onclick = async () => {
  $("#check-subscription").disabled = true;
  $("#subscription-status").textContent = "Check the omp connection…";
  try {
    const checked = await post("/api/subscription/check", {
      subscriptionModel: $("#subscription-model").value.trim(),
    });
    subscriptionPreview = checked;
    if (checked.model === state.settings.subscriptionModel)
      state.subscription = checked;
    renderProviderSettings();
    if (checked.model === state.settings.subscriptionModel) render();
  } catch (error) {
    $("#subscription-status").textContent = error.message;
  } finally {
    $("#check-subscription").disabled = false;
  }
};
$("#settings").onclick = () => openSettings().catch((error) => notify(error.message));
$("#close-settings").onclick = () => $("#settings-dialog").close();
$("#settings-dialog").addEventListener("close", () => {
  if (state)
    void applyOpacity(state.settings.opacity).catch((error) =>
      notify(error.message),
    );
});
$("#window-opacity").oninput = () => {
  const opacity = Number($("#window-opacity").value) / 100;
  $("#window-opacity-value").value = `${Math.round(opacity * 100)}%`;
  void applyOpacity(opacity).catch((error) => notify(error.message));
};
$("#settings-form").onsubmit = async (event) => {
  event.preventDefault();
  if (answering) return notify("Wait for the answer to finish or cancel it before saving settings.");
  $("#save-settings").disabled = true;
  const settings = {
    answerProvider: $("#answer-provider").value,
    transcribeProvider: $("#transcribe-provider").value,
    transcribeModel: $("#transcribe-provider").value === "local" ? $("#local-transcribe-model").value.trim() : $("#transcribe-model").value,
    transcribeUrl: $("#transcribe-url").value,
    ollamaUrl: $("#ollama-url").value,
    language: $("#language").value.trim(),
    opacity: Number($("#window-opacity").value) / 100,
  };
  if (ompProviders[settings.answerProvider])
    settings.subscriptionModel = $("#subscription-model").value.trim();
  settings.answerModel = $("#answer-model").value;
  if ($("#custom-curl").value.trim()) settings.customCurl = $("#custom-curl").value.trim();
  if ($("#api-key").value.trim()) settings.apiKey = $("#api-key").value.trim();
  try {
    await post("/api/settings", settings);
    if (disguiseAvailable) {
      const disguise = await window.desktop.setDisguise({
        enabled: disguiseEnabled,
        name: $("#disguise-name").value.trim(),
      });
      disguiseEnabled = disguise.enabled;
      $("#disguise-name").value = disguise.name;
      renderDisguise();
    }
    await refresh();
    $("#settings-dialog").close();
    $("#api-key").value = "";
    notify("Settings saved.");
  } catch (error) {
    notify(error.message);
  } finally {
    $("#save-settings").disabled = false;
  }
};
function enqueueAnswer(question, id = currentId) {
  question = question.trim();
  if (!question) return;
  if (state.settings.answerProvider === "openai" && !state.configured) {
    notify("Add an OpenAI API key in settings first.");
    openSettings();
    return;
  }
  const answerProvider = state.settings.answerProvider;
  answerQueue = answerQueue
    .then(() => answer(question, id, answerProvider))
    .catch((error) => notify(error.message));
}
async function answer(question, id, answerProvider) {
  if (id !== currentId) return;
  answering = true;
  $("#answer-activity").hidden = false;
  $("#cancel-answer").disabled = false;
  $("#ask").disabled = true;
  $("#answer-model-picker").disabled = true;
  $("#working").hidden = false;
  $("#messages .welcome")?.remove();
  addMessage({ role: "user", text: question });
  const view = addMessage({ role: "assistant", text: "" });
  const active = { id, provider: answerProvider, controller: new AbortController(), cancelled: false, view };
  activeAnswer = active;
  let reader;
  let fullText = "",
    completed = false;
  try {
    const response = await fetch(`/api/sessions/${id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, answerProvider }),
      signal: active.controller.signal,
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "The answer request failed.");
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    function consume(line) {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === "error") throw new Error(event.error);
      if (event.type === "sources") view.node.citationSources = event.sources;
      if (event.type === "agent") {
        if (event.event?.method === "cancel") showAgentInteraction(view, event.event, id);
      }
      if (event.type === "interaction") showAgentInteraction(view, event.request, id);
      if (event.type === "delta") {
        fullText += event.text;
        renderAnswerContent(view.content, fullText, view.node.citationSources);
        $("#working").hidden = true;
      }
      if (event.type === "done") completed = true;
      $("#messages").scrollTop = $("#messages").scrollHeight;
    }
    const aborted = new Promise((resolve) => {
      active.controller.signal.addEventListener("abort", () => resolve({ aborted: true }), { once: true });
    });
    while (true) {
      const pending = reader.read();
      pending.catch(() => {});
      const chunk = await Promise.race([pending, aborted]);
      if (chunk.aborted) throw new Error("The answer was cancelled.");
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        consume(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    if (!completed)
      throw new Error(
        "The answer stream ended before the answer was complete. Try again.",
      );
    await refresh();
  } catch (error) {
    view.content.textContent = `${fullText ? `${fullText}\n\n` : ""}${active.cancelled ? "Answer cancelled." : `Answer failed: ${error.message}`}`;
    if (!active.cancelled) notify(error.message);
    try {
      state = await api("/api/state");
    } catch {
      /* Keep the visible error when the server is unavailable. */
    }
  } finally {
    if (reader) {
      try { await reader.cancel(); } catch { /* The stream may already be closed. */ }
    }
    for (const card of view.interactions.values()) {
      card.querySelectorAll("button, input, textarea, select").forEach(input => { input.disabled = true; });
      card.append(element("p", "", "This answer has ended; the request is no longer active."));
    }
    activeAnswer = null;
    answering = false;
    $("#ask").disabled = false;
    $("#working").hidden = true;
    $("#answer-model-picker").disabled = false;
    $("#answer-activity").hidden = true;
  }
}
$("#question-form").onsubmit = (event) => {
  event.preventDefault();
  const text = $("#question").value.trim();
  if (!text || answering) return;
  $("#question").value = "";
  enqueueAnswer(text);
};
$("#use-transcript").onclick = () => {
  const latest = session().transcript.at(-1);
  if (!latest) return notify("There is no transcript yet.");
  $("#question").value = latest.text;
  $("#question").focus();
};
async function storeTranscript(text, id) {
  pendingWrites++;
  try {
    const entry = await post(`/api/sessions/${id}/transcript`, { text });
    const target = state.sessions.find((item) => item.id === id);
    target?.transcript.push(entry);
    if (id === currentId) renderTranscript();
    if ($("#auto-answer").checked) enqueueAnswer(text, id);
  } finally {
    pendingWrites--;
  }
}
$("#transcript-form").onsubmit = async (event) => {
  event.preventDefault();
  const text = $("#manual-transcript").value.trim();
  if (!text) return;
  try {
    await storeTranscript(text, currentId);
    $("#manual-transcript").value = "";
  } catch (error) {
    notify(error.message);
  }
};
$("#auto-answer").onchange = () => {
  if ($("#auto-answer").checked)
    notify(
      "Auto-answer sends each complete speech segment for an answer. All speech from the selected source counts.",
    );
};
$("#pin").onclick = async () => {
  if (!window.desktop)
    return notify(
      "The desktop app supports a window that stays on top. Use npm run desktop.",
    );
  try {
    pin = await window.desktop.setAlwaysOnTop(!pin);
    $("#pin").setAttribute("aria-pressed", pin);
  } catch (error) {
    notify(error.message);
  }
};
$("#compact").onclick = async () => {
  try {
    const next = !compact;
    if (window.desktop) await window.desktop.setCompact(next);
    compact = next;
    document.body.classList.toggle("compact", compact);
    $("#compact").setAttribute("aria-pressed", compact);
  } catch (error) {
    notify(error.message);
  }
};
window.addEventListener("keydown", (event) => {
  if (
    (event.metaKey || event.ctrlKey) &&
    event.key === "Enter" &&
    !document.querySelector("dialog[open]")
  ) {
    event.preventDefault();
    $("#question-form").requestSubmit();
  }
});
async function enumerateDevices() {
  try {
    const selected = $("#audio-device").value;
    const devices = await navigator.mediaDevices.enumerateDevices();
    $("#audio-device").replaceChildren(new Option("Default input", ""));
    devices
      .filter((device) => device.kind === "audioinput")
      .forEach((device, index) =>
        $("#audio-device").append(
          new Option(
            device.label || `Audio input ${index + 1}`,
            device.deviceId,
          ),
        ),
      );
    $("#audio-device").value = selected;
  } catch (error) {
    notify(error.message);
  }
}
$("#audio-source").onchange = () => {
  $("#audio-device").hidden = $("#audio-source").value !== "microphone";
  enumerateDevices();
};
function wavBlob(chunks, sampleRate) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const data = new ArrayBuffer(44 + length * 2),
    view = new DataView(data);
  const label = (offset, text) =>
    [...text].forEach((char, index) =>
      view.setUint8(offset + index, char.charCodeAt(0)),
    );
  label(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  label(8, "WAVE");
  label(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  label(36, "data");
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const chunk of chunks)
    for (const sample of chunk) {
      const value = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true);
      offset += 2;
    }
  return new Blob([data], { type: "audio/wav" });
}
function submitAudio(chunks, rate, id) {
  if (!chunks.length) return;
  if (queuedAudio >= 8) {
    notify(
      "Transcription cannot keep up. Audio capture stopped. Wait for pending segments, then restart.",
    );
    stopCapture();
    return;
  }
  const blob = wavBlob(chunks, rate);
  queuedAudio++;
  $("#audio-status").textContent =
    `${queuedAudio} audio segment${queuedAudio === 1 ? "" : "s"} to transcribe`;
  transcriptionQueue = transcriptionQueue
    .then(async () => {
      const form = new FormData();
      form.append("audio", blob, "question.wav");
      const result = await api("/api/transcribe", {
        method: "POST",
        body: form,
      });
      if (result.text?.trim()) await storeTranscript(result.text.trim(), id);
    })
    .catch((error) => {
      notify(`Transcription failed: ${error.message}`);
      stopCapture();
    })
    .finally(() => {
      queuedAudio--;
      $("#audio-status").textContent = queuedAudio
        ? `${queuedAudio} audio segments to transcribe`
        : capture
          ? "Audio capture active"
          : "Ready when you are";
    });
}
function processAudio(data, target) {
  if (capture !== target) return;
  let energy = 0;
  for (const sample of data) energy += sample * sample;
  const rms = Math.sqrt(energy / data.length),
    seconds = data.length / target.context.sampleRate;
  $("#audio-level").style.width = `${Math.min(100, rms * 900)}%`;
  if (rms > 0.008) {
    if (!target.speaking) {
      target.chunks = [...target.preroll];
      target.speaking = true;
      target.duration = 0;
      target.voiced = 0;
    }
    target.silence = 0;
    target.voiced += seconds;
  } else target.silence += seconds;
  if (target.speaking) {
    target.chunks.push(data);
    target.duration += seconds;
    if (target.silence > 1.15 || target.duration > 22) flushAudio(target);
  }
  target.preroll.push(data);
  if (
    target.preroll.length >
    Math.ceil((target.context.sampleRate * 0.25) / data.length)
  )
    target.preroll.shift();
}
function flushAudio(target) {
  const chunks = target.chunks,
    voiced = target.voiced;
  target.chunks = [];
  target.duration = 0;
  target.voiced = 0;
  target.speaking = false;
  target.silence = 0;
  target.preroll = [];
  if (voiced >= 0.3) submitAudio(chunks, target.context.sampleRate, target.id);
}
function activateCapture(target) {
  $("#listen").textContent = "Stop";
  $("#listen").classList.add("recording");
  $("#live-label").textContent = "LIVE";
  $("#live-label").classList.add("active");
  $("#audio-source").disabled = true;
  $("#audio-device").disabled = true;
  $("#audio-status").textContent = target.nativeZoom ? "Zoom output capture active" : "Audio capture active";
  target.timer = setInterval(() => {
    const seconds = Math.floor((Date.now() - target.start) / 1000);
    $("#timer").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }, 1000);
}
async function startZoomCapture() {
  if (!window.desktop?.startZoomAudio)
    throw new Error("Zoom-only capture requires the macOS desktop app. For browser use, route only Zoom output to a virtual audio input.");
  const target = { nativeZoom: true, context: { sampleRate: 48000 }, id: currentId,
    chunks: [], preroll: [], speaking: false, duration: 0, voiced: 0, silence: 0, start: Date.now() };
  let ready = false, failed = null;
  const pending = [];
  target.unsubscribe = window.desktop.onZoomAudio((data) => {
    if (ready) processAudio(data, target);
    else if (pending.length < 100) pending.push(data);
  });
  target.unsubscribeError = window.desktop.onZoomAudioError((message) => {
    failed = new Error(message);
    if (ready) { notify(message); stopCapture(); }
  });
  try {
    const result = await window.desktop.startZoomAudio();
    if (failed) throw failed;
    if (!Number.isFinite(result.sampleRate) || result.sampleRate < 8000 || result.sampleRate > 192000)
      throw new Error("Zoom capture returned an invalid audio rate.");
    target.context.sampleRate = result.sampleRate;
    capture = target;
    ready = true;
    activateCapture(target);
    for (const data of pending) processAudio(data, target);
  } catch (error) {
    target.unsubscribe();
    target.unsubscribeError();
    await window.desktop.stopZoomAudio().catch(() => {});
    throw error;
  }
}
async function startCapture() {
  if (state.settings.transcribeProvider !== "local" && !state.configured) {
    notify("Add an OpenAI API key before you start transcription.");
    openSettings();
    return;
  }
  startingAudio = true;
  $("#listen").disabled = true;
  let stream, context;
  try {
    if ($("#audio-source").value === "zoom") {
      await startZoomCapture();
      return;
    }
    if ($("#audio-source").value === "system") {
      stream = await navigator.mediaDevices.getDisplayMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: true,
      });
      if (!stream.getAudioTracks().some((track) => track.readyState === "live"))
        throw new Error(
          "No system audio track. Grant system audio permission, or select a loopback audio device.",
        );
    } else {
      const deviceId = $("#audio-device").value;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
      await enumerateDevices();
    }
    context = new AudioContext();
    await context.resume();
    await context.audioWorklet.addModule("/pcm-worklet.js");
    const target = {
      stream,
      context,
      id: currentId,
      chunks: [],
      preroll: [],
      speaking: false,
      duration: 0,
      voiced: 0,
      silence: 0,
      start: Date.now(),
    };
    target.source = context.createMediaStreamSource(
      new MediaStream(stream.getAudioTracks()),
    );
    target.processor = new AudioWorkletNode(context, "pcm-capture");
    target.gain = context.createGain();
    target.gain.gain.value = 0;
    target.source.connect(target.processor);
    target.processor.connect(target.gain);
    target.gain.connect(context.destination);
    capture = target;
    target.processor.port.onmessage = (event) =>
      processAudio(event.data, target);
    for (const track of stream.getTracks())
      track.addEventListener("ended", () => {
        if (capture === target) {
          notify("Audio capture ended. Start listening to reconnect.");
          stopCapture();
        }
      });
    if (!stream.getAudioTracks().some((track) => track.readyState === "live"))
      throw new Error(
        "Audio permission failed. Check macOS System Settings and restart the app.",
      );
    activateCapture(target);
  } catch (error) {
    if (capture) stopCapture();
    else {
      stream?.getTracks().forEach((track) => track.stop());
      if (context) await context.close();
    }
    notify(error.message);
  } finally {
    startingAudio = false;
    $("#listen").disabled = false;
  }
}
function stopCapture() {
  const target = capture;
  if (!target) return;
  capture = null;
  clearInterval(target.timer);
  flushAudio(target);
  if (target.nativeZoom) {
    target.unsubscribe();
    target.unsubscribeError();
    window.desktop.stopZoomAudio().catch((error) => notify(error.message));
  } else {
    target.processor.port.onmessage = null;
    target.source.disconnect();
    target.processor.disconnect();
    target.gain.disconnect();
    target.stream.getTracks().forEach((track) => track.stop());
    target.context.close();
  }
  $("#listen").textContent = "Listen";
  $("#listen").classList.remove("recording");
  $("#live-label").textContent = "OFFLINE";
  $("#live-label").classList.remove("active");
  $("#audio-source").disabled = false;
  $("#audio-device").disabled = false;
  $("#audio-level").style.width = "0%";
  $("#audio-status").textContent = queuedAudio
    ? `${queuedAudio} audio segments to transcribe`
    : "Ready when you are";
}
$("#listen").onclick = () => (capture ? stopCapture() : startCapture());
window.addEventListener("beforeunload", (event) => {
  if (audioBusy() || answering || uploading) {
    event.preventDefault();
    event.returnValue = "";
  }
});
refresh().catch((error) =>
  notify(`Cannot open the workspace: ${error.message}`),
);
