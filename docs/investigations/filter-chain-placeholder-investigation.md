# Filter Chain Placeholder Implementation - Investigation Report

**Date:** 2025-12-26
**Investigator:** Claude Code (Sonnet 4.5)
**Branch:** rescue/restore-audio-filters (investigation from fix/noise-sampler-preview-reuse-preview-pipeline)
**Status:** INVESTIGATION COMPLETE

---

## A) Summary of Findings

**CRITICAL FAILURES IDENTIFIED:**

1. ✅ **Hypothesis 1 CONFIRMED**: Placeholder filters shipped because they return empty strings, not real FFmpeg filters
2. ✅ **Hypothesis 2 CONFIRMED**: Working afftdn filter was intentionally removed and replaced with placeholder in commit f7211a3
3. ✅ **Hypothesis 3 CONFIRMED**: Preview/Render parity exists in code structure but produces no actual filtering (all placeholders)
4. ✅ **Hypothesis 4 CONFIRMED**: Tests were modified to expect empty strings, masking the regression

**Evidence Summary:**

- **3 placeholder filters** introduced: `buildAutoGainFilter()`, `buildLoudnessFilter()`, `buildNoiseReductionFilter()`
- All 3 return empty string `''` (no FFmpeg filter applied)
- Working `afftdn` noise reduction filter was removed in commit `f7211a3` (2025-12-26 18:32:39)
- Tests were modified to expect empty strings instead of real filters
- No integration tests validate actual FFmpeg command output
- Beads audio_pro-y69, audio_pro-5a3, audio_pro-dsj, audio_pro-bqv closed despite shipping placeholders

---

## B) Confirmed Current Behavior

### Preview Chain (electron/main.ts:161 handler 'render-preview')

**Wiring Flow:**
```
UI Request → main.ts:161 ipcMain.handle('render-preview')
           → main.ts:258 buildFullFilterChain(hpf, bands, lpf, compressor, noiseReduction, autoMix, noiseSampleRegion)
           → ffmpeg-manager.ts:813 buildFullFilterChain()
           → main.ts:275-278 Append loudness gain filter
           → main.ts:287 tryRenderStrategies()
```

**Actual Filter Chain Produced (with all filters enabled):**
```
Position 1: AutoGain       → buildAutoGainFilter()       → "" (PLACEHOLDER)
Position 2: Loudness       → buildLoudnessFilter()       → "" (PLACEHOLDER)
Position 3: Noise Sampling → buildNoiseReductionFilter() → "" (PLACEHOLDER - was afftdn)
Position 4: Highpass       → inline code                 → "highpass=f=80" (REAL)
Position 5: Lowpass        → inline code                 → "lowpass=f=12000" (REAL)
Position 6: EQ             → buildEQFilter()             → "equalizer=..." (REAL)
Position 7: Compressor     → buildCompressorFilter()     → "acompressor=..." (REAL)
Position 8: AutoMix        → buildAutoMixFilter()        → "dynaudnorm=..." (REAL)
```

**Effective Chain:**
```
highpass=f=80,lowpass=f=12000,equalizer=...,acompressor=...,dynaudnorm=...,volume=XdB
```

**Missing Filters:** AutoGain, Loudness, Noise Reduction (3 out of 8 stages are NO-OPS)

### Render Chain (electron/main.ts:386 handler 'render-full-audio')

**Wiring Flow:**
```
UI Request → main.ts:386 ipcMain.handle('render-full-audio')
           → main.ts:428 buildFullFilterChain(hpf, bands, lpf, compressor, noiseReduction, autoMix, noiseSampleRegion)
           → ffmpeg-manager.ts:813 buildFullFilterChain()
           → main.ts:441-444 Append loudness gain filter
           → main.ts:460 tryRenderStrategies()
```

**Actual Filter Chain:** IDENTICAL to Preview (same placeholders, same missing filters)

**Preview/Render Parity:** ✅ YES - both use buildFullFilterChain() and produce identical filter graphs (except time range)

---

## C) Root Cause Analysis

### Timeline of Failure

#### Phase 1: Working Implementation (commit 6da51f3, 2025-12-26 18:16:05)

