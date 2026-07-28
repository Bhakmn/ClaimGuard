# Visual Copyright Detection in ClaimGuard

## 1. Legal framing

Copyright liability for on-screen content is not gated on duration. Platforms' Content ID-style systems match on very short recognisable segments — a few seconds of a film, a broadcast logo in the corner of a frame. There is no legally "safe" duration for third-party footage.

Fair use (in US law) is a case-by-case defence weighing four factors: purpose and character of use (transformation), nature of the copyrighted work, amount and substantiality of the portion taken, and effect on the potential market. A software tool cannot adjudicate those factors.

**This system's job is to flag candidates for human review — never to auto-declare something "safe" or "infringing".** Every flag is labelled "Possible copyright" and the panel copy reflects this: users toggle and delete flags; they are not blocked from exporting.

---

## 2. Research: what signals correlate with third-party footage

The following visual signals were identified as heuristic indicators that a time range may contain footage the creator did not film themselves:

| Signal | Reliability | Implemented |
|---|---|---|
| Letterboxing / pillarboxing (black bars indicating a different aspect ratio) | Medium–high | ✓ heuristic |
| Aspect-ratio anomaly (>2.55 width/height = cinematic; <0.4 = portrait-in-landscape) | Medium | ✓ heuristic |
| Platform watermarks / channel bugs (Netflix, HBO, Disney+, broadcast "N" etc.) | High | ✓ via Granite Vision |
| Subtitle / caption burn-in with typography inconsistent with the creator's style | Medium | ✓ via Granite Vision |
| Screen-recording chrome (phone status bar, browser UI, cursor) | High | ✓ via Granite Vision |
| Resolution / compression-artifact mismatch at cut boundaries | Low (many false positives) | — not implemented |
| Distinct colour grading discontinuity | Low–medium | — not implemented |
| Game HUD overlays | Medium | ✓ via Granite Vision |
| Title / credit cards revealing a source ("S02E04", studio logo) | High | ✓ via Granite Vision |
| Scene-style discontinuity at a cut point | Low | — not implemented |

---

## 3. Whether a real fingerprint-match path is feasible

### ACRCloud Video / Broadcast Monitoring

ACRCloud offers a **Broadcast Monitoring** product that includes video fingerprinting against a database of films, TV programmes, and broadcast content. Assessment:

- **Not available on standard ACRCloud plans.** The audio fingerprinting product (already integrated) is on a self-service API. The video fingerprinting product requires a custom enterprise contract with ACRCloud sales.
- **No public API documented.** There is no publicly documented REST endpoint, authentication scheme, or SDK for the video fingerprinting service; all documentation is behind an NDA-signed partnership agreement.
- **Conclusion: not licensable in scope.** This feature therefore ships without a database fingerprint-match path for visual content.

If ACRCloud Video Monitoring becomes accessible, the service module [`server/src/services/vision.ts`](../server/src/services/vision.ts) is structured to accept a second upstream call (same semaphore + circuit breaker pattern) as a first-pass before the heuristic + Granite Vision pipeline.

**Important implication:** Because there is no fingerprint database, this feature flags *categories of likely third-party footage*, not identified works. It cannot tell you "this is a clip from Season 2 Episode 4 of Show X" — it can tell you "this looks like broadcast TV footage." That distinction must be clear to the user. The UI reflects it: flags say "Possible copyright · Film or TV clip" not "Identified as [title]."

---

## 4. IBM model selection

### Which models were evaluated

| Model | Considered for | Decision |
|---|---|---|
| **Granite Vision 3.2 2B (`ibm/granite-vision-3-2-2b`)** | Frame classification, logo/watermark detection, reasoning over "is this third-party footage?" | **Selected.** IBM's compact vision-language model (VLM) on watsonx.ai. Accepts image + text prompt, returns structured JSON. |
| `ibm/granite-3-2-8b-instruct` (text-only) | Text classification | Rejected. Text-only instruct model — cannot process frame pixels at all. Supplying image data to this model returns garbage or errors. |
| Granite 3.x text-only family | Text classification | Rejected. No vision capability — cannot process frame pixels. |
| Granite Guardian | Content safety / bias detection | Rejected. Designed for content moderation, not copyright-risk detection. |
| watsonx.governance (AI Factsheet / OpenScale) | Audit trail of model decisions per flag | Considered — see §6 below. |

