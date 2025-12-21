# Kilroy Audio Pro

A desktop application for real-time audio processing and A/B comparison on video files. Built with Electron, React, and FFmpeg.

## Features

- **3-Band Parametric EQ** — Adjustable frequency, gain, and Q for low, mid, and high bands
- **High/Low-Pass Filters** — Remove rumble or tame harshness
- **Noise Reduction** — FFmpeg's `afftdn` filter to reduce background noise
- **Compressor/Limiter** — Threshold, ratio, attack, release, and makeup gain
- **A/B Comparison** — Instantly switch between original and processed audio
- **Non-destructive** — Renders preview clips, leaving source files untouched

## Prerequisites

- **Node.js** 18+
- **FFmpeg** installed and on PATH (`ffmpeg` command must work in terminal)

## Installation

```bash
git clone https://github.com/audiovideoron/killroy.git
cd killroy
npm install
```

## Development

```bash
npm run dev
```

Opens the app with hot reload and DevTools.

## Usage

1. Click **"Choose Video..."** and select a video file (MP4, MOV, MKV, AVI, WebM)
2. Set the preview **start time** and **duration** in seconds
3. Adjust audio processing:
   - **NR/COMP strip** — Noise reduction and dynamics
   - **EQ strip** — 3-band parametric EQ with HP/LP filters
4. Click **"Render Preview"** to process through FFmpeg
5. Use **"Play Original"** / **"Play Processed"** to A/B compare

## Audio Signal Chain

```
Input → HPF → Noise Reduction → EQ (3 bands) → LPF → Compressor/Limiter → Output
```

## Output Files

Preview clips are written to `./tmp/`:
```
{filename}-original-{timestamp}.mp4
{filename}-processed-{timestamp}.mp4
```

## Testing

```bash
npm run test:alpha
```

## Build for Distribution

```bash
npm run electron:build
```

Produces platform-specific binaries in `./dist/`.

## Tech Stack

- **Electron** — Desktop app framework
- **React** — UI components
- **TypeScript** — Type safety
- **Vite** — Fast builds and HMR
- **FFmpeg** — Audio/video processing
- **Vitest** — Testing

## Project Structure

```
├── electron/        # Main process (FFmpeg, IPC, native APIs)
├── src/             # React renderer (UI)
│   └── components/  # Reusable UI components
├── shared/          # TypeScript types shared across processes
└── media/           # Test video files (gitignored)
```

## License

MIT
