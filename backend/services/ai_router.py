import asyncio
import logging
import os
import random
import time
from typing import Any, Optional

from backend.services.gemini_service import GeminiService
from backend.services.openrouter_service import OpenRouterService

logger = logging.getLogger(__name__)


class AIRouter:
    """Routes AI requests between Gemini and OpenRouter with retries and graceful fallback."""

    def __init__(self) -> None:
        self.primary_provider = (os.getenv("PRIMARY_PROVIDER") or "gemini").strip().lower()
        self.gemini = GeminiService()
        self.openrouter = OpenRouterService()

    async def generate(self, prompt: str, *, system_instruction: str, history: Optional[list[dict[str, Any]]] = None) -> str:
        if not prompt:
            return ""

        if self.primary_provider == "openrouter":
            return await self._generate_with_openrouter(prompt, system_instruction=system_instruction, history=history)

        return await self._generate_with_primary_retry(prompt, system_instruction=system_instruction, history=history)

    async def _generate_with_primary_retry(self, prompt: str, *, system_instruction: str, history: Optional[list[dict[str, Any]]] = None) -> str:
        retries = [1, 2]
        for attempt in retries:
            try:
                logger.info("[Gemini] Attempt %d", attempt)
                return await self.gemini.generate(prompt, system_instruction=system_instruction, history=history, timeout=15.0)
            except Exception as exc:
                if self._is_retryable_failure(exc):
                    logger.warning("[Gemini] Retry %d after transient failure", attempt)
                    await asyncio.sleep(1 if attempt == 1 else 2)
                    continue
                break

        logger.warning("[Router] Switching to OpenRouter")
        return await self._generate_with_openrouter(prompt, system_instruction=system_instruction, history=history)

    async def _generate_with_openrouter(self, prompt: str, *, system_instruction: str, history: Optional[list[dict[str, Any]]] = None) -> str:
        try:
            response = await self.openrouter.generate(prompt, system_instruction=system_instruction, history=history, timeout=20.0)
            logger.info("[OpenRouter] Success")
            return response
        except Exception as exc:
            logger.warning("[OpenRouter] Failed: %s", exc)
            return "🌸 Nezuko is taking a tiny tea break, senpai! Please try again in a few moments. 💖"

    def _is_retryable_failure(self, exc: Exception) -> bool:
        message = str(exc).lower()
        retryable_markers = [
            "429",
            "rate limit",
            "quota",
            "resource_exhausted",
            "timeout",
            "temporarily",
            "server",
            "overloaded",
            "connection",
            "econnreset",
            "eai_again",
        ]
        return any(marker in message for marker in retryable_markers)
