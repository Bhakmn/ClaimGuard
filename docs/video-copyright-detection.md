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

---

## 4. IBM model selection

### Which models were evaluated

| Model | Considered for | Decision |
|---|---|---|
| **Granite Vision (ibm/granite-3-2-8b-instruct)** | Frame classification, logo/watermark detection, reasoning over "is this third-party footage?" | **Selected.** Multimodal foundation model via watsonx.ai. Accepts image + text prompt, returns structured JSON. |
| Granite 3.x text-only | Text classification | Rejected. No vision capability — cannot process frame pixels. |
| Granite Guardian | Content safety / bias detection | Rejected. Designed for content moderation, not copyright-risk detection. |
| watsonx.governance (AI Factsheet / OpenScale) | Audit trail of model decisions per flag | Considered. Useful for legal audit trail — deferred to a future iteration. Not wired in now because it adds latency and setup complexity that exceeds the current scope. If an audit trail per flag is required, the `reasoning` field already captures the model output; connecting that to a governance ledger is a one-file change in `vision.ts`. |

### Why Granite Vision

The task is a **multimodal vision task**: given a 640×N JPEG frame, determine whether it contains visual signals of third-party footage. This requires the model to:

1. Understand pixel-level features (bars, watermarks, UI chrome).
2. Reason about them in natural-language context.
3. Return a structured confidence score and per-signal explanation.

Only a multimodal model can do this. Granite Vision (the `ibm/granite-3-2-8b-instruct` checkpoint with vision capability) is IBM's multimodal foundation model available on watsonx.ai. It is the correct tool for this sub-problem.

### Why not Gemini

`GEMINI_API_KEY` is present in `.env.example` and was considered as an alternative multimodal model (Google Gemini 1.5 Pro has strong vision capabilities). It was not selected as the primary path because:

- The platform requirement is IBM watsonx / Granite.
- Running both models per frame would double cost and latency with no clear quality benefit until production data proves one is superior.

The Gemini key is reserved in the environment for a future parallel-signal experiment.

---

## 5. Architecture: data flow

```
Client (browser)
  │
  │  1. realVisualScanService.scan()
  │     ├─ For each media item, 1 frame/second
  │     ├─ captureFrameAtTime() → HTMLVideoElement + Canvas → JPEG Blob (≤640px wide)
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
  │     │       ├─ Exchange API key for IAM bearer token
  │     │       ├─ POST to watsonx.ai /ml/v1/text/chat
  │     │       │   Model: ibm/granite-3-2-8b-instruct (multimodal)
  │     │       │   Prompt: structured JSON output schema
  │     │       ├─ Merge heuristic signals into Granite result
  │     │       └─ Semaphore (WATSONX_MAX_CONCURRENCY=4) + circuit breaker (20 failures, 30s)
  │     │           + 1 retry on transport failure
  │     ├─ Cache write (fire-and-forget)
  │     └─ Return { match: VisualMatch | null }
  │
  │  3. Client merges consecutive frames with same label into FlaggedVisualSpan
  │
  └─ WorkspaceState.visualSpans[]
       │
       ├─ Timeline (video track): purple overlay blocks, click to toggle
       └─ FlaggedSectionsPanel: "◈ Visual flags" sub-section, toggle / delete
```

When `NEXT_PUBLIC_USE_REAL_SERVICES=false` (mock mode), `mockVisualScanService` runs with pre-baked fixture flags — no credentials needed, full UI demoed.

---

## 6. Known limitations and false-positive/negative risk

| Risk | Direction | Severity | Notes |
|---|---|---|---|
| No database fingerprint match | False negatives | High for "common" content | Heuristics + LLM only. A mainstream movie clip at normal 16:9 with no watermarks may not be detected. |
| Heuristic aspect-ratio check only inspects hints/JPEG SOF | False negatives | Medium | Server has no pixel decoding; advanced letterboxing (e.g., soft bars via blur) won't trigger. |
| Granite Vision hallucination | False positives | Medium | LLM may flag content that isn't actually third-party. Confidence threshold of 40 reduces this; human review is mandatory. |
| 1 frame/second sampling | False negatives | Medium | A clip lasting <1s may be skipped. Fine-grained scanning requires higher frame rates (future work). |
| Frame downscaling to 640px | False negatives | Low | Small watermarks may be invisible after downscale. Can be tuned in `captureFrameAtTime`. |
| No temporal reasoning | False positives | Low | Each frame is independent. A brief colour correction that incidentally looks like letterbox may fire. |
| watsonx IAM token not cached | Latency | Low | A new token is fetched per frame. Should be cached with a 50-minute TTL in a production build. |

---

## 7. How to test locally

### Mock mode (zero credentials)

```bash
# Start the Next.js dev server only (no backend required)
npm run dev
# Visit http://localhost:3000 — visual scan mock fires automatically after audio scan
```

The mock service (`lib/mock/vision-scan-service.ts`) produces two fixture flags:
- **Movie clip** at ~10%–28% of the video duration (81% confidence, `granite_vision` source).
- **Screen recording** at ~52%–67% (74% confidence, `granite_vision` source).

These appear as purple overlays on the video track and in the "◈ Visual flags" sub-section of the panel.

### Real mode (watsonx credentials required)

1. Obtain a watsonx.ai API key and project ID from [IBM Cloud](https://cloud.ibm.com/catalog/services/watson-machine-learning).
2. Copy `.env.example` to `.env` and fill in:
   ```
   WATSONX_API_KEY=<your-key>
   WATSONX_PROJECT_ID=<your-project-id>
   NEXT_PUBLIC_USE_REAL_SERVICES=true
   ```
3. Start both servers:
   ```bash
   npm run dev:all
   ```
4. Drop a video with obvious letterboxing (cinema clip) or a screen recording into ClaimGuard. After the audio scan completes, the visual scan will run and POST each frame to `/api/identify-video`.

### Running the backend tests

```bash
cd server
node --import tsx/esm --test test/identify-video.test.ts
```

Tests 1–5 are pure unit tests (heuristic analyser — no network).  
Tests 6–11 are route-level tests using a minimal Fastify app with no database and no watsonx credentials — they cover all error paths and the heuristic-triggered happy path.