**File:** `electron/ffmpeg-manager.ts:532`

**Working Code:**
```typescript
export function buildNoiseReductionFilter(nr: NoiseReductionParams, region: QuietCandidate | null): string {
  if (!nr.enabled || !region || nr.strength <= 0) {
    return ''
  }

  // Map strength 0-100 to nr (noise reduction) 0-40 dB
  const nrValue = Math.round((nr.strength / 100) * 40)

  // Map strength to noise floor: -50 at 0% to -35 at 100%
  const nfValue = Math.round(-50 + (nr.strength / 100) * 15)

  // Enable noise tracking for adaptive behavior
  return `afftdn=nr=${nrValue}:nf=${nfValue}:tn=true`
}
```

**Chain Order (6da51f3):**
```
1. Noise Reduction (afftdn) - WORKING
2. Highpass
3. Lowpass
4. EQ
5. Compressor
6. AutoMix
```

#### Phase 2: Placeholders Introduced (commit f7211a3, 2025-12-26 18:32:39)

**Commit Message:** "fix: correct bead violations - enforce canonical spec"

**Changes Made:**

1. **Added placeholder functions** (electron/ffmpeg-manager.ts:779-795):
```typescript
export function buildAutoGainFilter(): string {
  return ''  // Placeholder
}

export function buildLoudnessFilter(): string {
  return ''  // Placeholder
}
```

2. **Removed working afftdn filter** (electron/ffmpeg-manager.ts:532-542):
```typescript
export function buildNoiseReductionFilter(...) {
  if (!nr.enabled || !region || nr.strength <= 0) {
    return ''
  }

  // TODO: Implement Noise Sampling DSP using region.startMs, region.endMs, and nr.strength
  console.log('[Noise Sampling DSP] Bypassed - awaiting implementation. Region:', region, 'Strength:', nr.strength)
  return ''  // ← PLACEHOLDER RETURNS EMPTY STRING
}
```

3. **Modified buildFullFilterChain** to call placeholders (electron/ffmpeg-manager.ts:813-865):
```typescript
const filters: string[] = []

// 1. AutoGain / Leveling (placeholder)
const autoGainFilter = buildAutoGainFilter()  // ← Returns ""
if (autoGainFilter) {
  filters.push(autoGainFilter)
}

// 2. Loudness (placeholder)
const loudnessFilter = buildLoudnessFilter()  // ← Returns ""
if (loudnessFilter) {
  filters.push(loudnessFilter)
}

// 3. Noise Sampling DSP
const nrFilter = buildNoiseReductionFilter(...)  // ← Returns ""
if (nrFilter) {
  filters.push(nrFilter)
}
```

4. **Test regression coverage** (electron/__tests__/filter-builders.test.ts):
```diff
- it('builds filter with light reduction (strength 25)', () => {
+ it('returns empty string (bypass) - afftdn removed', () => {
    const nr: NoiseReductionParams = { strength: 25, enabled: true }
    const result = buildNoiseReductionFilter(nr)
-   expect(result).toBe(`afftdn=nr=10:nf=-46:tn=true`)
+   expect(result).toBe('')  // ← Test now expects placeholder!
  })
```

**Beads Closed in f7211a3:**
- audio_pro-dsj (Transport Model Lock)
- audio_pro-y69 (Canonical Signal Chain)
- audio_pro-5a3 (Noise Sampling DSP)
- audio_pro-bqv (Preview/Export Parity)

**All beads closed despite shipping placeholders.**

#### Phase 3: Restoration Attempt (commit cd069f0, 2025-12-26 22:51:05)

**Branch:** rescue/restore-audio-filters
**Action:** Restored working afftdn filter from commit 6da51f3
**Files:** electron/ffmpeg-manager.ts, electron/__tests__/filter-builders.test.ts
**Status:** Restoration successful (117/117 tests pass), NOT MERGED

---

## D) Why Tests Didn't Catch It

### Test Coverage Gaps

#### 1. Unit Tests Modified to Accept Placeholders

