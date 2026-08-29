"""
VARI AI Emergency Detection and Context Analysis
Determines if a message is Wari/safety-related and what type of emergency (if any)
"""

import logging
import re
from typing import Optional, Tuple

logger = logging.getLogger(__name__)


class EmergencyDetectionResult:
    """Result of emergency detection analysis"""

    def __init__(
        self,
        is_emergency: bool = False,
        is_wari_related: bool = False,
        emergency_type: Optional[str] = None,
        confidence: float = 0.0,
        keywords_found: list[str] = None,
    ):
        self.is_emergency = is_emergency
        self.is_wari_related = is_wari_related
        self.emergency_type = emergency_type  # e.g. "medical", "lost_person", "crowd_crush"
        self.confidence = confidence  # 0.0 - 1.0
        self.keywords_found = keywords_found or []


# ============================================================
# EMERGENCY KEYWORDS
# ============================================================

EMERGENCY_KEYWORDS = {
    "help": 0.7,
    "emergency": 1.0,
    "accident": 0.9,
    "injured": 0.95,
    "injury": 0.9,
    "unconscious": 1.0,
    "unconsciousness": 1.0,
    "bleeding": 0.95,
    "blood": 0.8,
    "fire": 0.95,
    "stampede": 1.0,
    "crowd crush": 1.0,
    "crowd": 0.4,  # Low confidence, needs context
    "crush": 0.6,  # Medium confidence
    "trapped": 0.95,
    "stuck": 0.7,
    "missing": 0.8,
    "lost": 0.7,
    "child": 0.5,  # Medium, needs context
    "children": 0.5,
    "lost child": 1.0,
    "missing child": 1.0,
    "missing person": 1.0,
    "lost person": 1.0,
    "danger": 0.8,
    "dangerous": 0.7,
    "dangerous crowd": 1.0,
    "dangerous conditions": 0.9,
    "ambulance": 0.95,
    "police": 0.6,  # Medium, might not be emergency
    "rescue": 0.8,
    "dying": 1.0,
    "death": 0.8,
    "dead": 0.8,
    "collapse": 0.9,
    "collapsed": 0.9,
    "heart attack": 1.0,
    "cardiac": 0.95,
    "seizure": 0.95,
    "choking": 1.0,
    "suffocating": 1.0,
    "can't breathe": 1.0,
    "can't breath": 1.0,  # Common misspelling
    "no breathing": 1.0,
    "severe pain": 0.9,
    "severe bleeding": 1.0,
    "head injury": 0.95,
    "crush injury": 1.0,
    "fracture": 0.85,
    "broken": 0.8,
    "broken bone": 0.9,
    "heat stroke": 0.95,
    "dehydration": 0.8,
    "heatstroke": 0.95,
    "severe": 0.6,  # Medium, needs context
    "critical": 0.7,
    "urgent": 0.8,
    "asap": 0.7,
    "immediately": 0.6,
    "right now": 0.5,
    "panic": 0.7,
    "panicking": 0.7,
}

# Hindi emergency keywords
HINDI_EMERGENCY_KEYWORDS = {
    "madad": 0.9,  # help
    "aapaat": 1.0,  # emergency
    "kharabi": 0.8,  # accident/problem
    "chot": 0.9,  # injury
    "lag gai": 0.9,  # injured
    "khun": 0.8,  # blood
    "aag": 0.9,  # fire
    "dabanch": 1.0,  # stampede (Hindi/Marathi)
    "bhid": 0.6,  # crowd
    "bheed ka dabav": 1.0,  # crowd crush
    "phans gaya": 0.8,  # trapped
    "khoya hua": 0.8,  # lost
    "gumshuda": 0.9,  # missing
    "gumshuda bachcha": 1.0,  # missing child
    "gumshuda aadmi": 1.0,  # missing person
    "khatra": 0.9,  # danger
    "ambulance": 0.95,
    "police": 0.6,
    "bachaao": 1.0,  # rescue/save
    "mar gaya": 1.0,  # dying/dead
    "mar jayega": 0.95,  # will die
    "saans na aa raha": 1.0,  # can't breathe
    "saans ruk gaya": 1.0,  # stopped breathing
    "hriday ghaat": 1.0,  # heart attack
    "tabiyat kharab": 0.7,  # feeling unwell
}

