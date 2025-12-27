# Audio Processing: Signal Chain & Architecture

> **Source of Truth**: `electron/ffmpeg-manager.ts:buildFullFilterChain()` (lines 792-865)

## Audio Filter Chain (Canonical Order)

**Signal flow**: LEFT → RIGHT through enabled stages only

```
┌─────────────────────────────────────────────────────────────────────┐
│                    CANONICAL SIGNAL CHAIN                           │
│                   (LOCKED - DO NOT REORDER)                         │
└─────────────────────────────────────────────────────────────────────┘

INPUT ──▶ HPF ──▶ LPF ──▶ EQ ──▶ Compressor ──▶ AutoMix ──▶ OUTPUT
          │        │      │         │              │
          1        2      3         4              5
```

### Stage Details

| # | Stage | FFmpeg Filter | Parameters | User Control |
|---|-------|--------------|------------|--------------|
| 1 | **HPF** | `highpass=f={freq}` | 80-400 Hz | Frequency slider, enable toggle |
| 2 | **LPF** | `lowpass=f={freq}` | 4k-16k Hz | Frequency slider, enable toggle |
| 3 | **EQ** | `equalizer=f={f}:t=h:w={w}:g={g}` | 3 bands, ±24 dB/band, Q: 0.1-10 | Per-band frequency/gain/Q, enable toggle |
| 4 | **Compressor** | `acompressor` / `alimiter` / `volume` | Threshold, ratio, attack, release, makeup | Mode selector (COMP/LIMIT/LEVEL), parameter knobs |
| 5 | **AutoMix** | `dynaudnorm=f={f}:g={g}:p=0.9:m={m}` | LIGHT/MEDIUM/HEAVY presets | Preset selector, enable toggle |

### Rationale for Order

1. **HPF/LPF first**: Remove unwanted frequency ranges before processing
2. **EQ third**: Tonal shaping on bandwidth-limited signal
3. **Compressor fourth**: Dynamics control on shaped signal
4. **AutoMix last**: Final-stage leveling as output processor (speech-focused)

## AutoMix Presets

Tailored for speech/dialogue: meetings, interviews, podcasts.

| Preset | Frame (ms) | Gauss | Max Gain | Use Case |
|--------|-----------|-------|----------|----------|
| **LIGHT** | 800 | 51 | 3x | Gentle leveling, preserves dynamics |
| **MEDIUM** | 500 | 35 | 6x | Balanced leveling for typical speech |
| **HEAVY** | 200 | 21 | 10x | Aggressive leveling for difficult recordings |

FFmpeg filter: `dynaudnorm=f={framelen}:g={gausssize}:p=0.9:m={maxgain}`

## Compressor Modes

| Mode | Filter | Behavior |
|------|--------|----------|
| **COMP** | `acompressor` | Standard compression with ratio control |
| **LIMIT** | `alimiter` | Hard limiting at threshold |
| **LEVEL** | `volume` | Makeup gain only (no dynamics processing) |

## Placeholder Stages (Not Yet Implemented)

The following stages are defined in `buildFullFilterChain()` but currently return empty strings:

1. **AutoGain / Leveling** (position 1) - Input level normalization
2. **Loudness** (position 2) - Loudness normalization
3. **Noise Sampling DSP** (position 3) - Region-based noise reduction

Helper functions exist for loudness analysis (`analyzeLoudness`, `calculateLoudnessGain`) but are not wired into the preview render flow.

## FFmpeg Command Example

**User settings:**
- HPF: 120 Hz (enabled)
- LPF: disabled
- EQ: disabled
- Compressor: -18 dB threshold, 3:1 ratio, 0 dB makeup (enabled)
- AutoMix: MEDIUM preset (enabled)

**Resulting filter chain:**
```
-af "highpass=f=120,acompressor=threshold=-18dB:ratio=3:attack=0.01:release=0.1:makeup=0dB,dynaudnorm=f=500:g=35:p=0.9:m=6"
```

---

## Code Architecture

### Preview Render Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                       PREVIEW RENDER FLOW                           │
└─────────────────────────────────────────────────────────────────────┘

                         ┌──────────────┐
                         │  INPUT FILE  │
                         │ (video/audio)│
                         └──────┬───────┘
                                │
               ┌────────────────┴────────────────┐
               │                                 │
               ▼                                 ▼
┌──────────────────────┐          ┌──────────────────────────┐
│   ORIGINAL PATH      │          │   PROCESSED PATH         │
│   (A/B Reference)    │          │   (User Filters)         │
└──────────────────────┘          └──────────────────────────┘
               │                                 │
               ▼                                 ▼
┌──────────────────────┐          ┌──────────────────────────┐
│ No audio filters     │          │ buildFullFilterChain()   │
│ -c:a aac -b:a 192k   │          │ Apply user controls      │
└──────┬───────────────┘          └──────┬───────────────────┘
       │                                 │
       ▼                                 ▼
