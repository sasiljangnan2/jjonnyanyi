import argparse
import json
import os
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse

from faster_whisper import WhisperModel

MODEL_CACHE = {}


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


def transcribe_with_fallback(model_name: str, audio_path: str, language: str, beam_size: int, temperature: float, initial_prompt: str):
    cache_key = model_name.strip() or "base"
    preferred_device = os.environ.get("WHISPER_DEVICE", "cpu").strip() or "cpu"
    preferred_compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "int8").strip() or "int8"

    try:
        model = get_model(model_name)
        segments, _info = model.transcribe(
            audio_path,
            language=language,
            vad_filter=True,
            beam_size=beam_size,
            temperature=temperature,
            condition_on_previous_text=True,
            initial_prompt=initial_prompt,
        )
        return "".join(segment.text for segment in segments).strip(), None
    except Exception as error:
        if preferred_device != "cpu" and is_cuda_library_error(error):
            MODEL_CACHE.pop(cache_key, None)
            fallback_model = WhisperModel(cache_key, device="cpu", compute_type="int8")
            MODEL_CACHE[cache_key] = fallback_model
            segments, _info = fallback_model.transcribe(
                audio_path,
                language=language,
                vad_filter=True,
                beam_size=beam_size,
                temperature=temperature,
                condition_on_previous_text=True,
                initial_prompt=initial_prompt,
            )
            return "".join(segment.text for segment in segments).strip(), "cpu-fallback"
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

    def do_GET(self):
        if urlparse(self.path).path in ("/", "/health"):
            self._send_json(200, {"ok": True})
            return
        self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        parsed_url = urlparse(self.path)
        if parsed_url.path != "/transcribe":
            self._send_json(404, {"ok": False, "error": "not found"})
            return

        expected_key = os.environ.get("WHISPER_API_KEY", "").strip()
        provided_key = self.headers.get("X-Whisper-Key", "").strip()
        if expected_key and provided_key != expected_key:
            self._send_json(401, {"ok": False, "error": "unauthorized"})
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
        },
        flush=True,
    )

    server = HTTPServer((args.host, args.port), WhisperHandler)
    print(f"Whisper server listening on http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
