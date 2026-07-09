import argparse
import json
import os
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse

from faster_whisper import WhisperModel

MODEL_CACHE = {}


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
        device = os.environ.get("WHISPER_DEVICE", "auto")
        compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "auto")
        MODEL_CACHE[cache_key] = WhisperModel(cache_key, device=device, compute_type=compute_type)
    return MODEL_CACHE[cache_key]


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

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_file:
            temp_file.write(audio_data)
            temp_path = temp_file.name

        try:
            model = get_model(model_name)
            segments, _info = model.transcribe(temp_path, language=language, vad_filter=True)
            text = "".join(segment.text for segment in segments).strip()
            self._send_json(200, {"ok": True, "text": text})
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

    server = HTTPServer((args.host, args.port), WhisperHandler)
    print(f"Whisper server listening on http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
