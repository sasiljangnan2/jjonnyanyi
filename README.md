# 쫀냥이
![쫀냥이](./sdf_cop2y.png)

## Whisper + ngrok 한번에 실행 (Windows)

### 방법 1: 배치 파일 실행
- `start_whisper_ngrok.bat` 더블클릭

### 방법 2: npm 스크립트 실행
- `npm run whisper-ngrok`

### 준비사항
- `python`이 PATH에 있어야 함
- `ngrok`이 PATH에 있어야 함
- 1회 인증: `ngrok config add-authtoken <YOUR_TOKEN>`

### 결과
- 로컬 Whisper: `http://127.0.0.1:8787/transcribe` (기본)
- ngrok 대시보드: `http://127.0.0.1:4040`
- 공개 URL이 열리면 봇의 `WHISPER_API_URL`에 `https://<ngrok-domain>/transcribe` 입력

## 음성 대화

음성 대화는 OpenAI API 키 없이 로컬 Ollama와 Windows TTS를 사용한다.

1. Windows에 Ollama를 설치한다.
2. 터미널에서 `ollama pull qwen3:4b`를 한 번 실행한다.
3. 기존처럼 `start_whisper_ngrok.bat`을 실행한다.
4. Railway의 `WHISPER_API_URL`에 ngrok의 `/transcribe` 주소를 설정한다.
5. 봇을 재시작하고 `/음성입장`을 실행한다.

`쫀냥아`로 시작하는 말을 하면 Ollama가 답변을 만들고 로컬 PC의 Windows
음성 합성으로 읽어 준다. 기존 음성 명령어가 먼저 처리되며, 명령어가 아닌
발화만 대화로 전달된다. 로컬 PC에서는 Ollama, Whisper 서버, ngrok이 모두
실행 중이어야 한다.
