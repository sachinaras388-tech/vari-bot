import asyncio
import logging
import os
import tempfile
import uuid
from pathlib import Path

from gtts import gTTS

logger = logging.getLogger(__name__)

LANGUAGES = {
    "kn": "Kannada",
    "hi": "Hindi",
    "mr": "Marathi",
    "en": "English",
    "ta": "Tamil",
    "te": "Telugu",
    "ml": "Malayalam",
    "bn": "Bengali",
    "gu": "Gujarati",
    "pa": "Punjabi",
}
MAX_TTS_CHARS = 3000
TTS_ROOT = Path(tempfile.gettempdir()) / "myara_tts"
tts_semaphore = asyncio.Semaphore(2)


class TTSValidationError(ValueError):
    pass


class TTSBusyError(RuntimeError):
    pass


def validate_request(text: str, language: str) -> None:
    if language not in LANGUAGES:
        raise TTSValidationError(f"unsupported language: {language}")
    if not text.strip():
        raise TTSValidationError("empty text")
    if len(text) > MAX_TTS_CHARS:
        raise TTSValidationError("text is too long")


def _generate_mp3(text: str, language: str, output_path: str) -> None:
    gTTS(text=text, lang=language, slow=False).save(output_path)


async def text_to_speech(text: str, language: str) -> str:
    text = text.strip()
    language = language.strip().lower()
    validate_request(text, language)

    if tts_semaphore.locked():
        raise TTSBusyError("too many voice requests")

    TTS_ROOT.mkdir(parents=True, exist_ok=True)
    output_path = TTS_ROOT / f"tts_{uuid.uuid4().hex}.mp3"
    async with tts_semaphore:
        logger.info("[TTS] generation_started language=%s text_length=%d", language, len(text))
        try:
            await asyncio.to_thread(_generate_mp3, text, language, str(output_path))
            logger.info("[TTS] generation_completed language=%s", language)
            return str(output_path)
        except Exception:
            output_path.unlink(missing_ok=True)
            logger.exception("[TTS] generation_failed language=%s", language)
            raise


def remove_audio(audio_path: str) -> None:
    try:
        Path(audio_path).unlink(missing_ok=True)
        logger.info("[TTS] cleanup_completed filename=%s", os.path.basename(audio_path))
    except OSError:
        logger.exception("[TTS] cleanup_failed filename=%s", os.path.basename(audio_path))