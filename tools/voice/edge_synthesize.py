"""Bounded Edge TTS bridge. One JSON stdin request, one PCM WAV and JSON result.

No shell commands, credentials, automatic installation, retry loop, or SAPI fallback.
The caller owns the output path and kills this process on cancellation/deadline.
"""
import asyncio
import hashlib
import importlib.metadata
import io
import json
from pathlib import Path
import re
import sys
import wave

EDGE_VERSION = "7.3.1"
MINIAUDIO_VERSION = "1.73"
MAX_MP3_BYTES = 2 * 1024 * 1024
MAX_FRAMES = 55 * 16000


def validate_request(request):
    if not isinstance(request, dict) or set(request) != {
        "text", "path", "voice", "rate", "engineVersion", "converterVersion", "timeoutMs"
    }:
        raise ValueError("invalid_request")
    text = request["text"]
    if (not isinstance(text, str) or not text.strip() or
            len(text.encode("utf-16-le")) // 2 > 160 or
            any(ord(c) < 32 and c not in "\t\n\r" for c in text)):
        raise ValueError("invalid_text")
    if not isinstance(request["voice"], str) or not re.fullmatch(r"zh-CN-[A-Za-z]+Neural", request["voice"]):
        raise ValueError("invalid_voice")
    if (not isinstance(request["rate"], str) or not re.fullmatch(r"[+-](?:0|[1-9]\d?)%", request["rate"]) or
            abs(int(request["rate"][:-1])) > 50):
        raise ValueError("invalid_rate")
    if request["engineVersion"] != EDGE_VERSION or request["converterVersion"] != MINIAUDIO_VERSION:
        raise ValueError("invalid_version")
    if type(request["timeoutMs"]) is not int or not 10 <= request["timeoutMs"] <= 120000:
        raise ValueError("invalid_timeout")
    if (not isinstance(request["path"], str) or any(ord(c) < 32 for c in request["path"]) or
            not Path(request["path"]).is_absolute() or Path(request["path"]).suffix.lower() != ".wav"):
        raise ValueError("invalid_output")
    if not Path(request["path"]).parent.is_dir() or Path(request["path"]).exists():
        raise ValueError("output_unavailable")
    return request


async def collect_audio(request, edge_tts):
    communicator = edge_tts.Communicate(
        request["text"], voice=request["voice"], rate=request["rate"],
        connect_timeout=10, receive_timeout=20,
    )
    audio = bytearray()
    async for chunk in communicator.stream():
        if chunk.get("type") != "audio":
            continue
        data = chunk.get("data")
        if not isinstance(data, bytes) or len(audio) + len(data) > MAX_MP3_BYTES:
            raise ValueError("audio_size_limit")
        audio.extend(data)
    if not audio:
        raise ValueError("empty_audio")
    return bytes(audio)


def to_wave(audio, miniaudio):
    info = miniaudio.mp3_get_info(audio)
    if info.sample_rate <= 0 or info.num_frames <= 0 or info.num_frames / info.sample_rate > 55:
        raise ValueError("voice_duration_limit")
    decoded = miniaudio.decode(audio, output_format=miniaudio.SampleFormat.SIGNED16, nchannels=1, sample_rate=16000)
    if (decoded.nchannels != 1 or decoded.sample_rate != 16000 or decoded.sample_width != 2 or
            decoded.sample_format != miniaudio.SampleFormat.SIGNED16 or not 3200 <= len(decoded.samples) <= MAX_FRAMES):
        raise ValueError("invalid_decoded_audio")
    samples = decoded.samples
    if sys.byteorder != "little":
        samples.byteswap()
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(samples.tobytes())
    # Match JavaScript Math.round for positive half milliseconds (Python rounds ties to even).
    return output.getvalue(), (len(samples) + 8) // 16


async def synthesize(request):
    import edge_tts
    import miniaudio
    if (importlib.metadata.version("edge-tts") != EDGE_VERSION or
            importlib.metadata.version("miniaudio") != MINIAUDIO_VERSION):
        raise ValueError("runtime_version_mismatch")
    audio = await asyncio.wait_for(collect_audio(request, edge_tts), request["timeoutMs"] / 1000)
    wav, duration_ms = to_wave(audio, miniaudio)
    with open(request["path"], "xb") as output:
        output.write(wav)
    return {"engine": "edge-tts", "engineVersion": EDGE_VERSION, "converterVersion": MINIAUDIO_VERSION,
            "voice": request["voice"], "rate": request["rate"], "durationMs": duration_ms,
            "bytes": len(wav), "sha256": hashlib.sha256(wav).hexdigest()}


def main():
    try:
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise ValueError("request_size_limit")
        request = validate_request(json.loads(raw.decode("utf-8")))
        result = asyncio.run(synthesize(request))
        sys.stdout.write(json.dumps(result, ensure_ascii=True))
        return 0
    except Exception:
        # Do not expose spoken text, provider exception bodies, URLs or diagnostics.
        sys.stderr.write("Edge speech synthesis failed\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
