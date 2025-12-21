#!/usr/bin/env python3
"""
Offline WAV file filter CLI.

Usage examples:
    python filter_wav.py --in test.wav --out hp.wav --highpass 120
    python filter_wav.py --in test.wav --out phone.wav --highpass 300 --lowpass 3400 --normalize
    python filter_wav.py --in test.wav --out band.wav --bandpass 500 2000
"""

import argparse
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfiltfilt


def validate_cutoff(cutoff: float, sr: int, name: str) -> None:
    """Validate that cutoff frequency is within valid range."""
    nyquist = sr / 2
    if cutoff <= 0:
        print(f"Error: {name} cutoff must be positive, got {cutoff}")
        sys.exit(1)
    if cutoff >= nyquist:
        print(f"Error: {name} cutoff ({cutoff} Hz) must be less than Nyquist ({nyquist} Hz)")
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


def apply_bandpass(audio: np.ndarray, low: float, high: float, sr: int, order: int) -> np.ndarray:
    """Apply zero-phase bandpass Butterworth filter."""
    validate_cutoff(low, sr, "bandpass low")
    validate_cutoff(high, sr, "bandpass high")
    if low >= high:
        print(f"Error: bandpass low ({low} Hz) must be less than high ({high} Hz)")
        sys.exit(1)
    sos = butter(order, [low, high], btype='band', fs=sr, output='sos')
    return sosfiltfilt(sos, audio, axis=0)


def normalize_peak(audio: np.ndarray, target: float = 0.95) -> np.ndarray:
    """Peak normalize audio to target level."""
    peak = np.abs(audio).max()
    if peak > 0:
        audio = audio * (target / peak)
    return audio


def main():
    parser = argparse.ArgumentParser(
        description="Offline WAV file filter.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --in test.wav --out hp.wav --highpass 120
  %(prog)s --in test.wav --out phone.wav --highpass 300 --lowpass 3400 --normalize
  %(prog)s --in test.wav --out band.wav --bandpass 500 2000
        """
    )

    parser.add_argument('--in', dest='input', type=str, required=True,
                        help='Input WAV file path')
    parser.add_argument('--out', type=str, required=True,
                        help='Output WAV file path')
    parser.add_argument('--highpass', type=float, default=None,
                        help='Highpass filter cutoff frequency in Hz')
    parser.add_argument('--lowpass', type=float, default=None,
                        help='Lowpass filter cutoff frequency in Hz')
    parser.add_argument('--bandpass', type=float, nargs=2, metavar=('LOW', 'HIGH'),
                        help='Bandpass filter cutoff frequencies in Hz')
    parser.add_argument('--order', type=int, default=4,
                        help='Filter order (default: 4)')
    parser.add_argument('--normalize', action='store_true',
                        help='Apply peak normalization to 0.95')

    args = parser.parse_args()

    # Load input
    in_path = Path(args.input)
    if not in_path.exists():
        print(f"Error: Input file not found: {in_path}")
        sys.exit(1)

    print(f"Loading: {in_path}")
    audio, sr = sf.read(str(in_path), dtype='float32')
    channels = audio.shape[1] if audio.ndim > 1 else 1
    print(f"  Sample rate: {sr} Hz, Channels: {channels}, Duration: {len(audio)/sr:.2f}s")

    filters_applied = []

    # Apply filters in order: highpass, bandpass, lowpass
    if args.highpass is not None:
        print(f"Applying highpass at {args.highpass} Hz...")
        audio = apply_highpass(audio, args.highpass, sr, args.order)
        filters_applied.append(f"highpass({args.highpass}Hz)")

    if args.bandpass is not None:
        low, high = args.bandpass
        print(f"Applying bandpass {low}-{high} Hz...")
        audio = apply_bandpass(audio, low, high, sr, args.order)
        filters_applied.append(f"bandpass({low}-{high}Hz)")

    if args.lowpass is not None:
        print(f"Applying lowpass at {args.lowpass} Hz...")
        audio = apply_lowpass(audio, args.lowpass, sr, args.order)
        filters_applied.append(f"lowpass({args.lowpass}Hz)")

    # Normalize
    if args.normalize:
        print("Normalizing peak level...")
        audio = normalize_peak(audio)
        filters_applied.append("normalize")

    # Save output
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out_path), audio, sr, subtype='FLOAT')

    # Summary
    print(f"Saved: {out_path}")
    if filters_applied:
        print(f"Filters: {' → '.join(filters_applied)}")
    else:
        print("No filters applied (passthrough copy)")


if __name__ == '__main__':
    main()
