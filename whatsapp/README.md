# WhatsApp bridge service

This service now operates as a WhatsApp Cloud API bridge that normalizes incoming payloads, forwards messages to a FastAPI backend, and exposes health endpoints for monitoring.

## What changed
- Replaced the legacy browser-based client with a cloud API bridge implementation.
- Added message deduplication, queueing, retry/backoff logic, and graceful recovery for transient failures.
- Added health endpoints at /health and /readyz for monitoring.
- Added structured logging and safer shutdown handling so the process does not crash on unhandled rejections or uncaught exceptions.

## Required environment variables
- PORT
- HOST
- FASTAPI_URL
- WHATSAPP_PHONE_NUMBER
- WHATSAPP_ACCESS_TOKEN
- WHATSAPP_BUSINESS_ACCOUNT_ID
- WHATSAPP_VERIFY_TOKEN
- WHATSAPP_API_VERSION (optional)
- WHATSAPP_RECOVERY_ENABLED (optional)
- WHATSAPP_BROWSER_RECOVERY_ENABLED (optional)
- FASTAPI_TIMEOUT_MS (optional)
- FASTAPI_MAX_RETRIES (optional)
- LOG_LEVEL (optional)
- WHATSAPP_SESSION_PATH (optional)
- WHATSAPP_MAX_RECONNECT_ATTEMPTS (optional)

## Nezuko notes
- The bridge honors wake-word messages and forwards them to the backend for AI reply generation.
- QR code data is available from /qr, /qr.png, and /qr.svg when session-based auth is in use.
- Reconnect loops are guarded to avoid duplicate recovery attempts.

## Render deployment notes
- Run this service as a web process on Render.
- Set the Meta webhook URL to https://<your-render-host>/webhook/whatsapp.
- Keep the service alive with auto-restart enabled and health checks pointed at /health.
