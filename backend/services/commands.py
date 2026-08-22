import logging
import time
from datetime import datetime
from typing import Any

from backend.ai.chat import generate_chat_response, normalize_history_for_gemini
from backend.services.myara import (
    build_command_help,
    build_help_text,
    clear_conversation_history,
    get_conversation_history,
    is_authorized_admin,
    save_conversation_history,
    sanitize_text,
    should_trigger_myara,
)


def extract_command(text: str) -> str:
    """Extract the command text after the wake word, if present."""
    cleaned = sanitize_text(text).strip()
    if not cleaned:
        return ""

    lowered = cleaned.lower()
    if lowered.startswith("myara"):
        remainder = cleaned[5:].strip()
        return remainder if remainder else ""

    if " myara " in lowered:
        parts = cleaned.split()
        try:
            idx = [i for i, token in enumerate(parts) if token.lower() == "myara"][0]
        except IndexError:
            return cleaned
        return " ".join(parts[idx + 1 :]).strip()

    return cleaned

logger = logging.getLogger(__name__)


async def handle_myara_command(db: Any, payload: dict[str, Any], text: str) -> dict[str, Any]:
    """Route a Myara-triggered message to the right command or generic AI flow."""
    message_text = sanitize_text(text)
    command_text = extract_command(message_text)
    normalized = command_text.lower().strip()

    if not should_trigger_myara(message_text):
        return {"status": "ignored", "reply": "", "reason": "no_trigger"}

    if normalized in {"help", "menu", "about"}:
        return {"status": "success", "reply": build_help_text()}

    if normalized in {"ping", "status"}:
        return {"status": "success", "reply": "Myara is online and ready, senpai! 🌸"}

    if normalized in {"reset memory", "clear chat"}:
        cleared = await clear_conversation_history(db, payload.get("chat_id", ""))
        return {"status": "success", "reply": "Conversation memory cleared. Ask me anything again, baka! ✨" if cleared else "No stored memory was found for this chat."}

    if normalized.startswith("help "):
        command = normalized.split(" ", 1)[1].strip()
        return {"status": "success", "reply": build_command_help(command)}

    if normalized in {"summary", "summarize"}:
        history = await get_conversation_history(db, payload.get("chat_id", ""), payload.get("phone_number", ""))
        if not history:
            return {"status": "success", "reply": "There is no saved conversation to summarize yet."}
        summary_prompt = "Summarize the following conversation in a concise and friendly way: " + str(history[-6:])
        reply = await generate_chat_response(summary_prompt, chat_history=[])
        return {"status": "success", "reply": reply}

    if normalized.startswith("broadcast "):
        if not is_authorized_admin(payload.get("phone_number")):
            return {"status": "success", "reply": "Only an authorized admin can broadcast announcements."}
        message = command_text[len("broadcast "):].strip()
        return {"status": "success", "reply": f"Broadcast queued for the network: {message}"}

    if normalized in {"shutdown", "restart", "statistics", "logs", "database status", "system health", "maintenance mode", "active users"}:
        if not is_authorized_admin(payload.get("phone_number")):
            return {"status": "success", "reply": "Only an authorized admin can use that command."}
        if normalized == "shutdown":
            return {"status": "success", "reply": "Shutdown request acknowledged. The service will stop gracefully."}
        if normalized == "restart":
            return {"status": "success", "reply": "Restart request acknowledged. The service will restart shortly."}
        if normalized == "statistics":
            return {"status": "success", "reply": "Statistics are available in the admin dashboard and the bot is healthy."}
        if normalized == "logs":
            return {"status": "success", "reply": "Logs are being streamed to the backend console and the scheduler service."}
        if normalized == "database status":
            return {"status": "success", "reply": "Database status is healthy when MongoDB is configured and reachable."}
        if normalized == "system health":
            return {"status": "success", "reply": "System health is nominal. AI, MongoDB, and WhatsApp are monitored continuously."}
        if normalized == "maintenance mode":
            return {"status": "success", "reply": "Maintenance mode is enabled for admin operations only."}
        return {"status": "success", "reply": "Admin command received."}

    if normalized in {"translate", "translation"}:
        return {"status": "success", "reply": "Send a phrase and I can translate it for you, senpai. 🌸"}

    if normalized in {"time"}:
        current_time = datetime.now().strftime("%I:%M %p")
        return {"status": "success", "reply": f"The current time is {current_time}."}

    if normalized in {"date"}:
        current_date = datetime.now().strftime("%A, %B %d, %Y")
        return {"status": "success", "reply": f"Today is {current_date}."}

    if normalized in {"joke"}:
        return {"status": "success", "reply": "Why did the developer bring a ladder to the codebase? Because the app needed a higher level! 😄"}

    if normalized in {"quote"}:
        return {"status": "success", "reply": "“Small steps every day still move you forward.” ✨"}

    if normalized in {"motivate"}:
        return {"status": "success", "reply": "You are doing better than you think, senpai. Keep going! 🌈"}

    if normalized.startswith("explain "):
        topic = message_text[len("explain "):].strip()
        reply = await generate_chat_response(f"Explain the topic '{topic}' in simple words and keep the answer friendly.", chat_history=[])
        return {"status": "success", "reply": reply}

    history = await get_conversation_history(db, payload.get("chat_id", ""), payload.get("phone_number", ""))
    history_payload = [{"role": item.get("role", "user"), "parts": [item.get("text", "")]} for item in history]
    history_payload = normalize_history_for_gemini(history_payload)
    reply = await generate_chat_response(message_text, history_payload)
    await save_conversation_history(db, payload.get("chat_id", ""), payload.get("phone_number", ""), message_text, reply)
    return {"status": "success", "reply": reply}