### Why Granite Vision 3.2 2B

The task is a **multimodal vision task**: given a 640×N JPEG frame, determine whether it contains visual signals of third-party footage. This requires the model to:

1. Understand pixel-level features (bars, watermarks, UI chrome).
2. Reason about them in natural-language context.
3. Return a structured confidence score and per-signal explanation.

Only a multimodal model can do this. `ibm/granite-vision-3-2-2b` is IBM's compact VLM on watsonx.ai: a 2-billion-parameter vision-language model that accepts image + text prompts and returns structured text output.

**What "compact VLM" means for accuracy:** Granite Vision 3.2 2B is significantly smaller than frontier models like GPT-4o or Claude 3.5 Sonnet. For ClaimGuard's use case this is an acceptable trade-off: we are asking the model to recognise *categories* of footage (letterboxing, watermarks, UI chrome) rather than identify specific works, and the categories are visually distinctive. A larger model would improve accuracy on ambiguous frames but at substantially higher cost and latency per frame. The confidence threshold (40%) is intentionally conservative to counteract the model's limitations on ambiguous content.

### Why the prompt constrains to a closed taxonomy

An unconstrained prompt would produce free-text labels ("Movie clip", "Film footage", "Cinematic scene") that differ frame-to-frame even for identical footage, fragmenting what should be one span into many. The prompt requires the model to pick **exactly one** category from a fixed list (`film_or_tv`, `sports_broadcast`, `news_broadcast`, `music_video`, `video_game`, `screen_recording`, `social_media_repost`, `advertisement`, `other_third_party`). Category strings are validated server-side and default to `other_third_party` on any out-of-vocabulary response. Span merging operates on this stable category key.

Free-text `reasoning` and `signals` fields are preserved as-is — these are what make a flag reviewable by the user.

---

## 5. watsonx.governance and the per-flag audit trail

watsonx.governance (IBM OpenScale / AI Factsheet) can attach a per-inference audit record — capturing model input, output, confidence, and timestamps — to a ledger queryable by compliance teams.

**Decision for this submission:** watsonx.governance is not wired in.

**Why this is a genuine trade-off, not an oversight:** ClaimGuard's flags are presented as candidates for human review, not automated enforcement decisions. An audit trail matters most when the model output *directly* drives an irreversible action (blocking content, filing takedown notices). Here, the user makes the final call. The `reasoning` field already captures the model's explanation in the flag record; connecting that to a governance ledger would require:
1. Registering a model deployment on IBM OpenScale and obtaining a data mart `subscription_id`.
2. Sending a `PayloadLoggingRecord` to the OpenScale REST API after each Granite Vision inference call — approximately 15 lines added to `callGraniteVisionOnce` in `vision.ts`.
3. Adding `OPENSCALE_SUBSCRIPTION_ID` to the environment configuration.

Total wiring: roughly a half-day of work. If a production deployment of ClaimGuard needs a per-flag compliance ledger — e.g., to demonstrate due diligence to a platform or legal counsel — this is the natural place to add it.

---

## 6. Architecture: data flow

