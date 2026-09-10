# Live Translate

Live speech transcription and sentence-by-sentence translation, with a Vite/TypeScript/Ant Design browser interface and an Electron app for macOS and Windows.

## Browser

Requires Node.js 22.12+ and npm.

```sh
npm install
npm run dev
```

Open **http://localhost:6005**. Vite uses port **6005**; the browser API runs on `127.0.0.1:6006`. Both start with one command. No `.env` is required: open **Connections** to configure the model servers.

## Desktop

```sh
npm install
npm run desktop
```

This builds the frontend and Electron main process, then opens the desktop app. Electron downloads its development binary on first launch if needed. The app starts its own API on an available loopback port; no Vite server or separate terminal is needed to use a packaged app. Browser and desktop modes can run together.

The desktop app opens **Connections** on first launch. It has a separate profile from the browser and does not import `.env` or package it into an installer. On macOS, closing the window leaves the app available in the Dock; Quit ends the local API as well. On Windows, closing the window exits the app.

## Connections

Set these separately for **Speech recognition (ASR)** and **Translation (LLM)**:

- **API base URL**, including its prefix, such as `http://localhost:8000/v1`.
- **Model ID**, for example `Qwen3-ASR-1.7B-bf16` and `Qwen3.5-35B-A3B-4bit`.
- **API key**, optional for endpoints without authentication.

**Test connection** calls the endpoint's `/models` route and checks whether the model is listed. This does not test inference. Servers without model-list support can still be saved. Changes take effect on the next request without restarting; settings cannot be edited through the UI while capture or queued work is active.

Existing keys are never returned to the interface. Leave the field blank to retain a saved key at the same URL, or use **Remove saved API key**. Changing the URL clears the old key unless you enter a key again, so the previous server's credentials are not sent to a new server.

Desktop settings are encrypted with Electron `safeStorage` and saved to `connections.enc` in the operating system's application-data directory (normally `~/Library/Application Support/Live Translate` on macOS and `%APPDATA%/Live Translate` on Windows). The renderer has no Node access; an authenticated local API handles model requests. If OS encryption is unavailable, saving fails rather than writing plaintext.

Browser settings are saved by the Node server in `.local/settings.json`, with owner-only file permissions where supported. This browser-mode file contains plaintext keys and is gitignored. `SETTINGS_FILE` changes its path. An existing `.env` supplies initial defaults, but saved UI settings take precedence. `.env` itself is not modified. Restart the server after changing `.env`; no key should use a `VITE_` prefix.

## Use

1. Choose a microphone. In a browser, **Browser tab** captures a tab after you enable **Share tab audio**. In Electron, **Desktop audio** opens a system/screen picker. Only audio is processed and uploaded, even though the capture API also supplies a video track.
2. Select source languages: empty means auto-detect, one selection fixes the language, and multiple selections send detection hints. Support for hints depends on the ASR server.
3. Select up to five translation languages and click **Start listening**. Allow microphone access when prompted.
4. Pause briefly between sentences. **Stop listening** releases capture and finishes queued work. Failed segments and translations can be retried.
5. Copy or export before clearing or closing. Transcripts are kept in memory, not saved automatically. The model server may maintain its own logs.

