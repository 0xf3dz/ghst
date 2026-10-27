# Ghst

A local desktop assistant for thesis-defense questions. The app window and packaged executable use the name `Ghst`.

## Features

- System audio capture for a Zoom call through the desktop app.
- Microphone or virtual loopback input as a second audio source.
- Speech transcription with `gpt-4o-transcribe` or `gpt-4o-mini-transcribe`.
- ChatGPT subscription answers through your installed `omp` and its `openai-codex` connection.
- Local PDF text extraction and search, with source passages and PDF page numbers.
- Full Markdown skill instructions in each answer request.
- Streamed answers, manual questions, and optional automatic answers after speech segments.
- Saved transcripts and questions for later discussion.
- Markdown export, a compact view, and a desktop window that stays on top.

The interface follows the reference-library, transcript, and answer workflow of [Natively](https://github.com/Natively-AI-assistant/natively-cluely-ai-assistant). This application contains an independent implementation. It does not include Natively code, branding, a hidden window, or process disguise.

## Requirements

- Node.js 22.12 or later.
- An OpenAI API key with API credit for transcription and automatic answer fallback.
- An installed `omp` with a ChatGPT sign-in for subscription answers.
- macOS 14.2 or later for native system audio capture. Windows supports Electron loopback capture. Linux requires a virtual loopback or monitor input.
- Xcode Command Line Tools with the macOS 15 SDK or later to build the Zoom audio helper. The packaged app includes this helper.
- A searchable thesis PDF. Image-only PDFs require optical character recognition (OCR) before upload.

The default answer connection uses your ChatGPT plan's Codex allowance through `omp`. If the subscription fails or reaches a limit, Ghst automatically answers through the OpenAI API. This fallback and transcription incur API charges. Select the API answer and fallback model in Settings.

## Start the application

Run these commands in this directory:

```sh
npm install
npm run desktop
```

The first command installs the application dependencies. The desktop command downloads the native Electron runtime if necessary. It starts a server on a random loopback port and opens the application window.

On macOS, the source-launch script adds capture descriptions to this project's installed Electron bundle. It does not modify your terminal or system applications. macOS can attribute source-launch audio permissions to your terminal or editor. For a separate application identity, use the standalone app below.

Do not run two application instances with the same data directory. Each instance maintains its own copy of the saved state.

## Create a standalone macOS app

Run:

```sh
npm run package:mac
```

On Apple Silicon, open this application from Finder:

```text
dist/Ghst-darwin-arm64/Ghst.app
```

On an Intel host, the output directory ends with `darwin-x64`. The build uses the host architecture. This local app has no Developer ID signature or notarization. Do not use this command to prepare a public release.

## Configure a defense session

1. In your terminal, run `omp login openai-codex` and complete the browser sign-in.
2. Open Settings with the gear button or the connection button.
3. Select `ChatGPT subscription through omp` and select `Check connection`.
4. Enter your OpenAI API key for transcription and select a transcription model.
5. If necessary, enter a transcription language code such as `en` or `pt`.
6. Save the settings.
7. Select `Add files` in the context library and attach your PDF.
8. Attach your Markdown skill files.
9. Select an audio source.
10. Select `Start listening`.

The `skills/` directory includes two optional files:

| File                        | Purpose                                                                   |
| --------------------------- | ------------------------------------------------------------------------- |
| `defense-answers.md`        | Concise answers, research decisions, limitations, and follow-up questions |
| `evidence-and-citations.md` | Source citations, numerical accuracy, and unsupported claims              |

The application applies each attached Markdown file as instructions. Attach only files that you trust. To replace a reference, remove its old copy and attach the new file.

## ChatGPT connection through omp

Ghst calls your installed `omp` in non-interactive mode. It selects only the `openai-codex` provider for subscription answers. This provider uses your ChatGPT sign-in. It differs from the `openai` API provider. You do not need the Codex CLI for this connection.

Run `omp login openai-codex` in your terminal to connect your account. Ghst does not copy your authentication tokens into its state or expose them to the interface. Your ChatGPT plan must include Codex access. The plan's rate limits and account policies apply.

`Check connection` checks installed model availability and stored OAuth account metadata. It does not make a paid model request or prove that the current quota permits a new answer. The first answer verifies online access.

The settings panel separates the answer connection from the transcription API key. You can ask a typed question through your subscription without an API key. Audio transcription still requires that key.

Ghst passes the selected PDF passages, Markdown instructions, and recent conversation to omp. It disables tools, extensions, ambient context files, and session persistence for these requests. The app does not open a second interactive omp window.

The default model is `openai-codex/gpt-6-sol`, available in the installed omp model list. To select another model, use its exact ID from `omp models openai-codex`.

Ghst starts each subscription answer in a temporary empty directory. It excludes inherited API credentials and disables fallback inside omp. The application handles API fallback separately. omp still adds its generated workstation and project information to the system prompt.

Each queued question retains its answer connection. If you change that connection before the request starts, Ghst rejects the question. Send the question again with the selected connection.

The installed omp executable remains an external dependency. Install or update omp through your normal installation method. The packaged Ghst app does not bundle or replace omp. Select `Check connection` after you sign in or update omp.

If the subscription fails, Ghst uses your saved API key and API answer model. If the key is missing, add it in Settings. If a subscription answer fails after text appears, Ghst replaces that partial text with the API answer. Cancellation does not start API fallback.

## Capture Zoom audio

### Zoom output only on macOS

1. Open the Zoom desktop app and join the call with computer audio.
2. Select `Zoom output only` in Ghst.
3. Select `Start listening`.
4. Grant Screen & System Audio Recording permission to Ghst when macOS requests it.
5. If macOS requires a restart, quit and reopen Ghst.
6. Play remote speech through Zoom and check the input meter and transcript.

This mode selects only Zoom application processes through ScreenCaptureKit. It does not open the local microphone or capture other applications. It stops with an error if Zoom is unavailable. It does not switch to microphone or all-system capture.

Remote participants can return your voice as an echo in Zoom output. Use headphones and Zoom echo cancellation to reduce that echo. Application selection cannot remove a voice that is already part of remote audio.

### All system audio

Select `All system audio` only when you want audio from all applications. This separate mode uses Electron loopback capture. Other applications and microphone monitoring can enter its transcript.

### Microphone or virtual loopback input

1. Select `Microphone / audio device`.
2. Select the input device.
3. Select `Start listening`.
4. Grant microphone permission when requested.

A microphone does not directly capture remote Zoom participants. For direct call audio, select a virtual loopback input and route Zoom output to that device. Configure an additional output if you also need to hear the call.

### Browser mode

Run:

```sh
npm start
```

Open `http://127.0.0.1:3210`. A browser can capture only the audio sources that its share dialog supports. For Zoom in a browser, select the Zoom tab and enable audio. The `Zoom output only` mode requires the macOS desktop app. Otherwise, route only Zoom output to a dedicated virtual audio input.

## Answer questions

- Type a question and select the arrow button.
- Use Command+Enter on macOS, or Control+Enter on other systems, to send it.
- Select `Answer this` below a transcript entry to answer that entry.
- Select `Use latest` to edit the latest transcript before you send it.
- Enable `Auto-answer` to answer each complete speech segment from the selected source.
- Select a source below an answer to inspect its passage and PDF page.
- Select `Export session` to save the transcript and answers as Markdown.
- Open an earlier session to ask follow-up questions after the defense.

The `War room` workspace creates each new session with the name `Intel` and the current local date. Existing session names remain unchanged.

Auto-answer is off by default. It processes speech segments, not speaker identities or confirmed jury questions. Pauses can divide a question into multiple segments. All speech from the selected source counts. For more control, keep auto-answer off and edit the question before you send it.

The audio processor detects speech energy and waits approximately 1.15 seconds after a pause. It also divides continuous speech at approximately 22 seconds. It sends each segment as a complete mono WAV file. These are successive transcription requests, not token-by-token realtime transcription. The application stops capture if the transcription queue cannot keep up and reports the problem.

The compact view hides the transcript. Enable auto-answer in the full view before you use compact mode if you want automatic answers. The menu button still opens the context library. The pin button requires desktop mode.

## Reference limits

| Item                    | Limit or behavior                                               |
| ----------------------- | --------------------------------------------------------------- |
| PDF upload              | 100 MiB per file; eight files per request                       |
| PDF extraction          | 10,000 pages and 50 million extracted characters per file       |
| PDF evidence per answer | Up to six passages, each up to 1,600 characters                 |
| Markdown skill          | 32,000 characters per file; 64,000 characters across all skills |
| Additional instructions | 16,000 characters                                               |
| Audio request           | Complete WAV file, at most 24 MiB and 120 seconds               |
| Answer history          | Up to twelve previous messages within a 24,000-character budget |
| Transcript context      | Most recent 12,000 characters                                   |
| Saved sessions          | Up to 200; export and remove old sessions as necessary          |

PDF search uses local BM25 lexical search. It does not require a paid embedding service or an upstream file store. It indexes all extracted pages and adds abstract, conclusion, or limitation passages for broad questions. Short follow-up questions also use the preceding question for retrieval.

The model receives selected passages, not the complete PDF. Search can miss synonyms, image content, equations, or evidence spread across many pages. A source list identifies retrieved passages; it does not prove that every generated claim follows from them. Check each answer against the thesis. Page numbers refer to the physical PDF page, which can differ from the printed page label.

## Local data and privacy

The default data directory is `~/.thesis-assistant`. Set `THESIS_DATA_DIR` before launch to use another directory. The directory contains the saved state, reference originals, extracted text, and temporary uploads.

The server listens on `127.0.0.1` only. It rejects cross-origin requests and unrecognized host headers. It does not return the saved API key through the state endpoint.

The saved API key resides in `state.json`. The application restricts the directory to mode `0700` and saved files to `0600`. The key is not encrypted at rest. Do not share or commit this directory. Other processes under your user account can read it. Use `OPENAI_API_KEY` if you do not want the app to save a key. The environment key takes precedence over a saved key.

The application sends these data to OpenAI:

- Audio speech segments for transcription.
- Your current question and bounded conversation context.
- Retrieved PDF passages.
- All attached Markdown skill instructions and additional instructions.

The application does not upload the original PDF to an OpenAI file store. It deletes temporary audio after each request. It saves transcripts and answers locally until you delete the session. Removing a saved key does not remove an environment key.

Stop audio capture before you change or delete a session. Wait for pending requests. Quit the application before you back up or remove its data directory.

## Verification

Run the regression suite:

```sh
npm test
```

The suite covers PDF passage boundaries, late-page retrieval, follow-up context, source coverage, reference removal, and complete WAV validation. Subscription checks cover provider separation, incomplete streams, cancellation, timeouts, and process cleanup.

Local integration checks exercised a generated 180-page PDF, retrieval from page 141, reference persistence after restart, Markdown export, protected key storage, and cross-origin rejection. Browser checks exercised streamed answers, source display, automatic answers, a synthetic audio input through the AudioWorklet/WAV path, and the pending-transcript session guard. These checks used a local OpenAI protocol fixture, not real model inference.

The standalone macOS app also launched successfully. Its compact resize and always-on-top controls worked. A live Zoom call still requires an API key for transcription and operating-system capture permission.

A live omp check answered from an attached test PDF through `openai-codex/gpt-6-sol`. No saved or environment API key was present for that answer. The local API fixture recorded no API answer request. The separate transcription check used a local fixture, not real transcription.

Browser checks verified the selected-model check and saved settings for each provider. The rebuilt macOS app opened with ChatGPT through omp as its default answer connection and detected the configured sign-in.

The updated fallback checks exercise quota failures, partial-answer replacement, missing keys, cancellation, client disconnects, and saved answer history. An HTTP smoke check and a browser check verified the replacement answer and API charge notice with local provider fixtures.

A real API request with reference evidence and a revised answer skill produced an answer without an irrelevant evidence-gap sentence. The native Zoom helper compiled and its missing-Zoom error path stopped without microphone capture. A live Zoom capture remains unverified.
