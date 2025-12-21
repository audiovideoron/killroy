---
description: "Electron/React architecture compliance check - prevents spaghetti code"
---

Architecture gatekeeper for Electron/React applications. Run on new feature plans to enforce clean code patterns.

## Usage
`/architecture docs/plan/[filename]` - Check a plan file for violations

---

## Pattern #1: Shared Types Location

**Rule:** Interfaces used across Electron processes MUST live in `shared/types.ts`.

**Valid:**
```typescript
// shared/types.ts - single source of truth
export interface EQBand { frequency: number; gain: number; q: number; enabled: boolean }
export interface RenderOptions { inputPath: string; bands: EQBand[]; /* ... */ }

// electron/main.ts
import { EQBand, RenderOptions } from '../shared/types'

// src/App.tsx
import type { EQBand } from '../shared/types'
```

**Invalid:**
```typescript
// Defining same interface in multiple files
// electron/main.ts
interface EQBand { frequency: number; gain: number; q: number; enabled: boolean }

// electron/preload.ts
interface EQBand { frequency: number; gain: number; q: number; enabled: boolean }

// src/App.tsx
interface EQBand { frequency: number; gain: number; q: number; enabled: boolean }
```

---

## Pattern #2: Component Size Limits

**Rule:** No React component file > 300 lines. Extract sub-components.

**Valid:**
- `src/components/EQStrip.tsx` (~150 lines) - focused on EQ UI
- `src/components/CompressorStrip.tsx` (~100 lines) - focused on dynamics

**Invalid:**
- Single 500+ line component with all UI inline
- Multiple unrelated features in one component

**Auto-Fix:** Extract sections into focused components.

---

## Pattern #3: Main Process Responsibilities

**Rule:** `electron/main.ts` handles: file system, native dialogs, child processes, protocol handlers.

**Valid in main.ts:**
- FFmpeg spawning and filter chain building
- File dialog operations
- Custom protocol registration
- IPC handlers for native operations

**Invalid in main.ts:**
- UI rendering logic
- React component code
- Styling definitions

---

## Pattern #4: Renderer Process Boundaries

**Rule:** `src/` code handles: React components, state, user interactions. NO direct Node.js APIs.

**Valid in src/:**
- React components and hooks
- UI state management
- Calling `window.electronAPI.*` methods

**Invalid in src/:**
- `import { spawn } from 'child_process'`
- `import * as fs from 'fs'`
- Direct `ipcRenderer` access (use preload bridge)

---

## Pattern #5: IPC Contract Typing

**Rule:** All IPC channels typed in `electron/preload.ts` via `contextBridge.exposeInMainWorld`.

**Valid:**
```typescript
// electron/preload.ts
contextBridge.exposeInMainWorld('electronAPI', {
  selectFile: (): Promise<string | null> => ipcRenderer.invoke('select-file'),
  renderPreview: (options: RenderOptions): Promise<RenderResult> =>
    ipcRenderer.invoke('render-preview', options)
})
```

**Invalid:**
```typescript
// Untyped or scattered IPC calls
ipcRenderer.send('some-channel', data)  // No type safety
```

---

## Pattern #6: Feature Directory Organization

**Rule:** Group related components, hooks, and styles by feature domain.

**Valid:**
```
src/features/eq/
├── EQStrip.tsx
├── EQBand.tsx
├── useEQState.ts
└── eq.module.css

src/features/dynamics/
├── CompressorStrip.tsx
├── NoiseReduction.tsx
└── useDynamicsState.ts
```

**Invalid:**
```
src/
├── App.tsx           (all features mixed)
├── Knob.tsx
└── styles.css        (all styles mixed)
```

---

## Pattern #7: Style Organization

**Rule:** No inline style objects > 50 lines. Extract to CSS modules or theme constants.

**Valid:**
```typescript
// src/theme/channelStrip.ts
export const stripContainer = {
  width: 150,
  background: 'linear-gradient(...)',
  border: '1px solid #555'
}

// Component
import { stripContainer } from '../theme/channelStrip'
<div style={stripContainer}>
```

**Invalid:**
```typescript
// 100+ lines of inline styles in render
<div style={{
  width: 150,
  background: `linear-gradient(180deg, ...)`,
  // ... 80 more properties
}}>
```

---

## Pattern #8: State Colocation

**Rule:** Feature state lives with feature, not all in root App.tsx.

**Valid:**
```typescript
// src/features/eq/useEQState.ts
export function useEQState() {
  const [bands, setBands] = useState<EQBand[]>([...])
  const updateBand = (index: number, field: keyof EQBand, value: number) => {...}
  return { bands, updateBand }
}

// src/App.tsx - composes features
function App() {
  const eq = useEQState()
  const dynamics = useDynamicsState()
  return <><EQStrip {...eq} /><DynamicsStrip {...dynamics} /></>
}
```

**Invalid:**
```typescript
// All state in App.tsx
function App() {
  const [bands, setBands] = useState([...])
  const [hpf, setHpf] = useState({...})
  const [lpf, setLpf] = useState({...})
  const [compressor, setCompressor] = useState({...})
  const [noiseReduction, setNoiseReduction] = useState({...})
  // 10+ useState calls, 500+ lines of handlers
}
```

---

## Gatekeeper Checklist

When reviewing a feature plan:

1. [ ] Types defined in `shared/types.ts`?
2. [ ] Component under 300 lines?
3. [ ] Main process doing only native work?
4. [ ] Renderer not using Node.js APIs directly?
5. [ ] IPC channels typed in preload?
6. [ ] Feature files grouped in feature directory?
7. [ ] Large style objects extracted?
8. [ ] State colocated with feature?

**If violations found:** Update the plan to fix them before implementation.
