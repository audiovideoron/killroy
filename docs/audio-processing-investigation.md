# Audio Processing Investigation Report

## 1. File Paths and Functions Responsible for Chain Building

| Path | Function | Purpose |
|------|----------|---------|
| `electron/main.ts:161` | `ipcMain.handle('render-preview', ...)` | Entry point for preview render |
| `electron/main.ts:258` | calls `buildFullFilterChain()` | Constructs base filter chain |
| `electron/main.ts:264` | calls `analyzeLoudness()` | Loudness analysis pass |
| `electron/main.ts:266` | calls `calculateLoudnessGain()` | Computes gain adjustment |
| `electron/main.ts:275` | calls `buildLoudnessGainFilter()` | Builds final volume filter |
| `electron/ffmpeg-manager.ts:785` | `buildFullFilterChain()` | Assembles user filter chain |
| `electron/ffmpeg-manager.ts:527` | `buildNoiseReductionFilter()` | Builds `afftdn` filter |
| `electron/ffmpeg-manager.ts:557` | `buildAutoMixFilter()` | Builds `dynaudnorm` filter |
| `electron/ffmpeg-manager.ts:686` | `analyzeLoudness()` | Runs loudnorm analysis |
| `electron/ffmpeg-manager.ts:627` | `calculateLoudnessGain()` | Calculates gain with guards |
| `electron/ffmpeg-manager.ts:670` | `buildLoudnessGainFilter()` | Returns `volume=XdB` |
| `electron/final-render.ts:33` | `renderFinal()` | Export entry point |
| `electron/final-render.ts:120` | `extractSegment()` | Extracts each keep range |

---

## 2. Signal Flow Diagrams

### ORIGINAL PREVIEW
```
INPUT ──▶ [-ss, -t] ──▶ [NO -af] ──▶ [-c:a aac -b:a 192k] ──▶ original-XXX.mp4

Conditions: None. Always renders without audio filters.
FFmpeg filters: (none)
```

### PROCESSED PREVIEW
```
                                 ┌─────────────────────────────────────────────┐
                                 │         PASS 0: buildFullFilterChain()      │
                                 │         electron/ffmpeg-manager.ts:785      │
                                 └─────────────────────────────────────────────┘
                                                      │
INPUT ──▶ [-ss, -t] ──▶ [-af baseFilterChain] ──▶ ...│
                                                      ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  STAGE 1: NR         if noiseReduction.enabled && noiseReduction.strength > 0           │
│           afftdn=nr={0-40}:nf={-50..-35}:tn=true                                         │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│  STAGE 2: HPF        if hpf.enabled                                                      │
│           highpass=f={hpf.frequency}                                                     │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│  STAGE 3: LPF        if lpf.enabled                                                      │
│           lowpass=f={lpf.frequency}                                                      │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│  STAGE 4: EQ         if any band.enabled && band.gain != 0                               │
│           equalizer=f={freq}:t=h:w={freq/q}:g={gain}[,...]                               │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│  STAGE 5: COMP       if compressor.enabled                                               │
│           [highpass=f={emphasis}],acompressor=...  (COMP mode)                           │
│           [highpass=f={emphasis}],alimiter=...,volume={makeup}dB  (LIMIT mode)           │
│           volume={makeup}dB  (LEVEL mode)                                                │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│  STAGE 6: AUTOMIX    if autoMix.enabled                                                  │
│           dynaudnorm=f={framelen}:g={gausssize}:p=0.9:m={maxgain}                        │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                                                      │
                                                      │ baseFilterChain
                                                      ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  PASS 1: analyzeLoudness()                                                               │
│          electron/main.ts:264                                                            │
│          FFmpeg: -af {baseFilterChain},loudnorm=I=-14:TP=-1:print_format=json -f null -  │
│          Output: LoudnessAnalysis { input_i, input_tp, input_lra, input_thresh }         │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                                                      │
                                                      ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  GAIN CALC: calculateLoudnessGain()                                                      │
│          electron/ffmpeg-manager.ts:627                                                  │
│          gain = -14 - input_i, clamped to [-6, +12] dB                                   │
│          Guards: skip if silent (<-70 LUFS), skip if negligible (<0.5 dB),               │
│                  reduce if would clip (input_tp + gain > -1)                             │
│          Output: number | null                                                           │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                                                      │
                                                      ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  STAGE 7: LOUDNESS   if loudnessGain != null                                             │
│           volume={gain}dB                                                                │
│           electron/main.ts:275-278                                                       │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                                                      │
                                                      │ filterChain = baseFilterChain + loudnessFilter
                                                      ▼
                       [-af filterChain] ──▶ [-c:a aac -b:a 192k] ──▶ processed-XXX.mp4
```

