import argparse
import base64
import json
import os
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from faster_whisper import WhisperModel

MODEL_CACHE = {}


def clean_ollama_reply(text: str) -> str:
    cleaned = str(text or "").strip()

    while "<think>" in cleaned and "</think>" in cleaned:
        before, remainder = cleaned.split("<think>", 1)
        _thinking, after = remainder.split("</think>", 1)
        cleaned = (before + after).strip()

    blocked_phrases = (
        "first, i need",
        "i need to respond",
        "respond in korean",
        "end with",
        "two sentences max",
        "since it's a voice message",
        "the user wants",
        "my response should",
    )
    kept_lines = []
    for line in cleaned.splitlines():
        normalized_line = line.strip().strip("*").lower()
        if any(phrase in normalized_line for phrase in blocked_phrases):
            continue
        if normalized_line:
            kept_lines.append(line.strip().strip("*"))

    return "\n".join(kept_lines).strip()


def request_ollama_chat(model_name: str, system_prompt: str, messages: list) -> str:
    ollama_api_url = os.environ.get("OLLAMA_API_URL", "http://127.0.0.1:11434/api/chat").strip()
    cleaned_messages = []
    if system_prompt:
        effective_system_prompt = system_prompt
        if "/no_think" not in effective_system_prompt:
            effective_system_prompt = "/no_think\n" + effective_system_prompt
        cleaned_messages.append({"role": "system", "content": effective_system_prompt})

    for message in messages[-12:]:
        role = str(message.get("role", "")).strip()
        content = str(message.get("content", "")).strip()
        if role in ("user", "assistant") and content:
            cleaned_messages.append({"role": role, "content": content})

    payload = json.dumps(
        {
            "model": model_name or os.environ.get("OLLAMA_MODEL", "qwen3:4b"),
            "messages": cleaned_messages,
            "stream": False,
            "think": False,
            "options": {"num_predict": 180},
        },
        ensure_ascii=False,
    ).encode("utf-8")
    request = Request(
        ollama_api_url,
        data=payload,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )

    with urlopen(request, timeout=180) as response:
        parsed = json.loads(response.read().decode("utf-8"))

    cleaned_reply = clean_ollama_reply(parsed.get("message", {}).get("content", ""))
    return cleaned_reply or "잠깐 생각이 꼬였다냥. 다시 한번 말해 달라냥!"


def synthesize_windows_speech(text: str, output_path: str):
    if os.name != "nt":
        raise RuntimeError("로컬 TTS는 현재 Windows 음성 합성만 지원합니다.")

    script = r"""
Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
$requestedVoice = $env:LOCAL_TTS_VOICE_NAME
if ($requestedVoice) {
  $speaker.SelectVoice($requestedVoice)
} else {
  $koreanVoice = $speaker.GetInstalledVoices() |
    Where-Object { $_.VoiceInfo.Culture.Name -eq 'ko-KR' } |
    Select-Object -First 1
  if ($koreanVoice) {
    $speaker.SelectVoice($koreanVoice.VoiceInfo.Name)
  }
}
$speaker.Rate = [int]$env:LOCAL_TTS_RATE
$speaker.SetOutputToWaveFile($env:LOCAL_TTS_OUTPUT_PATH)
$speaker.Speak($env:LOCAL_TTS_TEXT)
$speaker.Dispose()
"""
    child_env = os.environ.copy()
    child_env["LOCAL_TTS_TEXT"] = text
    child_env["LOCAL_TTS_OUTPUT_PATH"] = output_path
    child_env["LOCAL_TTS_RATE"] = os.environ.get("LOCAL_TTS_RATE", "1")
    child_env["LOCAL_TTS_VOICE_NAME"] = os.environ.get("LOCAL_TTS_VOICE_NAME", "")
    subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        check=True,
        env=child_env,
        capture_output=True,
        text=True,
        timeout=60,
    )


def decode_b64_header(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""

    try:
        return base64.b64decode(raw.encode("ascii"), validate=True).decode("utf-8")
    except Exception:
        return ""


def is_cuda_library_error(error: Exception) -> bool:
    message = str(error).lower()
    return (
        "cublas64_12.dll" in message
        or "cannot be loaded" in message
        or "cannot find module" in message
        or "cuda" in message
    )


def load_dotenv_file(dotenv_path: Path):
    if not dotenv_path.exists():
        return

    for raw_line in dotenv_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def get_model(model_name: str):
    cache_key = model_name.strip() or "base"
    if cache_key not in MODEL_CACHE:
        preferred_device = os.environ.get("WHISPER_DEVICE", "cpu").strip() or "cpu"
        preferred_compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "int8").strip() or "int8"

        try:
            MODEL_CACHE[cache_key] = WhisperModel(
                cache_key,
                device=preferred_device,
                compute_type=preferred_compute_type,
            )
        except Exception as error:
            if preferred_device != "cpu":
                MODEL_CACHE[cache_key] = WhisperModel(cache_key, device="cpu", compute_type="int8")
            else:
                raise error
    return MODEL_CACHE[cache_key]


