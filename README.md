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
- **Whisper.cpp** (optional, for real transcription) — Install via Homebrew or build from source

## Installation

```bash
git clone https://github.com/audiovideoron/killroy.git
cd killroy
npm install
```

## First-Time Setup

After cloning, configure ASR (Automatic Speech Recognition):

```bash
# 1. Copy environment template
cp .envrc.example .envrc

# 2. Edit .envrc and set WHISPER_MODEL path
# (Or leave ASR_BACKEND=mock for testing with fake transcripts)

# 3. If using direnv
direnv allow

# 4. Verify ASR configuration
npm run asr:check
```

**Expected output (working):**
```
ASR Backend: whispercpp
Model path: /Users/yourname/whisper-models/ggml-base.bin
Binary path: /opt/homebrew/bin/whisper-cli
✓ Model file exists
✓ Binary exists
```

**Expected output (mock mode):**
```
ASR Backend: mock
(Using mock backend — no model/binary required)
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

## Transcript-Driven Editor (ASR)

The app includes a transcript-driven editor that uses ASR (Automatic Speech Recognition) to generate word-level transcripts.

### ASR Backend Configuration

By default, the app uses a **mock transcriber** for deterministic testing. To enable **real Whisper-based transcription**, configure the following environment variables:

```bash
# Enable Whisper.cpp transcriber
export ASR_BACKEND=whispercpp

# Path to whisper-cli binary (default: /opt/homebrew/bin/whisper-cli)
export WHISPER_CPP_BIN=/opt/homebrew/bin/whisper-cli

# REQUIRED: Path to GGML model file
export WHISPER_MODEL=/path/to/ggml-base.bin

# Optional: Number of threads (default: 4)
export WHISPER_THREADS=8

# Optional: Language code (default: en)
export WHISPER_LANGUAGE=en
```

### Installing Whisper.cpp

**Option 1: Homebrew (macOS)**
```bash
brew install whisper-cpp
```

**Option 2: Build from source**
```bash
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
make

# Download a model (e.g., base)
bash ./models/download-ggml-model.sh base
```

After installation, set `WHISPER_CPP_BIN` to the path of the `whisper-cli` binary and `WHISPER_MODEL` to the path of your chosen GGML model file (e.g., `models/ggml-base.bin`).

### Recommended Models

- **ggml-tiny.bin** — Fastest, lower accuracy (~75 MB)
- **ggml-base.bin** — Good balance (~150 MB) **← Recommended for development**
- **ggml-small.bin** — Better accuracy, slower (~500 MB)
- **ggml-medium.bin** — High accuracy, much slower (~1.5 GB)

### Using the Transcript Editor

1. Launch the app: `npm run dev`
2. Click **"Choose Video..."** and select a video file
3. Click **"Transcript Editor"** mode switcher
4. The app will:
   - Extract audio from the video
   - Run Whisper.cpp to generate word-level timestamps
   - Display the transcript for editing
5. Click words to select them, then click **"Delete Selected"** to remove from the edited video

Transcripts are **cached per file** — switching modes will not re-run ASR.

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
