import { HttpError } from "./store.js";

// OpenAI realtime transcription. Audio is mono 16-bit PCM at 24 kHz.
const REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const REALTIME_RATE = 24000;
export const REALTIME_MODELS = new Set(["gpt-live-transcribe", "gpt-transcribe"]);
export const DEFAULT_TRANSCRIPTION_MODEL = "gpt-live-transcribe";

// One upstream session. Audio arrives as complete PCM16 frames; a commit closes
// the current turn and the transcript arrives as deltas and a completed event.
export class RealtimeTranscription {
  constructor({
    apiKey,
    model = DEFAULT_TRANSCRIPTION_MODEL,
    language = "",
    onDelta = () => {},
    onCompleted = () => {},
    onFailure = () => {},
    WebSocketImpl = globalThis.WebSocket,
    url = REALTIME_URL,
  }) {
    if (!REALTIME_MODELS.has(model))
      throw new HttpError(400, "Choose a supported transcription model in Settings.");
    if (!apiKey) throw new HttpError(400, "Add an OpenAI API key before you start transcription.");
    if (typeof WebSocketImpl !== "function")
      throw new HttpError(500, "This Node version cannot open a speech stream.");
    this.onDelta = onDelta;
    this.onCompleted = onCompleted;
    this.onFailure = onFailure;
    this.closed = false;
    this.commits = [];
    this.sequences = new Map();
    this.socket = new WebSocketImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    this.session = {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: REALTIME_RATE },
          transcription: { model, ...(language ? { language } : {}) },
          turn_detection: null,
        },
      },
    };
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => {});
    this.queue = [];
    this.socket.onopen = () => {
      this.socket.send(JSON.stringify({ type: "session.update", session: this.session }));
      const queued = this.queue;
      this.queue = [];
      for (const message of queued) this.send(message);
    };
    this.socket.onmessage = (event) => this.receive(event.data);
    this.socket.onclose = () => {
      this.closed = true;
      this.rejectReady(new HttpError(502, "The speech stream closed before it was ready."));
      if (this.opened && !this.closing)
        this.onFailure("The speech stream closed. Start listening to reconnect.");
    };
    this.socket.onerror = () => {
      this.rejectReady(
        new HttpError(502, "Could not connect to OpenAI for live transcription. Check your network connection."),
      );
    };
  }

  send(message) {
    if (this.closed) return;
    if (this.socket.readyState !== 1) {
      if (this.queue.length >= 512) {
        this.onFailure("The speech stream did not open. Start listening to reconnect.");
        this.close();
        return;
      }
      this.queue.push(message);
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  receive(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }
    switch (message.type) {
      case "session.updated":
        this.opened = true;
        this.resolveReady();
        return;
      case "input_audio_buffer.committed": {
        const seq = this.commits.shift();
        if (seq !== undefined && message.item_id)
          this.sequences.set(message.item_id, seq);
        return;
      }
      case "conversation.item.input_audio_transcription.delta":
        this.onDelta({
          seq: this.sequences.get(message.item_id) ?? null,
          delta: typeof message.delta === "string" ? message.delta : "",
        });
        return;
      case "conversation.item.input_audio_transcription.completed": {
        const seq = this.sequences.get(message.item_id) ?? null;
        this.sequences.delete(message.item_id);
        this.onCompleted({
          seq,
          transcript: typeof message.transcript === "string" ? message.transcript.trim() : "",
        });
        return;
      }
      case "conversation.item.input_audio_transcription.failed":
        this.sequences.delete(message.item_id);
        this.onFailure(
          message.error?.message
            ? `Transcription failed: ${message.error.message}`
            : "OpenAI could not transcribe this speech segment.",
        );
        return;
      case "error":
        this.onFailure(
          typeof message.error?.message === "string"
            ? `Transcription failed: ${message.error.message}`
            : "OpenAI reported a speech stream error.",
        );
        return;
      default:
        return;
    }
  }

  append(bytes) {
    if (!bytes?.byteLength || this.closed) return;
    this.send({
      type: "input_audio_buffer.append",
      audio: Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength).toString("base64"),
    });
  }

  commit(seq = null) {
    if (this.closed) return;
    this.commits.push(seq);
    this.send({ type: "input_audio_buffer.commit" });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;
    try {
      this.socket.close();
    } catch {
      // The socket already closed; nothing to clear.
    }
  }
}