def transcribe_with_fallback(model_name: str, audio_path: str, language: str, beam_size: int, temperature: float, initial_prompt: str, hotwords: str):
    cache_key = model_name.strip() or "base"
    preferred_device = os.environ.get("WHISPER_DEVICE", "cpu").strip() or "cpu"
    preferred_compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "int8").strip() or "int8"
    best_of = int(os.environ.get("WHISPER_BEST_OF", "5"))
    patience = float(os.environ.get("WHISPER_PATIENCE", "1.2"))
    condition_on_previous_text = os.environ.get("WHISPER_CONDITION_ON_PREVIOUS_TEXT", "false").strip().lower() == "true"
    vad_filter = os.environ.get("WHISPER_VAD_FILTER", "true").strip().lower() == "true"
    vad_min_silence_ms = int(os.environ.get("WHISPER_VAD_MIN_SILENCE_MS", "400"))
    vad_speech_pad_ms = int(os.environ.get("WHISPER_VAD_SPEECH_PAD_MS", "350"))

    decode_kwargs = {
        "language": language,
        "beam_size": beam_size,
        "best_of": best_of,
        "patience": patience,
        "temperature": temperature,
        "condition_on_previous_text": condition_on_previous_text,
        "initial_prompt": initial_prompt,
        "vad_filter": vad_filter,
        "vad_parameters": {
            "min_silence_duration_ms": vad_min_silence_ms,
            "speech_pad_ms": vad_speech_pad_ms,
        },
    }

    if hotwords:
        decode_kwargs["hotwords"] = hotwords

    try:
        model = get_model(model_name)
        segments, _info = model.transcribe(audio_path, **decode_kwargs)
        text = "".join(segment.text for segment in segments).strip()

        if not text and vad_filter:
            # Short command-style utterances can be clipped too hard by VAD.
            retry_kwargs = dict(decode_kwargs)
            retry_kwargs["vad_filter"] = False
            retry_kwargs.pop("vad_parameters", None)
            retry_segments, _retry_info = model.transcribe(audio_path, **retry_kwargs)
            text = "".join(segment.text for segment in retry_segments).strip()

        return text, None
    except Exception as error:
        if preferred_device != "cpu" and is_cuda_library_error(error):
            MODEL_CACHE.pop(cache_key, None)
            fallback_model = WhisperModel(cache_key, device="cpu", compute_type="int8")
            MODEL_CACHE[cache_key] = fallback_model
            segments, _info = fallback_model.transcribe(audio_path, **decode_kwargs)
            text = "".join(segment.text for segment in segments).strip()

            if not text and vad_filter:
                retry_kwargs = dict(decode_kwargs)
                retry_kwargs["vad_filter"] = False
                retry_kwargs.pop("vad_parameters", None)
                retry_segments, _retry_info = fallback_model.transcribe(audio_path, **retry_kwargs)
                text = "".join(segment.text for segment in retry_segments).strip()

            return text, "cpu-fallback"
        raise error


