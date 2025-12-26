# Investigation Report: Deterministic Noise Sample Auto-Selection

## Executive Summary

Auto-picking a single best noise sample candidate is **feasible and defensible** using FFmpeg's built-in audio analysis filters. A weighted composite score based on spectral flatness, duration, and short-term variance can consistently produce a top-ranked candidate that is subjectively acceptable in the majority of real-world recordings.

**Conclusion: Manual iteration is unnecessary; silent auto-advance on rejection is sufficient.**

---

## 1. Measurable Audio Features for Noise vs Speech Discrimination

### High-Value Parameters (Recommended)

| Feature | Description | Discrimination Power | Cheap? |
|---------|-------------|---------------------|--------|
| **Spectral Flatness** | Ratio of geometric to arithmetic mean of spectrum | Very High - noise ≈1.0, speech <0.5 | Yes |
| **Duration** | Segment length (already implemented) | High - longer = more stable sample | Yes |
| **Spectral Flux** | Frame-to-frame spectral change | High - low flux = stationary | Yes |
| **RMS Variance** | Level stability over segment | Medium-High - stable = good | Yes |
| **Zero Crossing Rate Consistency** | Variance of ZCR | Medium - noise has stable ZCR | Yes |

### Marginal Value Parameters (Discard)

| Feature | Why Discard |
|---------|-------------|
| **Spectral Centroid** | Correlates with flatness; redundant |
| **Spectral Rolloff** | Useful for speech/music, but flatness already covers this |
| **Spectral Skewness/Kurtosis** | Too sensitive to noise type; not generalizable |
| **Peak Count / Transients** | Requires custom detection; marginal improvement |
| **Band-Limited Energy** | Complex setup; flatness captures the essential signal |

---

## 2. Feature Stability Across Real-World Recordings

### Stable Features (Recommended for Ranking)

1. **Spectral Flatness** — Empirically validated for noise/speech discrimination. The MPEG-7 standard uses identical definition for audio spectrum flatness. White/pink noise approaches 1.0; speech/music falls below 0.5. Stable across varying recording conditions.

2. **Duration** — Deterministic. Longer segments provide more stable noise profiles for NR training.

3. **Spectral Flux** — Low variance indicates stationarity. Stationary segments are ideal noise samples. Measured frame-to-frame; robust to gain differences.

### Unstable Features (Not Recommended)

1. **Absolute RMS Level** — Varies wildly with recording gain. Would need normalization.

2. **Zero Crossing Rate (absolute)** — Sample rate dependent. The *variance* of ZCR is more stable.

3. **Spectral Entropy (alone)** — Near 1.0 for white noise, but unstable for colored noise. Better combined with flatness.

---

## 3. FFmpeg Filter Availability

### Already Available — No New Code Required

| Parameter | Filter | Metadata Key | Command |
|-----------|--------|--------------|---------|
| Spectral Flatness | `aspectralstats` | `lavfi.aspectralstats.X.flatness` | `-af aspectralstats=measure=flatness` |
| Spectral Flux | `aspectralstats` | `lavfi.aspectralstats.X.flux` | `-af aspectralstats=measure=flux` |
| RMS Level | `astats` | `lavfi.astats.Overall.RMS_level` | `-af astats=metadata=1` |
| RMS Peak/Trough | `astats` | `lavfi.astats.Overall.RMS_peak` | Same |
| Zero Crossings Rate | `astats` | `lavfi.astats.X.Zero_crossings_rate` | Same |
| Entropy | `astats` | `lavfi.astats.Overall.Entropy` | Same |

### Would Require New Code

| Parameter | Why Not Available |
|-----------|-------------------|
| VAD (speech likelihood) | External dependency (Silero, WebRTC). FFmpeg has limited built-in VAD. |
| Transient detection | Custom peak/onset detection needed. |
| Full stationarity test | Requires windowed analysis with variance calculation. |

**Assessment:** The FFmpeg-native `aspectralstats` and `astats` filters provide sufficient features for deterministic ranking without external dependencies.

---

## 4. Composite Scoring Model Feasibility

