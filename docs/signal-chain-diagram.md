# Kilroy Audio Signal Chain Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           KILROY AUDIO SIGNAL CHAIN                             │
│                              (Preview Render)                                   │
└─────────────────────────────────────────────────────────────────────────────────┘

                              ┌──────────────┐
                              │  INPUT FILE  │
                              │  (video/audio)│
                              └──────┬───────┘
                                     │
                    ┌────────────────┴────────────────┐
                    │                                 │
                    ▼                                 ▼
    ┌───────────────────────────┐     ┌───────────────────────────────────────────┐
    │     ORIGINAL PATH         │     │           PROCESSED PATH                  │
    │     (A/B Reference)       │     │           (User Adjustments)              │
    └───────────────────────────┘     └───────────────────────────────────────────┘
                    │                                 │
                    ▼                                 │
    ┌───────────────────────────┐                     │
    │  No audio filters         │                     │
    │  -c:a aac -b:a 192k       │                     │
    └───────────────┬───────────┘                     │
                    │                                 │
                    ▼                                 ▼
    ┌───────────────────────────┐     ┌───────────────────────────────────────────┐
    │    original-XXX.mp4       │     │  PASS 0: Build Base Filter Chain          │
    └───────────────────────────┘     │  buildFullFilterChain()                   │
                                      └───────────────────┬───────────────────────┘
                                                          │
                    ┌─────────────────────────────────────┘
                    │
                    ▼
    ┌───────────────────────────────────────────────────────────────────────────┐
    │                     BASE FILTER CHAIN (User Controls)                     │
    │    Signal flows LEFT → RIGHT through enabled stages only                  │
    │                                                                           │
    │  ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌────────┐   ┌──────────┐   ┌─────────┐
    │  │   NR    │──▶│   HPF   │──▶│   LPF   │──▶│   EQ   │──▶│COMPRESSOR│──▶│ AUTOMIX │
    │  │ afftdn  │   │highpass │   │lowpass  │   │equalizer│   │acompressor│   │dynaudnorm│
    │  └────┬────┘   └────┬────┘   └────┬────┘   └────┬───┘   └─────┬────┘   └────┬────┘
    │       │             │             │             │             │             │
    │  nr=0-40dB     f=80-400Hz   f=4k-16kHz    3 bands      threshold     LIGHT/MED/
    │  nf=-50..-35   (if enabled) (if enabled)  ±24dB/band   ratio         HEAVY preset
    │  tn=true                                  Q: 0.1-10    makeup gain
    └───────────────────────────────────────────────────────────────────────────┘
                    │
                    │ baseFilterChain (comma-separated FFmpeg filters)
                    ▼
    ┌───────────────────────────────────────────────────────────────────────────┐
    │                    PASS 1: LOUDNESS ANALYSIS                              │
    │                    analyzeLoudness()                                      │
    │                                                                           │
    │    FFmpeg run with: -af {baseFilterChain},loudnorm=I=-14:TP=-1:print_format=json
    │    Output: -f null -  (analysis only, no file written)                    │
    │                                                                           │
    │    Measures:                                                              │
    │    • input_i  (integrated LUFS)                                           │
    │    • input_tp (true peak dBTP)                                            │
    │    • input_lra (loudness range)                                           │
    └───────────────────────────┬───────────────────────────────────────────────┘
                                │
                                │ LoudnessAnalysis { input_i, input_tp, ... }
                                ▼
    ┌───────────────────────────────────────────────────────────────────────────┐
    │                    GAIN CALCULATION                                       │
    │                    calculateLoudnessGain()                                │
    │                                                                           │
    │    Target: -14 LUFS (YouTube/Spotify standard)                            │
    │                                                                           │
    │    gain = TARGET_LUFS - input_i                                           │
    │                                                                           │
    │    Guards:                                                                │
    │    1. Skip if input_i < -70 LUFS (silence)                                │
    │    2. Clamp gain to [-6, +12] dB                                          │
    │    3. Reduce if (input_tp + gain) > -1 dBTP (prevent clipping)            │
    │    4. Skip if |gain| < 0.5 dB (negligible)                                │
    └───────────────────────────┬───────────────────────────────────────────────┘
                                │
                                │ loudnessGain (dB) or null
                                ▼
    ┌───────────────────────────────────────────────────────────────────────────┐
    │                    FINAL FILTER CHAIN ASSEMBLY                            │
    │                                                                           │
    │    filterChain = baseFilterChain + loudnessFilter                         │
    │                                                                           │
    │    If loudnessGain != null:                                               │
    │       filterChain = "{baseFilterChain},volume={gain}dB"                   │
    │    Else:                                                                  │
    │       filterChain = baseFilterChain (no loudness adjustment)              │
    └───────────────────────────┬───────────────────────────────────────────────┘
                                │
                                │ Complete filter chain string
                                ▼
    ┌───────────────────────────────────────────────────────────────────────────┐
    │                    PASS 2: RENDER PROCESSED PREVIEW                       │
    │                                                                           │
    │    FFmpeg: -af {filterChain} -c:a aac -b:a 192k                           │
    │                                                                           │
    │    Strategy: Try COPY first (fast), fall back to REENCODE if fails        │
    └───────────────────────────┬───────────────────────────────────────────────┘
                                │
                                ▼
                    ┌───────────────────────────┐
                    │    processed-XXX.mp4      │
                    └───────────────────────────┘