# Kannada emergency keywords
KANNADA_EMERGENCY_KEYWORDS = {
    "maddu": 0.9,  # help
    "sangata": 1.0,  # emergency
    "hettakke": 0.9,  # accident
    "hari": 0.9,  # injury
    "gada": 0.9,  # injury
    "kayive": 0.8,  # blood
    "aggi": 0.95,  # fire
    "bhaida dabbana": 1.0,  # crowd crush
    "bhaida": 0.6,  # crowd
    "gutti": 0.9,  # trapped
    "kallisutti": 0.8,  # lost
    "hilisu": 0.8,  # lost/missing
    "magi hilisu": 1.0,  # missing child
    "manushya hilisu": 1.0,  # missing person
    "sattu": 0.9,  # danger
    "sattunade": 0.9,  # dangerous
    "ambulansu": 0.95,
    "police": 0.6,
    "uddaru": 0.9,  # save/rescue
    "maranada state": 1.0,  # dying state
    "swasa nasa": 1.0,  # can't breathe
}

# Marathi emergency keywords
MARATHI_EMERGENCY_KEYWORDS = {
    "madad": 0.9,  # help
    "achatuk": 1.0,  # emergency
    "durghatan": 0.9,  # accident
    "chot": 0.9,  # injury
    "khun": 0.8,  # blood
    "ag": 0.95,  # fire
    "bhedbhari": 1.0,  # crowd crush
    "bhed": 0.6,  # crowd
    "bhagidari": 0.8,  # trapped
    "kharla": 0.8,  # lost
    "gumshuda": 0.9,  # missing
    "gumshuda baghina": 1.0,  # missing child
    "gumshuda manis": 1.0,  # missing person
    "khatara": 0.9,  # danger
    "ambulans": 0.95,
    "police": 0.6,
    "bacha": 0.9,  # save
    "prana ne kade": 1.0,  # near death
    "shas navlat": 1.0,  # can't breathe
}

WARI_CONTEXT_KEYWORDS = {
    "wari": 0.9,
    "yatra": 0.8,
    "pilgrimage": 0.8,
    "pilgrim": 0.6,
    "crowd": 0.3,  # Low confidence alone
    "festival": 0.4,
    "event": 0.3,
    "gathering": 0.4,
    "religious": 0.5,
    "temple": 0.4,
    "shrine": 0.4,
    "rasta": 0.3,  # Road/way in Hindi
}

LOST_PERSON_KEYWORDS = {
    "lost": 0.7,
    "missing": 0.8,
    "can't find": 0.8,
    "looking for": 0.6,
    "have you seen": 0.8,
    "child": 0.5,
    "son": 0.4,
    "daughter": 0.4,
    "friend": 0.3,
    "family": 0.3,
    "alone": 0.4,
}

CROWD_SAFETY_KEYWORDS = {
    "crowd": 0.4,
    "crowded": 0.5,
    "dense": 0.6,
    "crushing": 0.8,
    "crush": 0.6,
    "pushing": 0.6,
    "shoving": 0.7,
    "stampede": 1.0,
    "suffocating": 0.9,
    "can't breathe": 1.0,
    "packed": 0.5,
    "stuck": 0.7,
    "trapped": 0.8,
    "bodies": 0.6,
    "pressure": 0.5,
    "dangerous": 0.6,
    "dangerous crowd": 1.0,
    "crowd dangerous": 1.0,
}

MEDICAL_KEYWORDS = {
    "injured": 0.95,
    "bleeding": 0.95,
    "unconscious": 1.0,
    "pain": 0.6,
    "severe pain": 0.9,
    "heart": 0.5,
    "chest pain": 0.9,
    "breathing": 0.5,
    "difficulty breathing": 0.95,
    "can't breathe": 1.0,
    "dehydration": 0.8,
    "heat stroke": 0.95,
    "seizure": 0.95,
    "fracture": 0.85,
    "broken": 0.8,
    "wound": 0.8,
    "headache": 0.4,
    "fever": 0.5,
    "medical": 0.6,
}


# ============================================================
# DETECTION FUNCTIONS
# ============================================================


def _normalize_text(text: str) -> str:
    """Normalize text for comparison"""
    return text.lower().strip()


def _extract_keywords(text: str, keyword_dict: dict) -> Tuple[list, float]:
    """Extract matching keywords and calculate confidence"""
    text_lower = _normalize_text(text)
    found_keywords = []
    confidences = []

    for keyword, confidence in keyword_dict.items():
        # Exact word match with word boundaries
        if re.search(r"\b" + re.escape(keyword) + r"\b", text_lower):
            found_keywords.append(keyword)
            confidences.append(confidence)

    if not confidences:
        return found_keywords, 0.0

    # Average confidence of found keywords, but use max if multiple found
    avg_confidence = sum(confidences) / len(confidences)
    max_confidence = max(confidences)

    # Boost confidence based on number of keywords found
    if len(confidences) > 1:
        return found_keywords, min(1.0, max_confidence * (1 + (len(confidences) - 1) * 0.1))
    return found_keywords, avg_confidence


