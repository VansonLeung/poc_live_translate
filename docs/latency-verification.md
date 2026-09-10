# Live translation latency verification

Measured on 2026-09-10 using the built frontend, its local API, and the configured Qwen endpoints. The dominant delay in this sample was the ASR provider request, followed by queued work. Browser speech segmentation closed at the expected pause interval.

## Real model run

Chromium consumed a generated English speech WAV through its `getUserMedia` microphone path, including the AudioWorklet, speech detection, WAV conversion, and normal request queue. Input sentences were “The vessel is approaching the harbour.” and “Please stand by for further instructions.” with a pause between them. Source language: English. Translation targets: English and Traditional Chinese. Both sentences finished successfully.

Models: `Qwen3-ASR-1.7B-bf16` and `Qwen3.5-35B-A3B-4bit`.

| Stage | Segment 1 | Segment 2 |
| --- | ---: | ---: |
| Captured audio length | 2.603 s | 2.987 s |
| Silence required to close segment | 0.811 s | 0.811 s |
| Local WAV encoding | 2.3 ms | 1.0 ms |
| Queue before ASR | 0.2 ms | 7.657 s |
| ASR browser request | 9.190 s | 17.528 s |
| ASR provider request, measured by local API | 9.170 s | 17.525 s |
| Translation browser request, both targets | 2.035 s | 1.335 s |
| Translation provider requests, elapsed until both finish | 2.014 s | 1.333 s |
| Translation ready after estimated speech end | 12.046 s | 27.333 s |

Microphone setup took 54 ms with automated permission granting; the first PCM packet followed in 44 ms. Packets contained approximately 43 ms of audio and the largest delivery gap was 52 ms. There were no 12-second forced cuts, browser errors, or failed model responses.

The ASR provider measurements account for almost the entire browser ASR request duration. Audio capture and encoding therefore do not explain the multi-second delay in this run. The provider measurement includes remote networking, server queueing, model loading, and inference; it is not a measurement of inference alone.

The pipeline serializes ASR plus all translations for each segment. Segment 2 was captured while segment 1 was still being processed, explaining its additional 7.657-second queue wait. Translation responses also wait for every selected target to finish.

## Isolation checks

- Capture only, with three known tone bursts and pauses: all three closed after 811 ms of silence, with zero ASR or translation requests. WAV encoding took approximately 1–2 ms.
- A controlled slow-provider test uses 100 ms mock ASR responses and 1.8-second mock translation responses. Each transcript contains two sentences, so translation of one segment takes roughly 3.6 seconds. Capture still closes after 811 ms, while queue wait grows for subsequent segments. This reproduces sluggish output without slowing microphone processing. See the current `slow-llm.json` report for exact measurements.
- A second capture-only run uses the same generated speech WAV as the real-model run, allowing a direct comparison without provider calls. See `capture-speech.json`.

Reports and screenshots are saved locally in [debug-reports](../debug-reports/): [real Qwen trace](../debug-reports/live-qwen.json), [speech capture only](../debug-reports/capture-speech.json), [tone capture only](../debug-reports/capture.json), and [slow translation control](../debug-reports/slow-llm.json). This directory is gitignored; exported reports are local artifacts.

## Check your actual microphone

1. Open **Latency diagnostics** at http://localhost:6005 and enable **Capture only**.
2. Start listening, speak one sentence, and remain quiet for at least a second.
3. Confirm a `silence` segment with about 800–843 ms pause wait. If segments repeatedly end with `limit` near 12 seconds, watch the RMS: room/radio noise may be above the 0.012 threshold and resetting the silence timer. Adjust the threshold under Audio fine-tuning and repeat.
4. Stop, disable Capture only, repeat, and compare queue, ASR, and LLM columns. Export timings before starting another session.

These automated checks use file/synthetic audio through browser microphone capture. They cannot rule out physical microphone drivers, Bluetooth buffering, permissions delays, or your room's noise floor. The sample also does not establish typical provider latency under other loads or model cache states. Speech end is estimated from above-threshold audio energy; browser painting after response handling is not included.

## Next performance investigation

Inspect the ASR server's request queue, model load/unload logs, and inference timings first. In particular, verify whether alternating ASR and LLM requests causes model reloads; the client timing cannot prove that. Separating ASR and translation queues could reduce client queue wait, but would not remove the measured 9–18 seconds spent on an individual ASR provider request. No queue or model behavior was changed for this diagnosis.

Reproduction commands and timing definitions are in [README.md](../README.md#debug-latency). The probe saves its report before reporting model errors, making failed runs inspectable too.