class WhisperHandler(BaseHTTPRequestHandler):
    server_version = "WhisperHTTP/1.0"

    def _send_json(self, status_code, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_bytes(self, status_code, content_type, data):
        self.send_response(status_code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json_body(self):
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0 or content_length > 64 * 1024:
            raise ValueError("invalid body size")
        return json.loads(self.rfile.read(content_length).decode("utf-8"))

    def _handle_chat(self):
        try:
            payload = self._read_json_body()
            model_name = str(payload.get("model") or os.environ.get("OLLAMA_MODEL", "qwen3:4b")).strip()
            system_prompt = str(payload.get("system", "")).strip()
            messages = payload.get("messages", [])
            if not isinstance(messages, list) or not messages:
                self._send_json(400, {"ok": False, "error": "messages are required"})
                return

            text = request_ollama_chat(model_name, system_prompt, messages)
            if not text:
                raise RuntimeError("Ollama returned an empty reply")
            self._send_json(200, {"ok": True, "text": text})
        except Exception as error:
            self._send_json(500, {"ok": False, "error": str(error)})

    def _handle_tts(self):
        output_path = ""
        try:
            payload = self._read_json_body()
            text = str(payload.get("text", "")).strip()
            if not text:
                self._send_json(400, {"ok": False, "error": "text is required"})
                return

            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_file:
                output_path = temp_file.name

            synthesize_windows_speech(text[:1000], output_path)
            audio_data = Path(output_path).read_bytes()
            self._send_bytes(200, "audio/wav", audio_data)
        except Exception as error:
            self._send_json(500, {"ok": False, "error": str(error)})
        finally:
            if output_path:
                try:
                    os.unlink(output_path)
                except OSError:
                    pass

    def do_GET(self):
        if urlparse(self.path).path in ("/", "/health"):
            self._send_json(200, {"ok": True})
            return
        self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        parsed_url = urlparse(self.path)
        if parsed_url.path not in ("/transcribe", "/chat", "/tts"):
            self._send_json(404, {"ok": False, "error": "not found"})
            return

        expected_key = os.environ.get("WHISPER_API_KEY", "").strip()
        provided_key = self.headers.get("X-Whisper-Key", "").strip()
        if expected_key and provided_key != expected_key:
            self._send_json(401, {"ok": False, "error": "unauthorized"})
            return

        if parsed_url.path == "/chat":
            self._handle_chat()
            return

        if parsed_url.path == "/tts":
            self._handle_tts()
            return

        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0:
            self._send_json(400, {"ok": False, "error": "empty body"})
            return

        audio_data = self.rfile.read(content_length)
        model_name = self.headers.get("X-Whisper-Model", os.environ.get("WHISPER_MODEL", "base"))
        language = self.headers.get("X-Whisper-Language", os.environ.get("WHISPER_LANGUAGE", "ko"))
        beam_size = int(self.headers.get("X-Whisper-Beam-Size", os.environ.get("WHISPER_BEAM_SIZE", "5")))
        temperature = float(self.headers.get("X-Whisper-Temperature", os.environ.get("WHISPER_TEMPERATURE", "0")))
        initial_prompt = self.headers.get(
            "X-Whisper-Initial-Prompt",
            os.environ.get("WHISPER_INITIAL_PROMPT", "이 대화는 한국어 디스코드 음성 채팅이다. 단어를 자연스럽게 받아 적어라."),
        )
        hotwords = self.headers.get("X-Whisper-Hotwords", os.environ.get("WHISPER_HOTWORDS", "")).strip()

        initial_prompt_b64 = decode_b64_header(self.headers.get("X-Whisper-Initial-Prompt-B64", ""))
        hotwords_b64 = decode_b64_header(self.headers.get("X-Whisper-Hotwords-B64", ""))
        if initial_prompt_b64:
            initial_prompt = initial_prompt_b64
        if hotwords_b64:
            hotwords = hotwords_b64

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_file:
            temp_file.write(audio_data)
            temp_path = temp_file.name

        try:
            text, fallback_mode = transcribe_with_fallback(
                model_name,
                temp_path,
                language,
                beam_size,
                temperature,
                initial_prompt,
                hotwords,
            )
            response = {"ok": True, "text": text}
            if fallback_mode:
                response["fallback"] = fallback_mode
            self._send_json(200, response)
        except Exception as error:
            self._send_json(500, {"ok": False, "error": str(error)})
        finally:
            try:
                os.unlink(temp_path)
            except OSError:
                pass

    def log_message(self, format, *args):
        return


def main():
    project_root = Path(__file__).resolve().parent.parent
    load_dotenv_file(project_root / ".env")

    parser = argparse.ArgumentParser(description="Local Whisper HTTP server")
    parser.add_argument("--host", default=os.environ.get("WHISPER_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("WHISPER_PORT", "8787")))
    args = parser.parse_args()

    print(
        "Whisper config:",
        {
            "host": args.host,
            "port": args.port,
            "model": os.environ.get("WHISPER_MODEL", "base"),
            "language": os.environ.get("WHISPER_LANGUAGE", "ko"),
            "device": os.environ.get("WHISPER_DEVICE", "cpu"),
            "compute_type": os.environ.get("WHISPER_COMPUTE_TYPE", "int8"),
            "beam_size": os.environ.get("WHISPER_BEAM_SIZE", "5"),
            "temperature": os.environ.get("WHISPER_TEMPERATURE", "0"),
            "hotwords": os.environ.get("WHISPER_HOTWORDS", ""),
            "best_of": os.environ.get("WHISPER_BEST_OF", "5"),
            "patience": os.environ.get("WHISPER_PATIENCE", "1.2"),
            "condition_on_previous_text": os.environ.get("WHISPER_CONDITION_ON_PREVIOUS_TEXT", "false"),
            "vad_filter": os.environ.get("WHISPER_VAD_FILTER", "true"),
            "vad_min_silence_ms": os.environ.get("WHISPER_VAD_MIN_SILENCE_MS", "400"),
            "vad_speech_pad_ms": os.environ.get("WHISPER_VAD_SPEECH_PAD_MS", "350"),
        },
        flush=True,
    )

    server = HTTPServer((args.host, args.port), WhisperHandler)
    print(f"Whisper server listening on http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
