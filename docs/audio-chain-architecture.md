# Audio Chain Architecture

> Investigation report for Audio Pro's audio processing pipeline.
> Generated: 2025-12-24

## A. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER INTERFACE                                  │
│                                                                             │
│  ┌─────────────┐   ┌─────────────────────────────────────────────────────┐ │
│  │ AutoMix Bar │   │              AudioControls Component                │ │
│  │ LIGHT/MED/  │   │  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐  │ │
│  │ HEAVY       │   │  │ HPF │ │ NR  │ │ EQ  │ │ LPF │ │AutoM│ │Comp │  │ │
│  └──────┬──────┘   │  └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘  │ │
│         │          └─────┼──────┼──────┼──────┼──────┼──────┼─────────┘ │
│         │                │      │      │      │      │      │           │
└─────────┼────────────────┼──────┼──────┼──────┼──────┼──────┼───────────┘
          │                │      │      │      │      │      │
          ▼                ▼      ▼      ▼      ▼      ▼      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           App.tsx (React State)                             │
│                                                                             │
│  handleAutoMixPresetChange()     State: hpf, noiseReduction, bands, lpf,   │
│  ├─ Sets autoMix.preset           autoMix, compressor                       │
│  ├─ Configures NR, Comp, HPF                                                │
│  └─ Based on LIGHT/MEDIUM/HEAVY                                             │
│                                                                             │
│  handleRender() ─────────────────────────────────────────────────────────►  │
└─────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        │ IPC: 'render-preview'
                                        │ RenderOptions { bands, hpf, lpf,
                                        │   compressor, noiseReduction, autoMix }
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        electron/main.ts (Main Process)                       │
│                                                                             │
│  ipcMain.handle('render-preview', ...)                                      │
│  ├─ Validate input path                                                     │
│  ├─ Create job temp directory                                               │
│  ├─ Probe media metadata                                                    │
│  ├─ Render original (no filters)                                            │
│  └─ Render processed ─────────────────────────────────────────────────────► │
└─────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        │ buildFullFilterChain(hpf, bands, lpf,
                                        │   compressor, noiseReduction, autoMix)
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    electron/ffmpeg-manager.ts (Filter Chain)                 │
│                                                                             │
│  buildFullFilterChain()                                                     │
│  ├─ 1. HPF         → highpass=f={freq}                                      │
│  ├─ 2. NR          → afftdn=nr={nr}:nf={nf}:tn=true                        │
│  ├─ 3. EQ          → equalizer=f={f}:t=h:w={w}:g={g}                       │
│  ├─ 4. LPF         → lowpass=f={freq}                                       │
│  ├─ 5. AutoMix     → dynaudnorm=f={framelen}:g={gauss}:p=0.9:m={maxgain}   │
│  └─ 6. Compressor  → acompressor/alimiter/volume                            │
│                                                                             │
│  Returns: comma-separated filter string for -af                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        │ FFmpeg command with -af
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FFmpeg Subprocess                               │
│                                                                             │
│  ffmpeg -y -ss {start} -t {dur} -i {input}                                  │
│         -c:v copy -af "{filterChain}" -c:a aac -b:a 192k {output}           │
└─────────────────────────────────────────────────────────────────────────────┘
```

## B. File Map

| File | Responsibility |
|------|----------------|
| `src/App.tsx` | React state for all audio params; `handleAutoMixPresetChange()` configures full chain per preset |
| `src/components/AudioControls.tsx` | UI for AutoMix bar + NR/Comp/EQ strips; calls `onAutoMixPresetChange(preset)` |
| `shared/types.ts` | Type definitions: `AutoMixParams`, `AutoMixPreset`, `RenderOptions`, etc. |
| `electron/main.ts` | IPC handler `render-preview`; calls `buildFullFilterChain()`, spawns FFmpeg |
| `electron/ffmpeg-manager.ts` | Filter chain builders: `buildFullFilterChain()`, `buildAutoMixFilter()`, `buildEQFilter()`, etc. |
| `electron/__tests__/filter-builders.test.ts` | Unit tests for all filter builders (1007 lines, comprehensive) |

## C. FFmpeg Command Examples

### LIGHT Preset

**State applied:**
- AutoMix: enabled, preset=LIGHT
- HPF: 120Hz, enabled
- NR: disabled
- Compressor: disabled

**Resulting `-af` string:**
```
highpass=f=120,dynaudnorm=f=800:g=51:p=0.9:m=3
```

### MEDIUM Preset

**State applied:**
- AutoMix: enabled, preset=MEDIUM
- HPF: 120Hz, enabled
- NR: 25%, enabled
- Compressor: -18dB, 3:1, attack=10ms, release=100ms, makeup=0dB, enabled

**Resulting `-af` string:**
```
highpass=f=120,afftdn=nr=10:nf=-46:tn=true,dynaudnorm=f=500:g=35:p=0.9:m=6,acompressor=threshold=-18dB:ratio=3:attack=0.01:release=0.1:makeup=0dB
```

### HEAVY Preset

**State applied:**
- AutoMix: enabled, preset=HEAVY
- HPF: 120Hz, enabled
- NR: 50%, enabled
- Compressor: -15dB, 4:1, attack=10ms, release=100ms, makeup=3dB, enabled

**Resulting `-af` string:**
```
highpass=f=120,afftdn=nr=20:nf=-43:tn=true,dynaudnorm=f=200:g=21:p=0.9:m=10,acompressor=threshold=-15dB:ratio=4:attack=0.01:release=0.1:makeup=3dB
```

## D. Current Filter Chain Order

The order is defined in `buildFullFilterChain()` at `electron/ffmpeg-manager.ts:541-581`:

```
1. HPF (highpass)     - Remove low-frequency rumble
2. NR (afftdn)        - Noise reduction early, before EQ
3. EQ (equalizer)     - Parametric EQ bands (up to 3)
4. LPF (lowpass)      - Remove high-frequency content
5. AutoMix (dynaudnorm) - Dynamic normalization for speech leveling
6. Compressor         - Final dynamics control (acompressor/alimiter/volume)
```

## E. State Flow

### React State (App.tsx)

```typescript
// Individual processor states
const [hpf, setHpf] = useState<FilterParams>({ frequency: 80, q: 0.7, enabled: false })
const [lpf, setLpf] = useState<FilterParams>({ frequency: 12000, q: 0.7, enabled: false })
const [bands, setBands] = useState<EQBand[]>([...])
const [compressor, setCompressor] = useState<CompressorParams>({...})
const [noiseReduction, setNoiseReduction] = useState<NoiseReductionParams>({...})
const [autoMix, setAutoMix] = useState<AutoMixParams>({ preset: 'MEDIUM', enabled: false })
```

### Preset Application (App.tsx:55-97)

```typescript
const handleAutoMixPresetChange = useCallback((preset: AutoMixPreset) => {
  setAutoMix({ preset, enabled: true })

  if (preset === 'LIGHT') {
    setNoiseReduction({ strength: 50, enabled: false })
    setCompressor(prev => ({ ...prev, enabled: false }))
    setHpf({ frequency: 120, q: 0.7, enabled: true })
  } else if (preset === 'MEDIUM') {
    setNoiseReduction({ strength: 25, enabled: true })
    setCompressor({ threshold: -18, ratio: 3, ... enabled: true })
    setHpf({ frequency: 120, q: 0.7, enabled: true })
  } else if (preset === 'HEAVY') {
    setNoiseReduction({ strength: 50, enabled: true })
    setCompressor({ threshold: -15, ratio: 4, ... makeup: 3, enabled: true })
    setHpf({ frequency: 120, q: 0.7, enabled: true })
  }
}, [])
```

### Persistence

- **Not persisted** - All state is in-memory React state
- Resets to defaults on app reload
- No localStorage/IndexedDB/file persistence

### Render Flow

1. User clicks "Render Preview" → `handleRender()`
2. Calls `window.electronAPI.renderPreview(RenderOptions)`
3. IPC to main process → `ipcMain.handle('render-preview')`
4. Main process calls `buildFullFilterChain(hpf, bands, lpf, compressor, noiseReduction, autoMix)`
5. FFmpeg spawned with resulting `-af` filter string

## F. Test Coverage

### Existing Tests

| File | Coverage |
|------|----------|
| `electron/__tests__/filter-builders.test.ts` | Comprehensive unit tests for `buildEQFilter`, `buildCompressorFilter`, `buildNoiseReductionFilter`, `buildFullFilterChain` |
| Missing | `buildAutoMixFilter()` - **NO UNIT TESTS** |
| Missing | AutoMix integration in `buildFullFilterChain()` - **NO UNIT TESTS** |

### Where New Tests Should Go

1. **Unit tests for AutoMix**: Add to `electron/__tests__/filter-builders.test.ts`
   - Test `buildAutoMixFilter()` for each preset
   - Test AutoMix in `buildFullFilterChain()` integration

2. **Preset application tests**: Add to `src/__tests__/`
   - Test `handleAutoMixPresetChange()` sets correct state for each preset

## G. Proposed v2 Insertion Points (Loudness Analysis + Dynamic Gain)

### Option 1: Two-Pass Render

**Analysis Pass:**
- Run FFmpeg with `loudnorm=print_format=json` to analyze input loudness
- Parse LUFS/LRA/peak values from output

**Apply Pass:**
- Use analyzed values to compute dynamic gain
- Apply as filter in chain (new stage between AutoMix and Compressor)

**Pros:**
- Accurate loudness measurement
- Can use EBU R128 standard values
- Predictable output levels

**Cons:**
- Doubles render time (two FFmpeg invocations)
- More complex job management
- Need to store analysis results between passes

**Insertion Point:**
- Add `analyzeLoudness()` in `ffmpeg-manager.ts`
- Call before `buildFullFilterChain()` in `main.ts`
- Pass loudness data to new `buildDynamicGainFilter()` function

### Option 2: Single-Pass Approximation

**Approach:**
- Use `dynaudnorm` (already present via AutoMix) with more aggressive settings
- OR use `loudnorm` filter in single-pass mode (less accurate but functional)

**Pros:**
- No additional render time
- Simpler implementation
- Works with existing architecture

**Cons:**
- Less accurate than two-pass
- May cause pumping on difficult material
- Limited control over final LUFS target

**Insertion Point:**
- Modify `buildAutoMixFilter()` to accept loudness target parameter
- OR add new filter stage after AutoMix using `loudnorm=I=-16:TP=-1.5:LRA=11`

### Recommendation

For speech-focused content (meetings, interviews, podcasts):
- **Start with Option 2** (single-pass with `loudnorm`)
- Position: After AutoMix, before Compressor
- New chain order: `HPF → NR → EQ → LPF → AutoMix → Loudnorm → Compressor`

If precision is required later:
- **Upgrade to Option 1** (two-pass)
- Add `--analyze` flag to preview render
- Cache analysis results per file

---

## Summary

1. **Entry point**: `App.tsx:handleRender()` → IPC → `main.ts:render-preview`
2. **Filter construction**: `ffmpeg-manager.ts:buildFullFilterChain()` (line 541)
3. **AutoMix presets**: Defined in `ffmpeg-manager.ts:526-530`, applied via `App.tsx:55-97`
4. **Chain order**: HPF → NR → EQ → LPF → AutoMix → Compressor
5. **v2 insertion**: Between AutoMix and Compressor (stage 5.5)
6. **State**: React useState, not persisted
7. **Test gap**: No unit tests for `buildAutoMixFilter()` - add to `filter-builders.test.ts`