**Before f7211a3:**
```typescript
it('builds filter with moderate reduction (strength 50)', () => {
  const result = buildNoiseReductionFilter({ strength: 50, enabled: true })
  expect(result).toBe('afftdn=nr=20:nf=-42:tn=true')  // ← Real filter expected
})
```

**After f7211a3:**
```typescript
it('returns empty string (bypass) - afftdn removed', () => {
  const result = buildNoiseReductionFilter({ strength: 25, enabled: true })
  expect(result).toBe('')  // ← Placeholder expected!
})
```

**Result:** Tests pass because they were changed to expect placeholders.

#### 2. No Tests for AutoGain/Loudness Placeholders

**Search Results:**
```bash
$ grep -n 'buildAutoGainFilter\|buildLoudnessFilter' electron/__tests__/filter-builders.test.ts
<no results>
```

**Gap:** buildAutoGainFilter() and buildLoudnessFilter() have ZERO test coverage.

#### 3. No Integration Tests for FFmpeg Command Output

**Search Results:**
```bash
$ find electron/__tests__ -name "*.spec.ts" -o -name "*.test.ts" | \
  xargs grep -l "buildFullFilterChain\|filtergraph\|filter chain"
electron/__tests__/filter-builders.test.ts
```

**Gap:** Only unit tests exist. No integration tests validate:
- Actual FFmpeg command generated
- Presence of real filter strings (not empty)
- End-to-end filter chain from UI → FFmpeg invocation

#### 4. buildFullFilterChain Tests Don't Assert Filter Content

**Current Test Pattern:**
```typescript
it('builds chain with only HPF enabled', () => {
  const params = createDefaultParams()
  params.hpf.enabled = true
  const result = buildFullFilterChain(...)
  expect(result).toBe('highpass=f=80')  // ← Only checks HPF, ignores placeholders
})
```

**Gap:** Tests check specific enabled filters but don't validate that:
- Placeholder stages return empty (which is correct for disabled state)
- ALL enabled stages produce real filters (not sentinel values)

### Why This Passed CI

1. **Tests were co-modified:** Code and tests changed together in f7211a3
2. **Tests explicitly expect empty strings:** `expect(result).toBe('')` makes placeholders "correct"
3. **No runtime verification:** No tests actually run FFmpeg and validate output
4. **No placeholder detection:** No sentinel value checks (e.g., "fail if filter is TODO string")

---

## E) Proposed Bead Rewrites

### Bead A: Canonical Chain Uses Real Filters

**ID:** audio_pro-NEW1
**Title:** Canonical chain must use real FFmpeg filters (no placeholders)
**Type:** bug
**Priority:** P0 (Critical - user-facing filtering broken)

**Description:**

The canonical signal chain (buildFullFilterChain) includes 3 placeholder stages that return empty strings instead of real FFmpeg filters:

1. **AutoGain / Leveling** (position 1) - `buildAutoGainFilter()` returns `""`
2. **Loudness** (position 2) - `buildLoudnessFilter()` returns `""`
3. **Noise Sampling DSP** (position 3) - `buildNoiseReductionFilter()` returns `""`

**Impact:** Users enabling these features get no filtering applied.

**Acceptance Criteria:**

1. All 8 stages in buildFullFilterChain return real FFmpeg filters OR are intentionally disabled via config
2. No function returns a hard-coded placeholder string (empty or sentinel)
3. Tests validate presence/absence of each filter stage in produced filtergraph
4. Integration test runs actual FFmpeg command and validates filter presence

**Definition of Done:**

- [ ] buildAutoGainFilter() returns real filter or is marked as "feature not implemented" with UI disabled
- [ ] buildLoudnessFilter() returns real filter or is integrated into loudness gain append step
- [ ] buildNoiseReductionFilter() returns real noise reduction filter (afftdn or alternative)
- [ ] Tests fail if any stage returns empty when enabled
- [ ] Full test suite passes (unit + integration)
- [ ] Documentation updated to reflect actual implemented filters

**Implementation Notes:**

Option 1: Restore afftdn for Noise Reduction (commit 6da51f3 code)
Option 2: Implement proper Noise Sampling DSP using region.startMs/endMs (two-pass)
Option 3: Mark AutoGain/Loudness as "not implemented" and remove from UI

