"""Local speech-to-text for AStack gateway voice notes.

Runs faster-whisper on demand and exits, so the GPU memory is released as soon
as the transcript is printed. Output is one JSON object on stdout.

    python -I transcribe.py --check
    python -I transcribe.py --model large-v3-turbo --language fa --device auto <audio file>

Device "auto" tries CUDA (float16) first and falls back to CPU (int8).
Audio is decoded by PyAV, which faster-whisper bundles, so no ffmpeg binary
is required for WhatsApp/Telegram OGG/Opus voice notes.
"""

import argparse
import json
import sys
import time


def emit(payload, code=0):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    sys.exit(code)


def check():
    info = {"ok": False, "python": sys.version.split()[0]}
    try:
        import faster_whisper  # noqa: F401

        info["faster_whisper"] = getattr(faster_whisper, "__version__", "unknown")
    except Exception as exc:  # pragma: no cover - depends on the machine
        info["error"] = "faster-whisper is not installed: " + str(exc)
        emit(info, 1)
    try:
        import ctranslate2

        info["ctranslate2"] = ctranslate2.__version__
        info["cuda_devices"] = ctranslate2.get_cuda_device_count()
    except Exception as exc:  # pragma: no cover
        info["cuda_devices"] = 0
        info["cuda_error"] = str(exc)
    info["ok"] = True
    emit(info)


def load(model_name, device):
    from faster_whisper import WhisperModel

    attempts = []
    if device in ("auto", "cuda"):
        attempts.append(("cuda", "float16"))
    if device in ("auto", "cpu"):
        attempts.append(("cpu", "int8"))
    last = None
    for name, compute in attempts:
        try:
            return WhisperModel(model_name, device=name, compute_type=compute), name, compute
        except Exception as exc:  # CUDA libraries missing, out of memory, ...
            last = exc
    raise RuntimeError("could not load model " + model_name + ": " + str(last))


def transcribe(path, model_name, language, device, beam_size):
    started = time.time()
    model, used_device, compute = load(model_name, device)
    try:
        segments, info = model.transcribe(
            path,
            language=None if language in ("", "auto") else language,
            beam_size=beam_size,
            vad_filter=True,
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
    except RuntimeError:
        # A CUDA failure during decoding (not at load time) retries on CPU once.
        if used_device != "cuda":
            raise
        del model
        model, used_device, compute = load(model_name, "cpu")
        segments, info = model.transcribe(path, language=None if language in ("", "auto") else language, beam_size=beam_size, vad_filter=True)
        text = " ".join(segment.text.strip() for segment in segments).strip()
    return {
        "ok": True,
        "text": text,
        "language": getattr(info, "language", language),
        "duration": round(float(getattr(info, "duration", 0.0)), 2),
        "device": used_device,
        "compute_type": compute,
        "model": model_name,
        "seconds": round(time.time() - started, 2),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", nargs="?")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument("--language", default="fa")
    parser.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    parser.add_argument("--beam-size", type=int, default=5)
    args = parser.parse_args()
    if args.check:
        check()
    if not args.audio:
        emit({"ok": False, "error": "no audio file given"}, 2)
    try:
        emit(transcribe(args.audio, args.model, args.language, args.device, args.beam_size))
    except Exception as exc:
        emit({"ok": False, "error": str(exc)}, 1)


if __name__ == "__main__":
    main()