┌──────────────────────┐          ┌──────────────────────────┐
│  original-XXX.mp4    │          │  processed-XXX.mp4       │
└──────────────────────┘          └──────────────────────────┘
```

### File Responsibilities

| File | Purpose | Key Exports |
|------|---------|-------------|
| **src/App.tsx** | Main React component, state management | useState hooks for all filter params |
| **src/components/AudioControls.tsx** | Filter UI controls | User input handlers |
| **shared/types.ts** | Shared TypeScript types | `FilterParams`, `EQBand`, `CompressorParams`, `AutoMixParams`, `RenderOptions` |
| **electron/preload.ts** | IPC bridge (renderer ↔ main) | `electronAPI.renderPreview()` |
| **electron/main.ts** | Main process, IPC handlers | `ipcMain.handle('render-preview')` |
| **electron/ffmpeg-manager.ts** | **Filter chain builders** (source of truth) | `buildFullFilterChain()`, `buildEQFilter()`, `buildCompressorFilter()`, `buildAutoMixFilter()` |

### React State Management

All audio processing parameters live in `App.tsx` as React state:

```typescript
// Filter state (not persisted - resets on app reload)
const [hpf, setHpf] = useState<FilterParams>({
  frequency: 80, q: 0.7, enabled: false
})
const [lpf, setLpf] = useState<FilterParams>({
  frequency: 12000, q: 0.7, enabled: false
})
const [bands, setBands] = useState<EQBand[]>([...])
const [compressor, setCompressor] = useState<CompressorParams>({...})
const [autoMix, setAutoMix] = useState<AutoMixParams>({
  preset: 'MEDIUM', enabled: false
})
```

**State Flow:**
1. User adjusts control → `AudioControls.tsx` callback
2. Callback updates state → `App.tsx` setter (e.g., `setHpf()`)
3. User clicks "Render Preview" → `handleRender()` in `App.tsx`
4. IPC call with current state → `window.electronAPI.renderPreview(options)`
5. Main process builds filter chain → `buildFullFilterChain()` in `ffmpeg-manager.ts`
6. FFmpeg renders clips → original + processed
7. Renderer receives paths → UI updates with video players

**Persistence**: All parameters are in-memory React state. **No persistence.** Settings reset to defaults on app reload.

### IPC Message Flow

```
Renderer Process              Main Process
────────────────              ────────────

User action
    │
    └─► window.electronAPI
        .renderPreview({
          inputPath,
          hpf, lpf, bands,
          compressor, autoMix,
          ...
        })
                    ────IPC────►  ipcMain.handle('render-preview')
                                      │
                                      ├─ Validate input
                                      ├─ Create temp dir
                                      ├─ Probe metadata
                                      ├─ Render original
                                      ├─ buildFullFilterChain()
                                      ├─ Render processed
                                      │
                    ◄────IPC────  return { original, processed }
    │
    └─ Update video players
       with new clip paths
```

---

## Final Render (Export)

**Important**: The final render uses EDL-based segment cuts ONLY.

```
INPUT ──▶ Segment extraction ──▶ Concat ──▶ OUTPUT
```

**NO audio processing filters are applied during export.** Audio filters only affect preview clips for A/B comparison.

---

## Developer Guide

### Adding a New Filter Stage

1. Add builder function in `electron/ffmpeg-manager.ts` (e.g., `buildMyFilter()`)
2. Insert into `buildFullFilterChain()` at appropriate position (respect canonical order)
3. Add unit tests in `electron/__tests__/filter-builders.test.ts`
4. Update this document with new stage details

### Testing

**Unit tests**: `electron/__tests__/filter-builders.test.ts` (1007 lines)
- Comprehensive tests for `buildEQFilter()`
- Comprehensive tests for `buildCompressorFilter()`
- Tests for `buildFullFilterChain()` integration
- **Gap**: No tests for `buildAutoMixFilter()` (should be added)

**Manual testing**:
```bash
npm run dev
# 1. Load test video
# 2. Adjust filters (HPF, EQ, Compressor, AutoMix)
# 3. Render preview
# 4. A/B compare original vs processed
# 5. Verify filter chain in console logs
```

### Debugging FFmpeg Commands

All FFmpeg invocations are logged to console with full arguments:
```
[ffmpeg] Starting job ffmpeg-xxx: ffmpeg -y -ss 0 -t 10 -i input.mp4 -af "highpass=f=120,..." -c:v copy -c:a aac -b:a 192k output.mp4
```

**Inspect filter chain** - Add console.log in `ffmpeg-manager.ts:buildFullFilterChain()`:
```typescript
const filterChain = filters.join(',')
console.log('[DEBUG] Filter chain:', filterChain)
return filterChain
```

### See Also

- Architecture rules: `.claude/commands/architecture.md`
- Issue tracking: Use `bd` CLI (see `CLAUDE.md`)
