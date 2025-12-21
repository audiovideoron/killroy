#!/usr/bin/env python3
"""
Audio recording, filtering, and playback CLI tool for macOS.

Usage examples:
    python audio_tool.py --list-devices
    python audio_tool.py --seconds 5 --out recording.wav
    python audio_tool.py --seconds 5 --highpass 120 --normalize --out hp.wav
    python audio_tool.py --seconds 5 --highpass 300 --lowpass 3400 --normalize --out phone.wav
"""

import argparse
import sys
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf
from scipy.signal import butter, sosfiltfilt


def list_devices():
    """Print available audio devices and exit."""
    print("Available audio devices:")
    print(sd.query_devices())
    sys.exit(0)


def validate_cutoff(cutoff: float, sr: int, name: str) -> None:
    """Validate that cutoff frequency is within valid range."""
    nyquist = sr / 2
    if cutoff <= 0:
        print(f"Error: {name} cutoff must be positive, got {cutoff}")
        sys.exit(1)
    if cutoff >= nyquist:
        print(f"Error: {name} cutoff ({cutoff} Hz) must be less than Nyquist frequency ({nyquist} Hz)")
        sys.exit(1)


def apply_highpass(audio: np.ndarray, cutoff: float, sr: int, order: int) -> np.ndarray:
    """Apply zero-phase highpass Butterworth filter."""
    validate_cutoff(cutoff, sr, "highpass")
    sos = butter(order, cutoff, btype='high', fs=sr, output='sos')
    return sosfiltfilt(sos, audio, axis=0)


def apply_lowpass(audio: np.ndarray, cutoff: float, sr: int, order: int) -> np.ndarray:
    """Apply zero-phase lowpass Butterworth filter."""
    validate_cutoff(cutoff, sr, "lowpass")
    sos = butter(order, cutoff, btype='low', fs=sr, output='sos')
    return sosfiltfilt(sos, audio, axis=0)


def normalize_peak(audio: np.ndarray, target: float = 0.95) -> np.ndarray:
    """Peak normalize audio to target level."""
    peak = np.abs(audio).max()
    if peak > 0:
        audio = audio * (target / peak)
    return audio


def record_audio(seconds: float, sr: int, channels: int, device=None) -> np.ndarray:
    """Record audio from input device."""
    frames = int(seconds * sr)
    print(f"Recording {seconds}s at {sr} Hz, {channels} channel(s)...")

    try:
        audio = sd.rec(frames, samplerate=sr, channels=channels, dtype='float32', device=device)
        sd.wait()
    except sd.PortAudioError as e:
        print(f"Error recording audio: {e}")
        print("\nIf on macOS, check System Settings → Privacy & Security → Microphone")
        print("and ensure your terminal app has microphone permission.")
        sys.exit(1)

    print("Recording complete.")
    return audio


def play_audio(audio: np.ndarray, sr: int, device=None) -> None:
    """Play audio through output device."""
    print("Playing...")
    try:
        sd.play(audio, sr, device=device)
        sd.wait()
    except sd.PortAudioError as e:
        print(f"Error playing audio: {e}")
        sys.exit(1)
    print("Playback complete.")


def save_audio(audio: np.ndarray, sr: int, path: Path) -> None:
    """Save audio as WAV file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), audio, sr, subtype='FLOAT')
    print(f"Saved to {path}")


def main():
    parser = argparse.ArgumentParser(
        description="Record, filter, and play audio on macOS.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --list-devices
  %(prog)s --seconds 5 --out recording.wav
  %(prog)s --seconds 5 --highpass 120 --normalize --out hp.wav
  %(prog)s --seconds 5 --highpass 300 --lowpass 3400 --normalize --out phone.wav
        """
    )

    parser.add_argument('--list-devices', action='store_true',
                        help='List available audio devices and exit')
    parser.add_argument('--seconds', type=float, default=5.0,
                        help='Recording duration in seconds (default: 5.0)')
    parser.add_argument('--sr', type=int, default=48000,
                        help='Sample rate in Hz (default: 48000)')
    parser.add_argument('--channels', type=int, default=1,
                        help='Number of channels (default: 1)')
    parser.add_argument('--in-device', type=int, default=None,
                        help='Input device index (default: system default)')
    parser.add_argument('--out-device', type=int, default=None,
                        help='Output device index (default: system default)')
    parser.add_argument('--highpass', type=float, default=None,
                        help='Highpass filter cutoff frequency in Hz')
    parser.add_argument('--lowpass', type=float, default=None,
                        help='Lowpass filter cutoff frequency in Hz')
    parser.add_argument('--order', type=int, default=4,
                        help='Filter order (default: 4)')
    parser.add_argument('--normalize', action='store_true',
                        help='Apply peak normalization to 0.95')
    parser.add_argument('--no-play', action='store_true',
                        help='Skip playback after recording')
    parser.add_argument('--out', type=str, default='output.wav',
                        help='Output WAV file path (default: output.wav)')

    args = parser.parse_args()

    # Handle --list-devices
    if args.list_devices:
        list_devices()

    # Record
    audio = record_audio(args.seconds, args.sr, args.channels, args.in_device)

    # Apply filters
    if args.highpass is not None:
        print(f"Applying highpass filter at {args.highpass} Hz...")
        audio = apply_highpass(audio, args.highpass, args.sr, args.order)

    if args.lowpass is not None:
        print(f"Applying lowpass filter at {args.lowpass} Hz...")
        audio = apply_lowpass(audio, args.lowpass, args.sr, args.order)

    # Normalize
    if args.normalize:
        print("Normalizing peak level...")
        audio = normalize_peak(audio)

    # Save
    out_path = Path(args.out)
    save_audio(audio, args.sr, out_path)

    # Play
    if not args.no_play:
        play_audio(audio, args.sr, args.out_device)


if __name__ == '__main__':
    main()
