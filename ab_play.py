#!/usr/bin/env python3
"""
A/B WAV playback tool for comparing audio files.

Controls:
    SPACE : play/pause
    TAB   : toggle A/B at current position
    ←/→   : seek -/+ 1 second
    H/L   : seek -/+ 5 seconds
    Q     : quit

Usage:
    python ab_play.py --a original.wav --b filtered.wav --normalize
"""

import argparse
import curses
import sys
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf


@dataclass
class PlaybackState:
    """Shared playback state."""
    active: int = 0  # 0=A, 1=B
    paused: bool = True
    pos: int = 0
    quit: bool = False
    lock: threading.Lock = None

    def __post_init__(self):
        self.lock = threading.Lock()


def normalize_peak(audio: np.ndarray, target: float = 0.95) -> np.ndarray:
    """Peak normalize audio to target level."""
    peak = np.abs(audio).max()
    if peak > 0:
        audio = audio * (target / peak)
    return audio


def load_wavs(path_a: Path, path_b: Path, do_normalize: bool):
    """Load and validate two WAV files."""
    if not path_a.exists():
        print(f"Error: File A not found: {path_a}")
        sys.exit(1)
    if not path_b.exists():
        print(f"Error: File B not found: {path_b}")
        sys.exit(1)

    audio_a, sr_a = sf.read(str(path_a), dtype='float32')
    audio_b, sr_b = sf.read(str(path_b), dtype='float32')

    # Validate sample rates
    if sr_a != sr_b:
        print(f"Error: Sample rates differ (A={sr_a}, B={sr_b})")
        sys.exit(1)

    # Ensure 2D arrays
    if audio_a.ndim == 1:
        audio_a = audio_a.reshape(-1, 1)
    if audio_b.ndim == 1:
        audio_b = audio_b.reshape(-1, 1)

    # Validate channel counts
    if audio_a.shape[1] != audio_b.shape[1]:
        print(f"Error: Channel counts differ (A={audio_a.shape[1]}, B={audio_b.shape[1]})")
        sys.exit(1)

    # Truncate to shorter length
    min_len = min(len(audio_a), len(audio_b))
    audio_a = audio_a[:min_len]
    audio_b = audio_b[:min_len]

    # Normalize if requested
    if do_normalize:
        audio_a = normalize_peak(audio_a)
        audio_b = normalize_peak(audio_b)

    return audio_a, audio_b, sr_a


def make_callback(buffers: list, state: PlaybackState, channels: int):
    """Create audio callback function."""
    def callback(outdata, frames, time_info, status):
        with state.lock:
            if state.quit:
                raise sd.CallbackAbort()

            if state.paused:
                outdata.fill(0)
                return

            buf = buffers[state.active]
            start = state.pos
            end = min(start + frames, len(buf))
            length = end - start

            if length > 0:
                outdata[:length] = buf[start:end]
                state.pos = end

            if length < frames:
                outdata[length:] = 0
                state.paused = True
                state.pos = 0

    return callback


def run_ui(stdscr, buffers: list, state: PlaybackState, sr: int, names: tuple):
    """Run curses UI."""
    curses.curs_set(0)
    stdscr.nodelay(True)
    stdscr.timeout(50)

    total_frames = len(buffers[0])
    total_secs = total_frames / sr

    while not state.quit:
        stdscr.clear()

        with state.lock:
            active = state.active
            paused = state.paused
            pos = state.pos

        current_secs = pos / sr
        status = "PAUSED" if paused else "PLAYING"
        active_name = names[active]
        label = "A" if active == 0 else "B"

        # Display
        stdscr.addstr(0, 0, "═" * 50)
        stdscr.addstr(1, 0, "  A/B Playback Tool")
        stdscr.addstr(2, 0, "═" * 50)
        stdscr.addstr(4, 0, f"  Active: [{label}] {active_name}")
        stdscr.addstr(5, 0, f"  Status: {status}")
        stdscr.addstr(6, 0, f"  Position: {current_secs:6.1f}s / {total_secs:.1f}s")

        # Progress bar
        bar_width = 40
        progress = pos / total_frames if total_frames > 0 else 0
        filled = int(bar_width * progress)
        bar = "█" * filled + "░" * (bar_width - filled)
        stdscr.addstr(8, 0, f"  [{bar}]")

        stdscr.addstr(10, 0, "─" * 50)
        stdscr.addstr(11, 0, "  SPACE: play/pause   TAB: toggle A/B")
        stdscr.addstr(12, 0, "  ←/→: seek ±1s      H/L: seek ±5s")
        stdscr.addstr(13, 0, "  Q: quit")
        stdscr.addstr(14, 0, "─" * 50)

        stdscr.refresh()

        # Handle input
        try:
            key = stdscr.getch()
        except:
            key = -1

        if key == -1:
            continue

        with state.lock:
            if key == ord('q') or key == ord('Q'):
                state.quit = True

            elif key == ord(' '):
                state.paused = not state.paused

            elif key == ord('\t'):
                state.active = 1 - state.active

            elif key == curses.KEY_LEFT:
                state.pos = max(0, state.pos - sr)

            elif key == curses.KEY_RIGHT:
                state.pos = min(total_frames - 1, state.pos + sr)

            elif key == ord('h') or key == ord('H'):
                state.pos = max(0, state.pos - 5 * sr)

            elif key == ord('l') or key == ord('L'):
                state.pos = min(total_frames - 1, state.pos + 5 * sr)


def main():
    parser = argparse.ArgumentParser(
        description="A/B WAV playback for comparing audio files.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Controls:
  SPACE : play/pause
  TAB   : toggle A/B at current position
  ←/→   : seek -/+ 1 second
  H/L   : seek -/+ 5 seconds
  Q     : quit

Example:
  %(prog)s --a original.wav --b filtered.wav --normalize
        """
    )

    parser.add_argument('--a', type=str, required=True,
                        help='WAV file A (usually original)')
    parser.add_argument('--b', type=str, required=True,
                        help='WAV file B (usually filtered)')
    parser.add_argument('--device', type=int, default=None,
                        help='Output device index')
    parser.add_argument('--normalize', action='store_true',
                        help='Peak-normalize both files to 0.95')

    args = parser.parse_args()

    path_a = Path(args.a)
    path_b = Path(args.b)

    print(f"Loading: {path_a}")
    print(f"Loading: {path_b}")

    audio_a, audio_b, sr = load_wavs(path_a, path_b, args.normalize)
    channels = audio_a.shape[1]

    print(f"Sample rate: {sr} Hz, Channels: {channels}")
    print(f"Duration: {len(audio_a)/sr:.1f}s")
    if args.normalize:
        print("Normalized: yes")
    print("Starting playback UI...")

    buffers = [audio_a, audio_b]
    state = PlaybackState()
    names = (path_a.name, path_b.name)

    callback = make_callback(buffers, state, channels)

    try:
        with sd.OutputStream(
            samplerate=sr,
            channels=channels,
            dtype='float32',
            device=args.device,
            callback=callback,
            blocksize=1024
        ):
            curses.wrapper(lambda stdscr: run_ui(stdscr, buffers, state, sr, names))
    except sd.PortAudioError as e:
        print(f"Audio error: {e}")
        sys.exit(1)

    print("Done.")


if __name__ == '__main__':
    main()
