# Audio Tool — Setup & Usage

## Bootstrap

```bash
# Create venv
python3 -m venv .venv

# Activate
source .venv/bin/activate

# Upgrade pip
pip install --upgrade pip

# Install dependencies
pip install -r requirements.txt
```

## Usage

### List audio devices

```bash
python audio_tool.py --list-devices
```

### Record a 5-second clip

```bash
python audio_tool.py --seconds 5 --out test.wav
```

### Record with highpass filter (removes low rumble)

```bash
python audio_tool.py --seconds 5 --highpass 120 --normalize --out hp.wav
```

### Record with bandpass (telephone quality) + normalization

```bash
python audio_tool.py --seconds 5 --highpass 300 --lowpass 3400 --normalize --out phone.wav
```

### Record without playback

```bash
python audio_tool.py --seconds 5 --no-play --out silent.wav
```

### Full options

```bash
python audio_tool.py --help
```

## macOS Microphone Permission

On first run, macOS will prompt for microphone permission for your terminal app (Terminal, iTerm2, VS Code, etc.).

If recording is silent or throws an error:

1. Open **System Settings**
2. Go to **Privacy & Security → Microphone**
3. Enable permission for your terminal app
4. Restart the terminal and try again

---

## Phase 1: Offline WAV Filtering

Filter existing WAV files without recording.

### Simple highpass (remove low rumble)

```bash
python filter_wav.py --in test.wav --out hp.wav --highpass 120
```

### Telephone band + normalization

```bash
python filter_wav.py --in test.wav --out phone.wav --highpass 300 --lowpass 3400 --normalize
```

### Bandpass only

```bash
python filter_wav.py --in test.wav --out band.wav --bandpass 500 2000
```

### Full options

```bash
python filter_wav.py --help
```

---

## Phase 2: A/B Playback Comparison

Compare original and filtered audio side-by-side.

### List output devices

```bash
python -m sounddevice
```

### Compare original vs filtered

```bash
python ab_play.py --a test_15secs.wav --b hp.wav --normalize
```

### Controls

| Key | Action |
|-----|--------|
| SPACE | Play/pause |
| TAB | Toggle A/B at current position |
| ←/→ | Seek ±1 second |
| H/L | Seek ±5 seconds |
| Q | Quit |

### Specify output device

```bash
python ab_play.py --a original.wav --b filtered.wav --device 2
```

Note: This is output-only; microphone permission is not required.

---

## Electron FFmpeg EQ App

A minimal Electron desktop app for testing FFmpeg-based audio EQ on video files.

### Prerequisites

- Node.js 18+
- FFmpeg installed and on PATH (`ffmpeg` command works)

### Install dependencies

```bash
npm install
```

### Run in development mode

```bash
npm run dev
```

### How to use

1. Click "Choose Video..." and select an MP4/MOV/MKV file
2. Set preview start time and duration
3. Adjust the 3-band EQ (frequency, gain, Q)
4. Click "Render Preview" — waits for FFmpeg
5. Click "Play Original" or "Play Processed" to A/B compare

### Output files

Preview files are written to `./tmp/`:
- `original_preview.mp4` — clip without EQ
- `processed_preview.mp4` — clip with EQ applied

### Build for distribution (optional)

```bash
npm run electron:build
```
