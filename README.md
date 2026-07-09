# 쫀냥이
readme.md 공사중

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