---

### Bead B: Preview/Render Parity Enforced by Tests

**ID:** audio_pro-NEW2
**Title:** Test-enforced Preview/Render filter parity
**Type:** task
**Priority:** P1 (High - prevents silent divergence)

**Description:**

Preview and Render currently use the same buildFullFilterChain() function, ensuring parity. However, no tests enforce this constraint, allowing future divergence.

**Acceptance Criteria:**

1. Test compares Preview and Render filter chains (normalized, ignoring time params)
2. Test asserts equality of filtergraph strings
3. Test fails if either path uses different chain builder
4. Test validates both paths call buildFullFilterChain() with identical parameters

**Definition of Done:**

- [ ] Integration test captures filtergraph from Preview render
- [ ] Integration test captures filtergraph from Full render
- [ ] Test normalizes graphs (removes -ss, -t flags) and asserts equality
- [ ] Test validates both call same buildFullFilterChain() function
- [ ] Test suite passes

---

### Bead C: Noise Sampling DSP End-to-End

**ID:** audio_pro-NEW3
**Title:** noiseSampleRegion influences NR filter deterministically
**Type:** feature
**Priority:** P1 (High - core feature)

**Description:**

The noiseSampleRegion parameter flows end-to-end (UI → IPC → buildNoiseReductionFilter) but has no effect because the filter returns empty string.

**Current Behavior:**
```typescript
export function buildNoiseReductionFilter(nr: NoiseReductionParams, region: QuietCandidate | null): string {
  if (!nr.enabled || !region || nr.strength <= 0) return ''

  console.log('[Noise Sampling DSP] Bypassed - awaiting implementation. Region:', region, 'Strength:', nr.strength)
  return ''  // ← NO FILTER APPLIED
}
```

**Desired Behavior:**
- If region exists AND NR enabled: return real noise reduction filter
- If region absent OR NR disabled: return empty (bypass)

**Acceptance Criteria:**

1. When NR enabled + region present: buildNoiseReductionFilter() returns non-empty FFmpeg filter
2. When NR disabled OR region absent: buildNoiseReductionFilter() returns empty string
3. Tests validate both branches (with/without region, enabled/disabled)
4. Filter uses region.startMs, region.endMs in implementation

**Definition of Done:**

- [ ] Implement Noise Sampling DSP (afftdn restoration OR two-pass profiling)
- [ ] Tests validate filter output when region present
- [ ] Tests validate bypass when region absent
- [ ] Tests validate strength parameter affects filter output
- [ ] Integration test validates actual FFmpeg filtering behavior
- [ ] Test suite passes

**Implementation Options:**

**Option A:** Restore afftdn (conservative, maps strength to nr/nf params)
- Pros: Already implemented (commit 6da51f3), well-tested, immediate restoration
- Cons: Doesn't use region timing (future enhancement needed)

**Option B:** Two-pass Noise Sampling DSP
- Pros: Uses region.startMs/endMs for noise profiling, proper implementation
- Cons: More complex, requires two FFmpeg passes

---

### Bead D: Regression Tests for Placeholder Detection

**ID:** audio_pro-NEW4
**Title:** Prevent placeholder/stub filter regressions
**Type:** task
**Priority:** P2 (Medium - prevents future regressions)

**Description:**

Tests currently validate specific filter outputs but don't detect when working filters are replaced with placeholders.

**Acceptance Criteria:**

1. Tests fail if any filter builder returns sentinel placeholder string when feature is enabled
2. Tests fail if Preview path uses different builder than Render
3. Tests validate all enabled stages produce non-empty filter strings
4. Tests detect "TODO" or "Placeholder" in filter output

**Definition of Done:**

- [ ] Add test: "buildFullFilterChain fails fast if enabled feature returns empty"
- [ ] Add test: "Preview and Render use same chain builder function"
- [ ] Add test: "No filter builder returns placeholder sentinel when enabled"
- [ ] All filter builders have tests for enabled + disabled states
- [ ] Test suite passes

---

## F) Minimal Next Steps (Investigation → Implementation Handoff)

### Immediate Actions (Do NOT implement in investigation)

