# WhatsApp webhook service

This service replaces the old Baileys-based socket client with a stable webhook-based integration for WhatsApp Cloud API.

## What changed
- Removed Baileys, pairing-code, QR, auth-state, reconnect, and heartbeat logic.
- Kept the FastAPI webhook bridge intact so existing chatbot routing continues to work.
- Added modular files under src/ for configuration, logging, FastAPI forwarding, and the WhatsApp client.
- Added automatic recovery behavior for transient disconnects and idle conditions.

## Required environment variables
- PORT
- HOST
- FASTAPI_URL
- WHATSAPP_PHONE_NUMBER
- WHATSAPP_ACCESS_TOKEN
- WHATSAPP_BUSINESS_ACCOUNT_ID
- WHATSAPP_API_VERSION (optional)
- WHATSAPP_RECOVERY_ENABLED (optional)
- LOG_LEVEL (optional)

## Render deployment notes
- Keep the service running on Render as a web process.
- Set the webhook URL to: https://<your-render-host>/webhook/whatsapp
- Make sure the Meta app verifies the webhook and sends messages to this endpoint.
