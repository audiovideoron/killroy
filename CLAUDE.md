# Kilroy Audio Pro

Electron desktop app for real-time audio processing and A/B comparison on video files.

## Communication Style

Be concise and to the point. No extra information or words.

## What It Does

- Load a video file (MP4, MOV, MKV)
- Apply audio processing: 3-band parametric EQ, high/low-pass filters, compressor/limiter, noise reduction
- Render a preview clip via FFmpeg
- Instantly A/B compare original vs processed audio

## Tech Stack

- **Electron** - Desktop app framework
- **React + TypeScript** - UI
- **Vite** - Build tool
- **FFmpeg** - Audio/video processing (called via child_process)
- **Vitest** - Testing

## Project Structure

```
├── electron/           # Electron main process
│   ├── main.ts         # FFmpeg calls, IPC handlers, file dialogs
│   └── preload.ts      # IPC bridge to renderer
│
├── src/                # React renderer
│   ├── App.tsx         # Main UI component
│   ├── components/     # Reusable UI (Knob, Toggle)
│   └── features/       # Feature modules (future extraction)
│
├── shared/             # Shared TypeScript types
│   └── types.ts        # EQBand, FilterParams, CompressorParams, etc.
│
├── media/              # Test video files (gitignored)
├── tmp/                # Rendered preview clips (gitignored)
│
├── .claude/
│   ├── agents/         # AI agents (security-scanner, codebase-analyzer)
│   └── commands/       # Slash commands (commit, architecture)
│
└── .github/workflows/  # CI/CD (tests, security scan, code quality)
```

## Development

```bash
# Install dependencies
npm install

# Run in dev mode
npm run dev

# Run tests
npm run test:alpha

# Build for distribution
npm run electron:build
```

## Architecture Patterns

See `.claude/commands/architecture.md` for enforcement rules:

1. **Shared types** - All interfaces in `shared/types.ts` (no duplication)
2. **Component size** - Max 300 lines per component
3. **Process separation** - Main handles native APIs, renderer handles UI
4. **IPC typing** - All channels typed in preload.ts
5. **Feature organization** - Group by domain in `src/features/`

## Implementation Standards

- **No placeholders**: Functions must return valid, functional output. Empty strings, TODO comments, or stub implementations are failures.
- **No partial implementations**: If a feature has multiple stages, implement all stages fully or ask for clarification.
- **If unsure, ask**: Do not stub or placeholder. Ask the user how to proceed.

When receiving structured implementation prompts, apply the `optimize-prompt` skill before proceeding.

## Audio Signal Chain

```
Input → HPF → Noise Reduction → EQ (3 bands) → LPF → Compressor/Limiter → Output
```

Built in `electron/main.ts:buildFullFilterChain()` as FFmpeg filter string.

## Future Direction

- AI-powered transcription (Whisper)
- Text-based video editing (remove ums/ahs via subtitle timestamps)
- Python may return for AI/ML features

## Issue Tracking

Uses **beads** (`bd` CLI). See `AGENTS.md` for workflow.

```bash
bd ready      # Find available work
bd show <id>  # View issue
bd close <id> # Complete work
bd sync       # Sync with git
```

## Proactive Issue Discovery

When working in this codebase, create beads for discovered work:

**Create immediately:**
- Bugs: `bd create "Bug: [description]" --type bug --priority 1`
- Security issues: `bd create "Security: [description]" --type bug --priority 0`
- Tech debt: `bd create "Tech debt: [description]" --type task --priority 3`

**Ask user first:**
- Enhancement ideas, new features, major refactoring

**Don't track:**
- Issues fixed immediately as part of current work
- Trivial matters (typos, formatting)

After creating a bead, mention it briefly: "Filed beads-xxx for [issue]"