def detect_emergency(text: str) -> EmergencyDetectionResult:
    """
    Detect if message indicates an emergency.
    Returns EmergencyDetectionResult with confidence and type.
    """
    if not text or not isinstance(text, str):
        return EmergencyDetectionResult(is_emergency=False, is_wari_related=False)

    text = _normalize_text(text)

    # Check for emergency keywords
    emergency_keywords, emergency_confidence = _extract_keywords(text, EMERGENCY_KEYWORDS)
    hindi_keywords, hindi_confidence = _extract_keywords(text, HINDI_EMERGENCY_KEYWORDS)
    kannada_keywords, kannada_confidence = _extract_keywords(text, KANNADA_EMERGENCY_KEYWORDS)
    marathi_keywords, marathi_confidence = _extract_keywords(text, MARATHI_EMERGENCY_KEYWORDS)

    combined_emergency_confidence = max(
        emergency_confidence, hindi_confidence, kannada_confidence, marathi_confidence
    )

    all_emergency_keywords = (
        emergency_keywords + hindi_keywords + kannada_keywords + marathi_keywords
    )

    # Determine emergency type
    emergency_type = None
    lost_keywords, lost_confidence = _extract_keywords(text, LOST_PERSON_KEYWORDS)
    crowd_keywords, crowd_confidence = _extract_keywords(text, CROWD_SAFETY_KEYWORDS)
    medical_keywords, medical_confidence = _extract_keywords(text, MEDICAL_KEYWORDS)

    if lost_confidence > 0.5 and ("lost" in text or "missing" in text):
        emergency_type = "lost_person"
    elif crowd_confidence > 0.6:
        emergency_type = "crowd_safety"
    elif medical_confidence > 0.6:
        emergency_type = "medical"

    # Check if it's Wari-related
    wari_keywords, wari_confidence = _extract_keywords(text, WARI_CONTEXT_KEYWORDS)
    is_wari_related = wari_confidence > 0.4 or "wari" in text or "yatra" in text

    # Determine if it's a real emergency
    # Lower threshold if Wari-related
    emergency_threshold = 0.6 if is_wari_related else 0.7
    is_emergency = combined_emergency_confidence >= emergency_threshold

    # Very high confidence keywords always trigger emergency
    if combined_emergency_confidence >= 0.9:
        is_emergency = True

    return EmergencyDetectionResult(
        is_emergency=is_emergency,
        is_wari_related=is_wari_related,
        emergency_type=emergency_type,
        confidence=combined_emergency_confidence,
        keywords_found=all_emergency_keywords,
    )


def should_use_vari_persona(text: str) -> bool:
    """
    Determines if VARI AI persona should be used instead of MYARA.
    Returns True if message is safety/Wari-related.
    """
    if not text or not isinstance(text, str):
        return False

    result = detect_emergency(text)

    # Use VARI if:
    # 1. It's an emergency
    # 2. It's Wari/safety-related
    # 3. Common Wari-related keywords are present
    if result.is_emergency or result.is_wari_related:
        return True

    text_lower = _normalize_text(text)

    # Explicit VARI-related commands/questions
    vari_commands = [
        "safety", "safe", "emergency", "help", "danger",
        "lost person", "missing", "crowd", "wari", "yatra",
        "medical", "injury", "emergency report", "vari"
    ]

    if any(cmd in text_lower for cmd in vari_commands):
        return True

    return False


def get_emergency_response_guidance(result: EmergencyDetectionResult) -> Optional[str]:
    """
    Returns guidance for emergency response based on detection result.
    """
    if not result.is_emergency:
        return None

    guidance = f"🚨 Emergency detected (confidence: {result.confidence:.0%})"

    if result.emergency_type:
        guidance += f"\nType: {result.emergency_type}"

    if result.keywords_found:
        guidance += f"\nKeywords: {', '.join(result.keywords_found[:5])}"

    return guidance


# ============================================================
# LOGGING
# ============================================================


def log_detection(text: str, result: EmergencyDetectionResult) -> None:
    """Log detection result for monitoring"""
    logger.info(
        "[VARI] Detection | Emergency: %s | Wari: %s | Type: %s | Confidence: %.2f | Keywords: %s",
        result.is_emergency,
        result.is_wari_related,
        result.emergency_type,
        result.confidence,
        ", ".join(result.keywords_found[:3]),
    )
