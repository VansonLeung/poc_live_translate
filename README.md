# Maritime Live Translate

Vite + React + TypeScript + Ant Design browser UI with a local Node API. Uses `Qwen3-ASR-1.7B-bf16` for speech recognition and `Qwen3.5-35B-A3B-4bit` for sentence translation through your configured compatible endpoints.

## Run

Requires Node.js 22.12+ and npm.

```sh
npm install
# Only if .env does not already exist:
cp .env.example .env
# Fill in your server URLs and API keys in .env.
npm run dev
```

Open **http://localhost:6005**. Vite uses port **6005** with strict port checking; the API binds to `127.0.0.1:6006`. Both start with `npm run dev`. Restart after changing `.env`. Credentials stay on the API server and are never included in Vite's client configuration. Do not prefix secrets with `VITE_`.

## Use

1. Choose a microphone, or select **Browser tab**, choose a tab in the browser sharing dialog, and enable **Share tab audio**. The browser also grants a video track for tab sharing; this app processes and uploads only audio.
2. Choose source languages. Empty means automatic detection. One selection sends the ASR `language` parameter. Multiple selections leave ASR in automatic detection and send a `prompt` containing language hints; they are not a strict allowlist. Support for `language` and `prompt` depends on your ASR server version.
3. Select one to five translation languages, then click **Start listening**. Microphone permission is requested on start.
4. Speak and pause briefly between sentences. Transcripts appear with a separate translation for each selected language. **Stop listening** releases capture and finishes queued work. Failed audio stays in memory for retry. Translation errors can also be retried.
5. Copy or export the transcript before clearing or refreshing. Audio, transcripts, and translations are not saved to disk by this app. The external model server may have its own logging behavior.

## Processing

- An AudioWorklet captures mono PCM. Energy-based speech detection keeps 250 ms of pre-roll, skips silence, and ends an utterance after an adjustable pause (default 800 ms).
- Each request is an independently decodable 16 kHz PCM WAV. Continuous speech is divided at 12 seconds to bound latency and memory; there is no overlapping audio to duplicate words.
- ASR requests go to `/v1/audio/transcriptions` relative to the configured base URL (the example base URLs already include `/v1`). Native provider streaming is not required.
- `Intl.Segmenter` separates returned sentences, including Chinese punctuation. An incomplete final sentence is held across forced audio boundaries, then flushed on a pause or stop. Long unpunctuated text is bounded at 1,200 characters. Audio boundaries can still cut words; this is near-live chunked transcription, not token-level streaming or forced alignment.
- Each sentence goes to `/chat/completions` for the selected targets. Target requests run concurrently, sentences remain ordered, and model thinking is disabled to reduce latency. Actual latency depends on model loading, inference speed, and network conditions.
- If twelve audio segments accumulate, capture stops automatically and pending work finishes. Energy detection is adjustable and may need tuning for noisy radio audio. Timestamps refer to approximate capture segments, not exact word alignment. ASR retries translate the recovered segment as a single card.

## Browser support

Microphone capture requires a secure context: localhost or HTTPS, plus AudioWorklet support. Current Chrome, Edge, Firefox, and Safari support microphone capture. Browser-tab audio capture is best used in Chrome or Edge; available audio sources vary by browser and operating system. If no audio track is shared, the UI explains how to fix it. This local POC binds to loopback and does not enable remote network access.

## Debug latency

See [the measured latency report](docs/latency-verification.md) for the initial capture-only, controlled-delay, and real Qwen verification results.

Open **Latency diagnostics** above Session setup. Enable **Capture only**, click **Start listening**, say a sentence and pause. The audio segment table should show a `silence` cut after about 800 ms (plus at most one audio packet). This mode runs the same microphone, AudioWorklet, speech detection, and WAV encoding, but sends **no ASR or LLM requests**. Stop, turn capture only off, and repeat to compare processing time. The toggle is locked during a running session.

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
```

To serve the built frontend on port 6005, run `npm start` in one terminal and `npm run preview` in another. The API also serves `dist/` at port 6006 after building. Preview is for local use.

Tests cover WAV encoding, speech boundaries, multilingual sentence buffering, API contracts/validation, credential isolation, partial translation failure, and browser microphone capture with mocked model responses. Browser tests use Chromium's synthetic microphone, never a real microphone. Real model availability and accuracy require the configured model server.

Reference docs: [Vite server options](https://vite.dev/config/server-options), [Ant Design Select](https://ant.design/components/select/), [Qwen3-ASR languages](https://github.com/QwenLM/Qwen3-ASR), and [browser audio sharing](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia).
