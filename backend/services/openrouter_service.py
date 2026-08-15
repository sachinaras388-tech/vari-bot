import logging
import os
import time
from typing import Any, Optional

import httpx

from backend.config.settings import get_settings
from backend.services.http_client import get_shared_http_client

logger = logging.getLogger(__name__)


class OpenRouterService:
    """Fallback provider for Nezuko using OpenRouter."""

    def __init__(self, api_key: Optional[str] = None, model: Optional[str] = None) -> None:
        settings = get_settings()
        self.api_key = (
            api_key
            or os.getenv("OPENROUTER_API_KEY")
            or getattr(settings, "OPENROUTER_API_KEY", None)
            or os.getenv("AI_API_KEY")
            or getattr(settings, "AI_API_KEY", None)
            or ""
        ).strip()
        self.model = (model or os.getenv("OPENROUTER_MODEL") or "openai/gpt-4o-mini").strip()
        self.base_url = "https://openrouter.ai/api/v1/chat/completions"
        self.timeout = 20.0

    async def generate(self, prompt: str, *, system_instruction: str, history: Optional[list[dict[str, Any]]] = None, timeout: float = 20.0) -> str:
        if not self.api_key:
            raise RuntimeError("OPENROUTER_API_KEY is missing")
        if not prompt:
            return ""

        messages = self._build_messages(prompt, system_instruction, history)
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.7,
            "max_tokens": 1024,
        }

        started_at = time.perf_counter()
        logger.info("[OpenRouter] Request started model=%s history_len=%d", self.model, len(history or []))

        client = get_shared_http_client()
        response = await client.post(
            self.base_url,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "HTTP-Referer": "https://localhost",
                "X-Title": "Nezuko WhatsApp Bot",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=timeout,
        )

        response.raise_for_status()
        data = response.json()
        text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        if not text:
            raise RuntimeError("empty_openrouter_response")

        logger.info("[OpenRouter] Success elapsed_ms=%d", int((time.perf_counter() - started_at) * 1000))
        return str(text).strip()

    def _build_messages(self, prompt: str, system_instruction: str, history: Optional[list[dict[str, Any]]]) -> list[dict[str, str]]:
        messages: list[dict[str, str]] = []
        if system_instruction:
            messages.append({"role": "system", "content": system_instruction})

        for item in history or []:
            role = str(item.get("role") or "user").strip().lower()
            if role == "assistant":
                role = "assistant"
            elif role == "system":
                continue
            else:
                role = "user"

            parts = item.get("parts") or item.get("content") or []
            if isinstance(parts, str):
                parts_list = [parts]
            elif isinstance(parts, list):
                parts_list = [str(part) for part in parts if str(part).strip()]
            else:
                parts_list = [str(parts)] if str(parts).strip() else []

            if parts_list:
                messages.append({"role": role, "content": "\n".join(parts_list)})

        messages.append({"role": "user", "content": prompt})
        return messages