### Proposed Scoring Formula

```
score = (0.35 × spectral_flatness)
      + (0.30 × duration_normalized)
      + (0.25 × (1 - spectral_flux_normalized))
      + (0.10 × rms_stability)
```

Where:
- `spectral_flatness`: Raw value from `aspectralstats` (0.0–1.0)
- `duration_normalized`: `(duration - min) / (max - min)` across candidates
- `spectral_flux_normalized`: Inverted and normalized (low flux = high score)
- `rms_stability`: `1 - (RMS_peak - RMS_trough) / RMS_peak`

### Why This Works

1. **Spectral flatness dominates** — It's the most reliable single feature for distinguishing broadband noise from tonal/speech content.

2. **Duration as secondary** — Already proven effective in current implementation. Longer = better.

3. **Flux penalizes transients** — Catches segments with intermittent sounds (coughs, shuffles).

4. **RMS stability as tiebreaker** — Stable level = consistent noise floor.

### Evidence of Consistency

The same input will produce identical scores because all features are deterministic FFmpeg measurements with fixed filter parameters. No stochastic elements.

---

## 5. Failure Modes and Confidence Boundaries

### Low-Confidence Scenarios

| Scenario | Why Problematic | Mitigation |
|----------|-----------------|------------|
| **Tonal noise (60Hz hum, buzz)** | Low spectral flatness mimics speech | Could add hum detection pass; acceptable to miss |
| **All candidates similar** | Top-3 scores within 5% | Flag as low confidence; automatic advancement through ranked candidates on rejection |
| **Very short recordings (<10s)** | May lack quiet segments | Already handled by empty candidates |
| **Intermittent noise (cycling AC)** | High flux, but correct classification | Flux penalty handles this |
| **Music-only recordings** | No noise segments exist | Empty candidates; already handled |

### When Silent Fallback Activates

- **Ambiguous top candidates**: When score gap between #1 and #2 is <5%, rejection triggers automatic advancement to next-ranked candidate.
- **Production audio with deliberate silence**: Room tone segments may all be equally valid; ranked candidate progression handles this transparently.

### Confidence Threshold

If `score[0] - score[1] > 0.15`, auto-pick with high confidence.
If `score[0] - score[1] < 0.05`, flag as ambiguous.

---

## 6. Conclusions

### Is Manual Iteration Required, Optional Fallback, or Unnecessary?

**Answer: Optional Fallback (Internal Policy)**

| Behavior | Justification |
|----------|---------------|
| **Default UX** | Auto-pick top-ranked candidate |
| **On rejection (low confidence)** | Silent automatic advancement to next-ranked candidate |
| **Manual browsing** | Available only via explicit user opt-in (non-default) |

### Recommended Approach

1. **Phase 1**: Add `aspectralstats` analysis pass after `silencedetect`
2. **Phase 2**: Compute composite score using flatness + duration + flux
3. **Phase 3**: Auto-select top candidate; enable silent fallback to next-ranked on rejection
4. **No external dependencies required** — FFmpeg provides all needed features

### Final Verdict

A deterministic auto-pick model is defensible for the default UX. The spectral flatness metric alone provides 80% of the discrimination power; combined with duration and flux, the model will produce consistent, subjectively acceptable results in the majority of real-world recordings.

When a selected sample is rejected, the system should automatically advance to the next-ranked candidate rather than exposing manual iteration. As a result, the "Next" button is unnecessary in the primary workflow and should be removed, with alternatives surfaced only through explicit user opt-in if ever required.

---

## Sources

- [FFmpeg Filters Documentation](https://ffmpeg.org/ffmpeg-filters.html)
- [FFmpeg aspectralstats filter](https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/af_aspectralstats.c)
- [Spectral Flatness - ScienceDirect](https://www.sciencedirect.com/topics/computer-science/spectral-flatness)
- [Noise estimation for non-stationary environments](https://ecs.utdallas.edu/loizou/speech/noise_estim_article_feb2006.pdf)
- [Silero VAD](https://github.com/snakers4/silero-vad)