### EXPORT (Final Render)
```
INPUT ──▶ [EDL keep ranges] ──▶ extractSegment() per range ──▶ concatSegments() ──▶ OUTPUT

For each segment:
  FFmpeg: -ss {start} -t {duration} -i {input} -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k {output}

Conditions: None. No audio filters applied.
FFmpeg filters: (none)
```

---

## 3. UI Stage to Code Mapping Table

| UI Stage Name | Code Implementation | FFmpeg Filter | File:Line | Condition |
|---------------|---------------------|---------------|-----------|-----------|
| **Noise Reduction** | `buildNoiseReductionFilter()` | `afftdn=nr=X:nf=Y:tn=true` | `ffmpeg-manager.ts:527` | `enabled && strength > 0` |
| **Noise Sampling** | `detectQuietCandidates()` | `silencedetect=noise=X:d=Y` (analysis only) | `ffmpeg-manager.ts:1240` | Toggle ON triggers detection |
| **HPF** | inline in `buildFullFilterChain()` | `highpass=f=X` | `ffmpeg-manager.ts:795-797` | `hpf.enabled` |
| **LPF** | inline in `buildFullFilterChain()` | `lowpass=f=X` | `ffmpeg-manager.ts:800-802` | `lpf.enabled` |
| **EQ** | `buildEQFilter()` | `equalizer=f=X:t=h:w=Y:g=Z` | `ffmpeg-manager.ts:428` | any band enabled with gain!=0 |
| **Compressor** | `buildCompressorFilter()` | `acompressor=...` or `alimiter=...` or `volume=...` | `ffmpeg-manager.ts:454` | `enabled` |
| **AutoMix** | `buildAutoMixFilter()` | `dynaudnorm=f=X:g=Y:p=0.9:m=Z` | `ffmpeg-manager.ts:557` | `enabled` |
| **Loudness** | `analyzeLoudness()` + `calculateLoudnessGain()` + `buildLoudnessGainFilter()` | `volume=XdB` | `main.ts:264-278` | Always runs; filter added if gain!=null |

---

## 4. Discrepancies

### Preview vs Export
| Aspect | Preview | Export |
|--------|---------|--------|
| Audio filters | Full chain (NR->HPF->LPF->EQ->COMP->AUTOMIX->LOUDNESS) | **NONE** |
| Loudness normalization | Yes (targets -14 LUFS) | **No** |
| User processing | Applied | **Not applied** |
| Purpose | A/B audition | Final output |

**Critical Finding**: Export does NOT apply any audio processing. Preview and Export are completely different paths. Export only performs EDL-based segment cuts with re-encoding but no audio filters.

### Original vs Processed Preview
| Aspect | Original | Processed |
|--------|----------|-----------|
| Audio filters | None | Up to 7 stages |
| Loudness normalization | No | Yes (automatic) |
| A/B validity | Baseline | Differs by filter chain + loudness gain |

**Critical Finding**: Loudness normalization is applied ONLY to processed preview, creating a volume asymmetry that affects A/B comparison validity.

### Noise Sampling vs Noise Reduction
| Aspect | Noise Sampling | Noise Reduction |
|--------|----------------|-----------------|
| Code location | `detectQuietCandidates()` + `NoiseSampling.tsx` | `buildNoiseReductionFilter()` |
| FFmpeg filter | `silencedetect` (analysis) | `afftdn` (processing) |
| In filter chain? | **NO** | YES (stage 1) |
| Purpose | Detect quiet regions | Remove noise |
| Connection | `noiseSampleRegion` stored but **NEVER USED** in render | Independent operation |

**Critical Finding**: Noise Sampling and Noise Reduction are fully independent. The detected `noiseSampleRegion` is stored in React state but is NOT passed to `renderPreview()` and does NOT affect the filter chain. The `afftdn` filter operates with `tn=true` (track noise) for adaptive detection, not from a user-selected sample.