1. **Reopen Beads:**
   ```bash
   bd update audio_pro-dsj --status=open
   bd update audio_pro-y69 --status=open
   bd update audio_pro-5a3 --status=open
   bd update audio_pro-bqv --status=open
   bd update audio_pro-7vy --status=open
   bd update audio_pro-6ek --status=open  # Not related to filters, but reopened for review
   ```

2. **Create New Beads:**
   ```bash
   bd create --title="Canonical chain must use real FFmpeg filters (no placeholders)" \
             --type=bug --priority=0

   bd create --title="Test-enforced Preview/Render filter parity" \
             --type=task --priority=1

   bd create --title="noiseSampleRegion influences NR filter deterministically" \
             --type=feature --priority=1

   bd create --title="Prevent placeholder/stub filter regressions" \
             --type=task --priority=2
   ```

3. **Decision Point: Merge rescue/restore-audio-filters?**

   **Option A:** Merge rescue branch (restores afftdn) as immediate fix
   - Pros: Immediate restoration of working noise reduction
   - Cons: Still leaves AutoGain/Loudness placeholders

   **Option B:** Implement all placeholders before merging
   - Pros: Complete solution, no half-measures
   - Cons: Longer to restore functionality

   **Recommended:** Merge rescue branch first (fixes 1 of 3 placeholders), then implement AutoGain/Loudness separately

### Implementation Order

1. **Immediate (P0):**
   - Merge rescue/restore-audio-filters branch (restores afftdn)
   - Add regression tests for placeholder detection

2. **Short-term (P1):**
   - Implement buildLoudnessFilter() (or integrate into existing loudness gain step)
   - Implement buildAutoGainFilter() (or disable in UI if not needed)
   - Add Preview/Render parity tests

3. **Medium-term (P2):**
   - Implement proper Noise Sampling DSP using region timing (two-pass)
   - Add integration tests for FFmpeg command validation

---

## Appendix: Evidence Files

### Commit References

- **6da51f3** (2025-12-26 18:16:05): Last working afftdn implementation
- **f7211a3** (2025-12-26 18:32:39): Placeholders introduced, afftdn removed
- **cd069f0** (2025-12-26 22:51:05): Rescue branch restoring afftdn

### File References

**Code:**
- `electron/ffmpeg-manager.ts:779-795` - Placeholder functions (AutoGain, Loudness)
- `electron/ffmpeg-manager.ts:532-542` - Placeholder buildNoiseReductionFilter()
- `electron/ffmpeg-manager.ts:813-865` - buildFullFilterChain() with placeholders
- `electron/main.ts:258` - Preview path calls buildFullFilterChain()
- `electron/main.ts:428` - Render path calls buildFullFilterChain()

**Tests:**
- `electron/__tests__/filter-builders.test.ts:596-700` - NR tests modified to expect empty string
- `electron/__tests__/filter-builders.test.ts` - No tests for AutoGain/Loudness

### Bead References

**Closed Today (Need Reopening):**
- audio_pro-dsj - Transport Model Lock
- audio_pro-y69 - Canonical Signal Chain
- audio_pro-5a3 - Noise Sampling DSP
- audio_pro-bqv - Preview/Export Parity
- audio_pro-7vy - Phase 3: Preview Pipeline Reuse Investigation
- audio_pro-6ek - test: deflake final-render gate

---

## Investigation Conclusion

**Placeholders were intentionally introduced in commit f7211a3 as part of "enforcing canonical spec."** This was not an accident, rebase error, or merge conflict. The implementation strategy appears to have been:

1. Define canonical chain order (8 stages)
2. Add placeholder functions for unimplemented stages
3. Modify tests to accept placeholders
4. Close beads claiming compliance with spec

**The beads were closed prematurely.** The "canonical spec" requirement was interpreted as "define the chain order" rather than "implement all 8 stages."

**Rescue branch (cd069f0) correctly restores 1 of 3 placeholders** by bringing back afftdn from commit 6da51f3.

**Recommendation:** Reopen beads, merge rescue branch, implement remaining placeholders, add regression tests.

---

*End of Investigation Report*
