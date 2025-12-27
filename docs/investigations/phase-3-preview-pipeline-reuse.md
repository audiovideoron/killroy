# Phase 3 — Preview Pipeline Reuse (Investigation Report)

**Date:** 2025-12-26
**Baseline commit:** f7211a3
**Branch:** fix/noise-sampler-preview-reuse-preview-pipeline
**Status:** ✅ NO VIOLATIONS FOUND

## Objective

Verify that there is **one preview pipeline** reused by all preview-capable features, and that **Noise Sampling does not introduce a feature-specific preview path**.

## Findings

### Call Graph: Audio Processing Preview Path

```
UI Click (Preview button)
  └─> src/App.tsx:435 - handleRender()
      └─> src/App.tsx:152 - handleRender() callback
          └─> src/App.tsx:93 - requestPreview({ startSec, durationSec })
              └─> src/App.tsx:105 - window.electronAPI.renderPreview(options)
                  └─> IPC channel: 'render-preview'
                      └─> electron/main.ts:161 - ipcMain.handle('render-preview', ...)
                          ├─> electron/main.ts:258 - buildFullFilterChain(hpf, bands, lpf, compressor, noiseReduction, autoMix, noiseSampleRegion)
                          ├─> electron/main.ts:264 - analyzeLoudness(inputPath, baseFilterChain, startTime, duration)
                          ├─> electron/main.ts:275-278 - append loudnessFilter to baseFilterChain
                          └─> electron/main.ts:255,332 - tryRenderStrategies() for original and processed
```

### Shared vs Divergent Analysis

| Component | Preview (render-preview) | Render (render-full-audio) | Shared? |
|-----------|-------------------------|---------------------------|---------|
| **Chain builder** | `buildFullFilterChain()` (main.ts:258) | `buildFullFilterChain()` (main.ts:428) | ✅ **YES** |
| **Chain parameters** | `hpf, bands, lpf, compressor, noiseReduction, autoMix, noiseSampleRegion` | `hpf, bands, lpf, compressor, noiseReduction, autoMix, noiseSampleRegion` | ✅ **YES** |
| **Loudness analysis** | `analyzeLoudness()` (main.ts:264) | `analyzeLoudness()` (main.ts:433) | ✅ **YES** |
| **Loudness filter** | `buildLoudnessGainFilter()` (main.ts:275) | `buildLoudnessGainFilter()` (main.ts:441) | ✅ **YES** |
| **Time range** | `-ss startTime -t duration` (main.ts:230,287) | No time flags (full file) | ❌ **DIFFERENT** (expected) |
| **Output path** | Job temp dir with renderId | Job temp dir with renderId | ✅ **YES** (pattern) |
| **Noise sampling integration** | Passed as parameter, no branching | Passed as parameter, no branching | ✅ **YES** |

### Noise Sampling Integration Verification

**Parameter flow (end-to-end):**

1. **UI:** `src/components/NoiseSampling.tsx:47` - `onNoiseSampleAccepted(topCandidate)`
2. **App:** `src/App.tsx:78-83` - `handleNoiseSampleAccepted()` sets `noiseSampleRegion` state
3. **Preview:** `src/App.tsx:115` - `noiseSampleRegion` passed to `renderPreview()`
4. **IPC:** `electron/main.ts:162` - extracted from `RenderOptions`
5. **Chain:** `electron/main.ts:258` - passed to `buildFullFilterChain(..., noiseSampleRegion)`
6. **Filter:** `electron/ffmpeg-manager.ts:829` - `buildNoiseReductionFilter(noiseReduction, noiseSampleRegion)`

**No alternate preview paths found:**

- ✅ No `if (isPreview && noiseSamplingEnabled)` branching
- ✅ No noise-specific preview functions
- ✅ NoiseSampling component explicitly states: "No transport controls - all auditioning happens through global Preview" (NoiseSampling.tsx:8)
- ✅ Only one `requestPreview()` function in UI (App.tsx:93)
- ✅ Only one IPC channel `'render-preview'` for audio processing preview

### Canonical Chain Order Verification

**buildFullFilterChain (ffmpeg-manager.ts:813-865):**

```
1. AutoGain / Leveling (placeholder - line 817)
2. Loudness (placeholder - line 823)
3. Noise Sampling DSP (line 829) - parameterized by noiseSampleRegion
4. Highpass (line 835)
5. Lowpass (line 840)
6. EQ (line 845)
7. Compressor (line 851)
8. AutoMix (line 857)
```

**Control flow analysis:**

- ✅ No conditional branching based on noise sampling
- ✅ No `if (preview)` logic in chain builder
- ✅ `buildNoiseReductionFilter()` returns empty string (bypass) until implementation (ffmpeg-manager.ts:532-542)

### Other Preview Systems (Not Relevant to Audio Processing)

**Found but UNRELATED:**

- `electron/preview-render.ts` - Separate feature for transcript/EDL editing preview
  - Used by: Only tests (`electron/__tests__/preview-render.spec.ts`)
  - Not imported by main.ts or App.tsx
  - Different interface: `PreviewOptions { videoAsset, edl, playhead_ms, ... }`
  - Purpose: Preview video with EDL edits applied (transcript editing feature)
  - **Conclusion:** Different feature, different preview pipeline, no conflict

## Conclusion

**✅ COMPLIANCE CONFIRMED:**

1. **Single preview pipeline:** Only one audio processing preview path exists (`render-preview` IPC handler)
2. **Shared chain builder:** Both Preview and Render call `buildFullFilterChain()` with identical parameters
3. **No noise-specific divergence:** Noise sampling uses parameter-only integration (noiseSampleRegion)
4. **No feature-specific preview:** NoiseSampling component uses global Preview button, no dedicated preview
5. **Canonical chain enforced:** Order matches spec, no conditional branching

**📋 VIOLATIONS FOUND:** None

**✅ RECOMMENDATION:** No corrective action required. The preview pipeline correctly implements the canonical spec with no divergence.

## Notes

- `final-render.spec.ts` test timeouts (3 failures) are present but unrelated to Preview pipeline
- These timeouts affect the EDL/transcript editing feature's final render tests, not the audio processing preview investigated here
