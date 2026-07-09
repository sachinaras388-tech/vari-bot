# WhatsApp bridge service

This service now operates as a resilient WhatsApp gateway that queues inbound messages, deduplicates them, retries FastAPI requests, and exposes health endpoints for production monitoring.

## What changed
- Replaced the brittle webhook-only client with a production-oriented bridge that keeps the existing API contract intact.
- Added message deduplication, queueing, retry/backoff logic, and graceful recovery for transient failures.
- Added health endpoints at /health and /readyz for Render and monitoring integrations.
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

## Render deployment notes
- Run this service as a web process on Render.
- Set the Meta webhook URL to https://<your-render-host>/webhook/whatsapp.
- Keep the service alive with auto-restart enabled and health checks pointed at /health.
- Avoid relying on local browser binaries; the bridge is designed to recover without hardcoded Chrome paths.