Microphone capture works in browser and desktop modes. System/tab audio depends on the browser, OS, and permissions. For packaged macOS apps the microphone and system-audio usage descriptions are included. The native screen picker is available on macOS 15+; a screen-selection dialog is used otherwise. Older macOS versions or unavailable system audio may require a virtual input device. See [Electron's capture requirements](https://www.electronjs.org/docs/latest/api/desktop-capturer) and [picker support](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts).

## Desktop packages

```sh
# Unpacked app for the current platform
npm run pack:desktop

# macOS DMG, Apple Silicon and Intel (build on macOS)
npm run dist:mac

# Windows NSIS installer, x64 and ARM64 (build on Windows)
npm run dist:win
```

Outputs go to `release/`. Packaging includes only the compiled app and runtime dependencies, excluding `.env`, connection profiles, recordings, and reports. The manually triggered **Desktop packages** GitHub Actions workflow builds on native macOS and Windows runners and stores the installers as workflow artifacts; it does not publish a release.

For local unsigned macOS packaging use `npx electron-builder --mac --arm64 --publish never -c.mac.identity=null` after `npm run build:desktop`. Public distribution requires your Apple/Windows signing configuration; macOS notarization and Windows signing are not configured here. Native Windows behavior must be verified on a Windows machine even when cross-building its installer from macOS.

## Processing

- An AudioWorklet captures mono PCM. Energy-based speech detection keeps 250 ms of pre-roll, skips silence, and ends an utterance after an adjustable pause (default 800 ms).
- Each request is an independently decodable 16 kHz PCM WAV. Continuous speech is divided at 12 seconds to bound latency and memory; there is no overlapping audio to duplicate words.
- ASR requests go to `/audio/transcriptions` appended to the configured base URL; include `/v1` in the base URL when the server requires it. Native provider streaming is not required.
- `Intl.Segmenter` separates returned sentences, including Chinese punctuation. An incomplete final sentence is held across forced audio boundaries, then flushed on a pause or stop. Long unpunctuated text is bounded at 1,200 characters. Audio boundaries can still cut words; this is near-live chunked transcription, not token-level streaming or forced alignment.
- Each sentence goes to `/chat/completions` for the selected targets. Target requests run concurrently, sentences remain ordered, and model thinking is disabled to reduce latency. Actual latency depends on model loading, inference speed, and network conditions.
- If twelve audio segments accumulate, capture stops automatically and pending work finishes. Energy detection is adjustable and may need tuning for noisy radio audio. Timestamps refer to approximate capture segments, not exact word alignment. ASR retries translate the recovered segment as a single card.

## Browser support

Microphone capture requires a secure context: localhost or HTTPS, plus AudioWorklet support. Current Chrome, Edge, Firefox, and Safari support microphone capture. Browser-tab audio capture is best used in Chrome or Edge; available audio sources vary by browser and operating system. If no audio track is shared, the UI explains how to fix it. This local POC binds to loopback and does not enable remote network access.

## Debug latency

See [the measured latency report](docs/latency-verification.md) for the initial capture-only, controlled-delay, and real Qwen verification results.

Open **Latency diagnostics** below the transcript. Enable **Capture only**, click **Start listening**, say a sentence and pause. The audio segment table should show a `silence` cut after about 800 ms (plus at most one audio packet). This mode runs the same microphone, AudioWorklet, speech detection, and WAV encoding, but sends **no ASR or LLM requests**. Stop, turn capture only off, and repeat to compare processing time. The toggle is locked during a running session.

The panel shows input RMS versus the speech threshold, buffered audio, current silence, microphone startup time (including permission), first packet latency, and the largest packet delivery gap. Segment and translation tables separate:

- **Pause wait:** silence below the threshold before a segment closes. Sustained noise above the threshold can prevent closure until the 12-second `limit` cut. “Speech” means above-threshold energy, not semantic voice detection.
- **WAV encode:** local audio conversion time.
- **Queue wait:** time after audio is ready before ASR starts. The current pipeline waits for all translations of the previous segment before processing the next segment.
- **ASR/LLM request:** elapsed browser request time, including upload/response handling.
- **Provider:** elapsed time measured by the local API around the remote request, exposed through `Server-Timing`. It includes remote network, server queues/model loading, and inference; it cannot distinguish these without model-server instrumentation.
- **Wait after ASR:** time before a sentence's translation starts, including earlier sentence translations or waiting for the rest of an incomplete sentence.
- **After speech end:** estimated delay from the final above-threshold PCM packet to the processed translation response. It excludes subsequent browser painting. Packet delivery gaps are reported separately; physical microphone/driver latency is not directly measured.

**Export timings** downloads a JSON trace with settings and model names, without audio or transcript text. Each Start resets the trace; up to 200 segments and 500 translation attempts are retained. Failed ASR retries retain the original segment trace; their subsequent translation attempts are recorded separately, so retry totals include the time spent waiting to retry.

Reproduce the automated checks with the dev server running (`npm run dev`) and Chromium installed (`npx playwright install chromium`):

```sh
# Three known signals and pauses through Chromium's fake microphone, with no model calls.
npm run debug:latency -- --mode capture

# Same capture path, with 100 ms mock ASR and 1.8 s mock translations to reveal queue growth.
npm run debug:latency -- --mode mock

# Actual Qwen endpoints using a spoken PCM WAV as the fake microphone input.
# Include pauses >800 ms, use a recording longer than the speech plus the pause,
# and choose --seconds long enough to include the speech you want to measure.
npm run debug:latency -- --mode live --audio /absolute/path/speech.wav --seconds 10
```

The command saves JSON and a screenshot under `debug-reports/`; `--output` changes the JSON path. `--url` defaults to `http://127.0.0.1:6005`. Avoid editing frontend files during a run: Vite reloads reset in-memory traces. These checks use generated/file audio through browser capture, **not a physical microphone**, so use Capture only with your own microphone to verify device and room-noise behavior.

## Build and checks

```sh
npm run build
npm test
npx playwright install chromium
npm run test:e2e
npm run test:desktop
```

To serve the built frontend on port 6005, run `npm start` in one terminal and `npm run preview` in another. The API also serves `dist/` at port 6006 after building. Preview is for local use.

Tests cover WAV encoding, speech boundaries, multilingual sentence buffering, API contracts/validation, credential isolation, partial translation failure, and browser microphone capture with mocked model responses. Browser tests use Chromium's synthetic microphone, never a real microphone. Real model availability and accuracy require the configured model server.

Desktop checks launch Electron with an isolated temporary profile and synthetic microphone. They verify endpoint configuration, encrypted persistence across restart, renderer isolation, API authentication, and capture-only audio.

Reference docs: [Vite server options](https://vite.dev/config/server-options), [Ant Design Select](https://ant.design/components/select/), [Qwen3-ASR languages](https://github.com/QwenLM/Qwen3-ASR), and [browser audio sharing](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia).