```
Client (browser)
  │
  │  1. realVisualScanService.scan()
  │     ├─ One HTMLVideoElement per media item (seeked repeatedly — O(1) per frame)
  │     ├─ Sample at 2 s intervals (not 1 fps) — halves upstream call count
  │     ├─ Scene-change filter: compare 16×9 luma histogram to previous frame
  │     │   └─ Near-identical frames inherit previous verdict (no upstream call)
  │     ├─ Concurrent batch: 3 frame requests in parallel per batch
  │     └─ identifyFrame(blob, width, height) → POST /api/identify-video
  │
  │  2. POST /api/identify-video  (server)
  │     ├─ Content-type gate (must be multipart/form-data)
  │     ├─ Stream multipart, byte ceiling 4 MiB
  │     ├─ SHA-256 digest of frame bytes
  │     ├─ Cache read: visual_identify_cache (Supabase/Postgres, TTL-based)
  │     │   └─ HIT → return { match }
  │     ├─ identifyFrame(frameBuffer, widthHint, heightHint)
  │     │   ├─ heuristicAnalyse() — synchronous, no credentials needed
  │     │   │   └─ Parses JPEG SOF marker for dimensions, checks aspect ratio
  │     │   └─ callGraniteVisionOnce() — if WATSONX_API_KEY + WATSONX_PROJECT_ID set
  │     │       ├─ IAM bearer token (module-level cache, 50-min TTL, refresh-on-401)
  │     │       ├─ POST to watsonx.ai /ml/v1/text/chat
  │     │       │   Model: ibm/granite-vision-3-2-2b (VLM)
  │     │       │   User message content: text prompt + image_url (base64 JPEG)
  │     │       │   Prompt constrains model to closed category taxonomy
  │     │       ├─ Server validates category against VALID_CATEGORIES set
  │     │       ├─ Merge heuristic signals into Granite result
  │     │       └─ Semaphore (WATSONX_MAX_CONCURRENCY=4) + circuit breaker (20 failures, 30s)
  │     │           + 1 retry on transport failure (fresh token on 401)
  │     ├─ Cache write (fire-and-forget)
  │     └─ Return { match: VisualMatch | null }
  │
  │  3. Client merges consecutive frames with same category into FlaggedVisualSpan
  │     └─ Hysteresis: 2 consecutive misses required before closing a span
  │
  └─ WorkspaceState.visualSpans[]
       │
       ├─ Timeline (video track): purple overlay blocks, click to toggle
       │   └─ Block label shows human-readable category name
       ├─ FlaggedSectionsPanel: "◈ Visual flags" sub-section, toggle / delete
       │   ├─ Headline: "Possible copyright · [Category]"
       │   ├─ Signals + confidence score
       │   ├─ Model reasoning (human-reviewable)
       │   └─ Separate visual export strategy (cut / warn-only — mute NOT offered)
       └─ Player overlay: purple tint + category label when playhead is in flagged range
```

When `NEXT_PUBLIC_USE_REAL_SERVICES=false` (mock mode), `mockVisualScanService` runs with pre-baked fixture flags — no credentials needed, full UI demoed.

---

## 7. Performance: before and after

| Metric | Before | After |
|---|---|---|
| Frame capture per frame | New `<video>` element + full re-fetch | Seek on reused `<video>` element |
| Sampling interval | 1 frame/second | 1 frame/2 seconds (halved) |
| Scene-change filter | None | 16×9 luma histogram; skip near-identical frames |
| HTTP concurrency | Sequential (1 in-flight at a time) | 3 concurrent per batch |
| IAM token calls | 1 per frame | 1 per 50 minutes (module-level cache) |
| 60-second clip, estimated upstream calls | ~120 (60 frames × 2 per frame) | ~10–20 (novel scenes only, batched) |
| 60-second clip, estimated elapsed time | ~120 × RTT ≈ minutes | ~(novel_frames / 3) × RTT ≈ tens of seconds |

---

## 8. Known limitations and false-positive/negative risk

| Risk | Direction | Severity | Notes |
|---|---|---|---|
| No database fingerprint match | False negatives | High for "common" content | Heuristics + LLM only. A mainstream movie clip at normal 16:9 with no watermarks may not be detected. |
| Heuristic aspect-ratio check only inspects hints/JPEG SOF | False negatives | Medium | Server has no pixel decoding; advanced letterboxing (e.g., soft bars via blur) won't trigger. |
| Granite Vision 3.2 2B accuracy on ambiguous frames | Both directions | Medium | Compact VLM (2B params) is less reliable than frontier models on subtle signals. Confidence threshold of 40 is conservative; human review is mandatory. |
| Frame downscaling to 640px | False negatives | Low | Small watermarks may be invisible after downscale. Can be tuned in `seekAndCapture`. |
| No temporal reasoning | False positives | Low | Each frame is independent. A brief colour correction that incidentally looks like letterbox may fire. |
| Scene-change filter may suppress a genuine change | False negatives | Low | The histogram filter is approximate. A shot-by-shot cut within the same movie may inherit the previous verdict if the luma histogram is similar (e.g., two dark scenes from the same film). Threshold is tunable via `SCENE_CHANGE_THRESHOLD` in `visual-scan-service.ts`. |
| Flags are categories, not identified works | Fundamental limitation | Inherent | This path cannot name a specific film or episode. It flags footage that *looks like* a category. This is stated in the UI. |

