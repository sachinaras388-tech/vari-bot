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
        logger.info("Gemini API key configured: %s", "YES" if self.gemini.api_key else "NO")
        logger.info("Gemini model: %s", self.gemini.model)
        logger.info("OpenRouter API key configured: %s", "YES" if self.openrouter.api_key else "NO")
        logger.info("OpenRouter model: %s", self.openrouter.model)
        if not self.gemini.api_key:
            logger.warning("[Gemini] GEMINI_API_KEY is not configured")
        if not self.openrouter.api_key:
            logger.warning("[OpenRouter] OPENROUTER_API_KEY is not configured")

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
                return await self.gemini.generate(prompt, system_instruction=system_instruction, history=history, timeout=10.0)
            except Exception as exc:
                if self._is_authentication_failure(exc):
                    logger.error("[Gemini] Authentication failed")
                    if self.openrouter.api_key:
                        logger.warning("[Router] Switching to OpenRouter after Gemini authentication failure")
                        return await self._generate_with_openrouter(prompt, system_instruction=system_instruction, history=history)
                    return "❌ Senpai, the Gemini API key is invalid or expired. Please set a valid GEMINI_API_KEY in the .env file. 🥺"

                if not self._is_retryable_failure(exc):
                    logger.warning("[Gemini] Non-retryable failure: %s", exc)
                    break

                logger.warning("[Gemini] Retry %d after transient failure", attempt)
                if attempt == 2:
                    break
                await asyncio.sleep(0.5)
                continue

        logger.warning("[Router] Switching to OpenRouter")
        return await self._generate_with_openrouter(prompt, system_instruction=system_instruction, history=history)

    async def _generate_with_openrouter(self, prompt: str, *, system_instruction: str, history: Optional[list[dict[str, Any]]] = None) -> str:
        if not self.openrouter.api_key:
            logger.error("[OpenRouter] OPENROUTER_API_KEY is not configured")
            return "❌ Senpai, OpenRouter is not configured. Please set OPENROUTER_API_KEY in the .env file. 🥺"

        try:
            response = await self.openrouter.generate(prompt, system_instruction=system_instruction, history=history, timeout=20.0)
            logger.info("[OpenRouter] Success")
            return response
        except Exception as exc:
            msg = str(exc).lower()
            if "401" in msg or "unauthorized" in msg:
                logger.error("[OpenRouter] OpenRouter authentication failed (Please check OPENROUTER_API_KEY in .env)")
                return "❌ Senpai, the OpenRouter API key is invalid or expired. Please set a valid OPENROUTER_API_KEY in the .env file. 🥺"
            if "404" in msg or "model" in msg and "not found" in msg:
                logger.error("[OpenRouter] Configured model is unavailable: %s", self.openrouter.model)
                return "❌ Senpai, the configured OpenRouter model is unavailable. Please set a supported OPENROUTER_MODEL in the .env file. 🥺"
            else:
                logger.warning("[OpenRouter] Failed: %s", exc)
            return "🌸 Myara is taking a tiny tea break, senpai! Please try again in a few moments. 💖"

    def _is_retryable_failure(self, exc: Exception) -> bool:
        message = str(exc).lower()
        if any(marker in message for marker in ["429", "rate limit", "quota", "resource_exhausted"]):
            return False

        if any(marker in message for marker in ["timeout", "temporarily", "server", "overloaded", "connection", "econnreset", "eai_again", "5xx", "503", "502", "500"]):
            return True

        return False

    def _is_authentication_failure(self, exc: Exception) -> bool:
        message = str(exc).lower()
        return any(marker in message for marker in [
            "401",
            "unauthorized",
            "unauthenticated",
            "invalid authentication credentials",
            "api key is invalid",
        ])
