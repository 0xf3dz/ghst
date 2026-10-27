const $ = (selector) => document.querySelector(selector);
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
const session = () => state?.sessions.find((item) => item.id === currentId);
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
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
async function refresh() {
  state = await api("/api/state");
  if (!state.sessions.length)
    state.sessions.unshift(
      await post("/api/sessions", {
        title: `Intel · ${new Date().toLocaleDateString()}`,
      }),
    );
  if (!state.sessions.some((item) => item.id === currentId))
    currentId = state.sessions[0].id;
  render();
}
function render() {
  renderLibrary();
  renderSessions();
  renderMessages();
  renderTranscript();
  const subscription = state.settings.answerProvider === "chatgpt";
  const ready = subscription ? state.subscription?.connected || state.configured : state.configured;
  $("#connection").textContent = subscription
    ? ready
      ? state.subscription?.connected ? "ChatGPT through omp" : "API fallback available"
      : "Connect ChatGPT"
    : ready
      ? "API key configured"
      : "API key required";
  $("#connection").classList.toggle("connected", Boolean(ready));
  $("#connection").title =
    `Answers: ${subscription ? "ChatGPT through omp with automatic API fallback" : "OpenAI API credits"}. Transcription: ${state.configured ? "API key configured" : "API key required"}.`;
  $("#model-label").textContent = subscription
    ? state.settings.subscriptionModel
    : state.settings.answerModel;
  $("#session-title").textContent = session().title;
  $("#context-label").textContent = state.documents.length
    ? `${state.documents.length} reference${state.documents.length === 1 ? "" : "s"} in context`
    : "No references attached";
}
function renderLibrary() {
  $("#documents").replaceChildren();
  $("#document-count").textContent = state.documents.length;
  for (const doc of state.documents) {
    const row = element("div", `document ${doc.type}`);
    row.append(
      element("span", "document-icon", doc.type === "pdf" ? "PDF" : "MD"),
    );
    const info = element("div", "document-info");
    const name = element("span", "document-name", doc.name);
    name.title = doc.name;
    info.append(
      name,
      element(
        "span",
        "document-meta",
        doc.type === "pdf"
          ? `${doc.pages} pages · Indexed locally`
          : "Skill instructions · Active",
      ),
    );
    const remove = element("button", "", "×");
    remove.title = `Remove ${doc.name}`;
    remove.setAttribute("aria-label", remove.title);
    remove.onclick = async () => {
      if (answering || uploading)
        return notify("Wait for the current request to finish.");
      if (!confirm(`Remove ${doc.name} from the context library?`)) return;
      try {
        await api(`/api/documents/${doc.id}`, { method: "DELETE" });
        await refresh();
      } catch (error) {
        notify(error.message);
      }
    };
    row.append(info, remove);
    $("#documents").append(row);
  }
}
function renderSessions() {
  $("#sessions").replaceChildren();
  for (const item of state.sessions) {
    const row = element(
      "div",
      `session-row ${item.id === currentId ? "active" : ""}`,
    );
    const choose = element("button", "", item.title);
    choose.title = new Date(item.createdAt).toLocaleString();
    choose.onclick = () => {
      if (answering || audioBusy())
        return notify(
          "Stop audio capture and wait for requests before you change the session.",
        );
      currentId = item.id;
      render();
    };
    const remove = element("button", "delete-session", "×");
    remove.setAttribute("aria-label", `Delete ${item.title}`);
    remove.onclick = async () => {
      if (answering || audioBusy())
        return notify(
          "Stop audio capture and wait for requests before you delete a session.",
        );
      if (!confirm("Delete this session and its transcript?")) return;
      try {
        await api(`/api/sessions/${item.id}`, { method: "DELETE" });
        await refresh();
      } catch (error) {
        notify(error.message);
      }
    };
    row.append(choose, remove);
    $("#sessions").append(row);
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
  const content = element("div", "message-content", message.text);
  node.append(content);
  if (message.sources?.length) addSources(node, message.sources);
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
  return { node, content };
}
function addSources(node, sources) {
  node.querySelector(".source-list")?.remove();
  const list = element("div", "source-list");
  sources.forEach((source, index) => {
    const details = element("details");
    details.append(
      element(
        "summary",
        "",
        `[${index + 1}] ${source.name}${source.page ? ` · Page ${source.page}` : ""}`,
      ),
      element("p", "", source.text),
    );
    list.append(details);
  });
  node.append(list);
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
  const form = new FormData();
  for (const file of files) {
    if (!/\.(pdf|md)$/i.test(file.name))
      return notify("Select PDF or Markdown (.md) files.");
    if (file.size > 100 * 1024 * 1024)
      return notify("Each file must be 100 MB or less.");
    form.append("files", file);
  }
  uploading = true;
  $("#upload-label").textContent = "Read and index references…";
  $("#files").disabled = true;
  try {
    await api("/api/documents", { method: "POST", body: form });
    await refresh();
    notify("References are ready.");
  } catch (error) {
    notify(error.message);
  } finally {
    uploading = false;
    $("#upload-label").textContent = "Add files";
    $("#files").disabled = false;
    $("#files").value = "";
  }
}
$("#files").onchange = (event) => upload([...event.target.files]);
for (const name of ["dragover", "dragleave", "drop"])
  $("#upload-zone").addEventListener(name, (event) => {
    event.preventDefault();
    $("#upload-zone").classList.toggle("dragover", name === "dragover");
    if (name === "drop") upload([...event.dataTransfer.files]);
  });
$("#new-session").onclick = async () => {
  if (answering || audioBusy())
    return notify(
      "Stop audio capture and wait for requests before you start a new session.",
    );
  try {
    const item = await post("/api/sessions", {
      title: `Intel · ${new Date().toLocaleDateString()}`,
    });
    currentId = item.id;
    await refresh();
  } catch (error) {
    notify(error.message);
  }
};
$("#toggle-sidebar").onclick = () => {
  const open = document.body.classList.toggle("sidebar-open");
  $("#toggle-sidebar").setAttribute("aria-expanded", open);
  $("#toggle-sidebar").setAttribute(
    "aria-label",
    open ? "Close context library" : "Open context library",
  );
};
$("#workspace-link").onclick = () => $("#question").focus();
$("#export").onclick = () => {
  if (session()) window.location.href = `/api/sessions/${currentId}/export`;
};
let subscriptionPreview = null;
function openSettings() {
  const settings = state.settings;
  $("#api-key").value = "";
  $("#api-key").placeholder = state.configured
    ? "Key configured. Leave blank to keep it."
    : "sk-…";
  $("#answer-provider").value = settings.answerProvider;
  $("#subscription-model").value = settings.subscriptionModel;
  subscriptionPreview = state.subscription;
  renderProviderSettings();
  $("#answer-model").value = settings.answerModel;
  $("#transcribe-model").value = settings.transcribeModel;
  $("#language").value = settings.language;
  $("#instructions").value = settings.instructions;
  $("#settings-dialog").showModal();
}
function renderProviderSettings() {
  const useSubscription = $("#answer-provider").value === "chatgpt";
  $("#subscription-settings").hidden = !useSubscription;
  $("#api-answer-settings").hidden = false;
  $("#subscription-model").required = useSubscription;
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
$("#answer-provider").onchange = renderProviderSettings;
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
$("#settings").onclick = openSettings;
$("#connection").onclick = openSettings;
$("#connection").style.cursor = "pointer";
$("#close-settings").onclick = () => $("#settings-dialog").close();
$("#settings-form").onsubmit = async (event) => {
  event.preventDefault();
  $("#save-settings").disabled = true;
  const settings = {
    answerProvider: $("#answer-provider").value,
    transcribeModel: $("#transcribe-model").value,
    language: $("#language").value.trim(),
    instructions: $("#instructions").value,
  };
  if (settings.answerProvider === "chatgpt")
    settings.subscriptionModel = $("#subscription-model").value.trim();
  settings.answerModel = $("#answer-model").value;
  if ($("#api-key").value.trim()) settings.apiKey = $("#api-key").value.trim();
  try {
    await post("/api/settings", settings);
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
$("#remove-key").onclick = async () => {
  if (
    !confirm(
      "Remove the saved OpenAI API key? An environment key, if set, remains active.",
    )
  )
    return;
  try {
    await api("/api/key", { method: "DELETE" });
    await refresh();
    openSettingsAfterClose();
    notify("Saved key removed.");
  } catch (error) {
    notify(error.message);
  }
};
function openSettingsAfterClose() {
  $("#settings-dialog").close();
  openSettings();
}
function enqueueAnswer(question, id = currentId) {
  question = question.trim();
  if (!question) return;
  const subscription = state.settings.answerProvider === "chatgpt";
  if (subscription ? !state.subscription?.connected && !state.configured : !state.configured) {
    notify(
      subscription
        ? "Connect ChatGPT in omp or add an API key for automatic fallback."
        : "Add an OpenAI API key in settings first.",
    );
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
  $("#ask").disabled = true;
  $("#working").hidden = false;
  $("#messages .welcome")?.remove();
  addMessage({ role: "user", text: question });
  const view = addMessage({ role: "assistant", text: "" });
  let fullText = "",
    completed = false;
  try {
    const response = await fetch(`/api/sessions/${id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, answerProvider }),
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "The answer request failed.");
    }
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "";
    function consume(line) {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === "error") throw new Error(event.error);
      if (event.type === "sources") addSources(view.node, event.sources);
      if (event.type === "reset") {
        fullText = "";
        view.content.textContent = "";
        $("#working").hidden = false;
      }
      if (event.type === "fallback") {
        notify("Subscription unavailable. This answer uses OpenAI API credits.");
        $("#model-label").textContent = `${state.settings.answerModel} · API fallback`;
      }
      if (event.type === "delta") {
        fullText += event.text;
        view.content.textContent = fullText;
        $("#working").hidden = true;
      }
      if (event.type === "done") completed = true;
      $("#messages").scrollTop = $("#messages").scrollHeight;
    }
    while (true) {
      const chunk = await reader.read();
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
    view.content.textContent = `${fullText ? `${fullText}\n\n` : ""}Answer failed: ${error.message}`;
    notify(error.message);
    try {
      state = await api("/api/state");
    } catch {
      /* Keep the visible error when the server is unavailable. */
    }
  } finally {
    answering = false;
    $("#ask").disabled = false;
    $("#working").hidden = true;
  }
}
$("#question-form").onsubmit = (event) => {
  event.preventDefault();
  const text = $("#question").value.trim();
  if (!text || answering) return;
  $("#question").value = "";
  enqueueAnswer(text);
};
$("#messages").onclick = (event) => {
  const suggestion = event.target.closest("[data-question]");
  if (suggestion) {
    $("#question").value = suggestion.dataset.question;
    $("#question").focus();
  }
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
    !$("#settings-dialog").open
  ) {
    event.preventDefault();
    $("#question-form").requestSubmit();
  }
  if (
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "k" &&
    !$("#settings-dialog").open
  ) {
    event.preventDefault();
    $("#new-session").click();
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
  $("#session-subtitle").textContent =
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
      $("#session-subtitle").textContent = queuedAudio
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
  $("#listen").innerHTML = '<span class="record-dot"></span> Stop listening';
  $("#listen").classList.add("recording");
  $("#live-label").textContent = "LIVE";
  $("#live-label").classList.add("active");
  $("#session-indicator").classList.add("active");
  $("#audio-source").disabled = true;
  $("#audio-device").disabled = true;
  $("#session-subtitle").textContent = target.nativeZoom ? "Zoom output capture active" : "Audio capture active";
  $("#audio-note").textContent = target.nativeZoom
    ? "Zoom output only. No local microphone input."
    : "Speech segments go to OpenAI after a pause.";
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
  if (!state.configured) {
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
  $("#listen").innerHTML = '<span class="record-dot"></span> Start listening';
  $("#listen").classList.remove("recording");
  $("#live-label").textContent = "OFFLINE";
  $("#live-label").classList.remove("active");
  $("#session-indicator").classList.remove("active");
  $("#audio-source").disabled = false;
  $("#audio-device").disabled = false;
  $("#audio-level").style.width = "0%";
  $("#session-subtitle").textContent = queuedAudio
    ? `${queuedAudio} audio segments to transcribe`
    : "Ready when you are";
  $("#audio-note").textContent = "Audio goes to OpenAI for transcription.";
}
$("#listen").onclick = () => (capture ? stopCapture() : startCapture());
window.addEventListener("beforeunload", (event) => {
  if (capture || queuedAudio || answering) {
    event.preventDefault();
    event.returnValue = "";
  }
});
refresh().catch((error) =>
  notify(`Cannot open the workspace: ${error.message}`),
);