---

## 9. How to test locally

### Mock mode (zero credentials)

```bash
# Start the Next.js dev server only (no backend required)
npm run dev
# Visit http://localhost:3000 — visual scan mock fires automatically after audio scan
```

The mock service (`lib/mock/vision-scan-service.ts`) produces two fixture flags:
- **Film or TV clip** (`film_or_tv`) at ~10%–28% of the video duration (81% confidence, `granite_vision` source).
- **Screen recording** (`screen_recording`) at ~52%–67% (74% confidence, `granite_vision` source).

These appear as purple overlays on the video track and in the "◈ Visual flags" sub-section of the panel.

### Real mode (watsonx credentials required)

1. Obtain a watsonx.ai API key and project ID from [IBM Cloud](https://cloud.ibm.com/catalog/services/watson-machine-learning).
2. Copy `.env.example` to `.env` and fill in:
   ```
   WATSONX_API_KEY=<your-key>
   WATSONX_PROJECT_ID=<your-project-id>
   WATSONX_MODEL_ID=ibm/granite-vision-3-2-2b
   NEXT_PUBLIC_USE_REAL_SERVICES=true
   ```
3. Start both servers:
   ```bash
   npm run dev:all
   ```
4. Drop a video with obvious letterboxing (cinema clip) or a screen recording into ClaimGuard. After the audio scan completes, the visual scan will run and POST frames to `/api/identify-video` at 2-second intervals with up to 3 concurrent requests per batch.

**Model validation warning:** If `WATSONX_MODEL_ID` is set to a text-only model (e.g., `ibm/granite-3-2-8b-instruct`), the server will emit a loud `[ClaimGuard WARNING]` to stderr on the first frame call and the results will be garbage. The default model ID in `.env.example` is already set to the correct vision model.

### Running the backend tests

```bash
cd server
node --import tsx/esm --test test/identify-video.test.ts
```

Tests 1–5 are pure unit tests (heuristic analyser — no network).
Tests 6–11 are route-level tests using a minimal Fastify app with no database and no watsonx credentials — they cover all error paths and the heuristic-triggered happy path.

---

## 10. How this was built

This feature was built with AI-assisted development using IBM Bob within the IBM AI Builders Challenge.

**Research phase:** The model selection question — "which IBM Granite checkpoint accepts image inputs?" — required concrete investigation rather than guesswork. The initial implementation used `ibm/granite-3-2-8b-instruct` in `.env.example` and the doc, which is a text-only instruct model that cannot process images. Investigating the watsonx.ai model catalogue identified `ibm/granite-vision-3-2-2b` as IBM's compact VLM that accepts the `/ml/v1/text/chat` multipart image format. Every model name in the code, config, and documentation was corrected.

**Performance investigation:** Profiling the scan path on a 60-second video revealed two O(n²) bottlenecks: a new `<video>` element created per frame (re-fetching the entire file each time), and one IAM token call per frame request. Both were fixed — the video element is created once per media item and seeked repeatedly; the IAM token is cached module-scope with a 50-minute TTL. Sampling was also reduced from 1 fps to 1 frame/2 seconds and batched concurrently.

**Taxonomy design:** Free-text labels from the LLM ("Movie clip", "Film footage", "Cinematic scene") caused span fragmentation — three consecutive frames of the same clip produced three separate spans. Switching to a closed nine-value taxonomy prompted directly in the model instruction and validated server-side solved both the fragmentation and the label drift.

**Export integration:** The original export path did not distinguish between audio and visual flags — it offered "mute audio" as an option for visual flags, which is meaningless (the on-screen footage is still there regardless of the audio track). The UI now presents a separate visual strategy selector (`cut / warn-only`) that never offers mute.

**Documentation:** This document is written to describe what the code *actually does*, not aspirationally. Limitations that were fixed are removed from the limitations table; limitations that remain are retained with honest descriptions.