┌─────────────────────────────────────────────────────────────────────────────────┐
│                         COMPLETE PROCESSED CHAIN                                │
│                    (all stages enabled, worst case)                             │
└─────────────────────────────────────────────────────────────────────────────────┘

  INPUT ──▶ afftdn ──▶ highpass ──▶ lowpass ──▶ equalizer ──▶ acompressor ──▶ dynaudnorm ──▶ volume ──▶ OUTPUT
             │            │            │            │              │              │            │
            NR          HPF          LPF           EQ         Compressor      AutoMix     Loudness
         (0-40dB)    (80-400Hz)  (4k-16kHz)    (3 bands)    (threshold,     (LIGHT/MED/   Gain
                                               (±24dB)      ratio, makeup)   HEAVY)     (-6 to +12dB)


┌─────────────────────────────────────────────────────────────────────────────────┐
│                         GAIN STAGES SUMMARY                                     │
└─────────────────────────────────────────────────────────────────────────────────┘

  Stage           │ Gain Applied                    │ User Control
  ────────────────┼─────────────────────────────────┼──────────────────────────
  NR (afftdn)     │ nr: 0-40 dB reduction          │ Strength slider (0-100%)
  EQ (equalizer)  │ ±24 dB per band                │ 3 band gain knobs
  Compressor      │ makeup: user-defined dB        │ Makeup gain control
  AutoMix         │ dynaudnorm: up to 3/6/10x      │ Preset selector
  Loudness        │ volume: -6 to +12 dB           │ AUTOMATIC (no user control)


┌─────────────────────────────────────────────────────────────────────────────────┐
│                         FINAL RENDER (Export)                                   │
│                         electron/final-render.ts                                │
└─────────────────────────────────────────────────────────────────────────────────┘

  INPUT ──▶ [No audio filters] ──▶ Segment extraction ──▶ Concat ──▶ OUTPUT

  Note: Final render uses EDL-based segment cuts only.
        NO audio processing filters are applied during export.
        Audio filters only affect PREVIEW, not final render.
```

---

## How to Read This Diagram

1. **Two Parallel Paths**: Preview creates TWO files - "Original" (no filters) and "Processed" (with filters). These enable A/B comparison.

2. **Flow Direction**: Signal flows top-to-bottom and left-to-right through filter stages.

3. **Conditional Stages**: Each filter stage only appears in the chain if enabled by the user. Disabled stages are bypassed entirely.

4. **Two-Pass Processing**: The processed path runs FFmpeg twice:
   - **Pass 1**: Analysis only (measures loudness, writes no file)
   - **Pass 2**: Actual render with complete filter chain + loudness gain

5. **Gain Stages**:
   - **User-controlled**: NR, EQ bands, Compressor makeup, AutoMix preset
   - **Automatic**: Loudness normalization gain (targets -14 LUFS)

6. **Key Divergence**: The Original path has NO audio filters. The Processed path has up to 7 filter stages including automatic loudness gain. This asymmetry means A/B comparison includes loudness differences.

7. **Final Render**: Export uses EDL cuts only - NO audio processing is applied to the final output file.
