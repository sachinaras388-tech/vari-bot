# Backend service

This folder contains the FastAPI backend for the Nezuko assistant.

## What changed
- Added a dedicated Nezuko command and memory service for wake-word routing, command handling, and conversation persistence.
- The backend now stores chat history in MongoDB with configurable expiry-based pruning.
- Added health endpoints and stronger startup/shutdown logging.

## Run locally

From the repository root:

```bash
uvicorn backend.main:app --reload
```

## Useful endpoints
- GET /health
- POST /api/v1/chat/ask
- POST /api/v1/whatsapp/message
