"""
VARI AI Incident Report Handler
Manages incident reporting, lost person reports, and safety alerts
"""

import logging
import time
from typing import Any, Dict, Optional
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger(__name__)


class IncidentType(str, Enum):
    """Types of incidents VARI can handle"""
    MEDICAL = "medical"
    CROWD_CRUSH = "crowd_crush"
    LOST_PERSON = "lost_person"
    ACCIDENT = "accident"
    FIRE = "fire"
    STAMPEDE = "stampede"
    MISSING_CHILD = "missing_child"
    MISSING_ADULT = "missing_adult"
    SUSPICIOUS_ACTIVITY = "suspicious_activity"
    BLOCKED_ROAD = "blocked_road"
    UNSAFE_CONDITIONS = "unsafe_conditions"
    OTHER = "other"


class IncidentSeverity(str, Enum):
    """Severity levels for incidents"""
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class IncidentReport:
    """Represents an incident report"""
    incident_type: IncidentType
    severity: IncidentSeverity
    description: str
    location: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    timestamp: Optional[int] = None
    injured_count: Optional[int] = None
    person_name: Optional[str] = None
    person_age: Optional[int] = None
    person_clothing: Optional[str] = None
    person_last_seen: Optional[str] = None
    reporter_phone: Optional[str] = None
    reporter_name: Optional[str] = None
    additional_info: Optional[str] = None
    is_active: bool = True

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for storage/API"""
        return {
            "incident_type": self.incident_type.value if isinstance(self.incident_type, IncidentType) else self.incident_type,
            "severity": self.severity.value if isinstance(self.severity, IncidentSeverity) else self.severity,
            "description": self.description,
            "location": self.location,
            "latitude": self.latitude,
            "longitude": self.longitude,
            "timestamp": self.timestamp or int(time.time()),
            "injured_count": self.injured_count,
            "person_name": self.person_name,
            "person_age": self.person_age,
            "person_clothing": self.person_clothing,
            "person_last_seen": self.person_last_seen,
            "reporter_phone": self.reporter_phone,
            "reporter_name": self.reporter_name,
            "additional_info": self.additional_info,
            "is_active": self.is_active,
            "created_at": int(time.time()),
        }


class IncidentCollectionState:
    """Tracks state of incident information collection"""

    def __init__(self, incident_type: IncidentType):
        self.incident_type = incident_type
        self.collected_data: Dict[str, Any] = {}
        self.required_fields = self._get_required_fields(incident_type)
        self.current_step = 0

    def _get_required_fields(self, incident_type: IncidentType) -> list:
        """Get required fields for incident type"""
        if incident_type in (IncidentType.LOST_PERSON, IncidentType.MISSING_CHILD, IncidentType.MISSING_ADULT):
            return ["person_name", "person_age", "person_clothing", "person_last_seen", "location"]
        elif incident_type == IncidentType.MEDICAL:
            return ["description", "location", "injured_count"]
        elif incident_type in (IncidentType.CROWD_CRUSH, IncidentType.STAMPEDE):
            return ["location", "description", "injured_count"]
        else:
            return ["description", "location"]

    def add_field(self, field_name: str, value: Any) -> None:
        """Add collected field"""
        self.collected_data[field_name] = value

    def is_complete(self) -> bool:
        """Check if all required fields are collected"""
        return all(field in self.collected_data for field in self.required_fields)

    def get_next_prompt(self) -> Optional[str]:
        """Get prompt for next required field"""
        for field in self.required_fields:
            if field not in self.collected_data:
                return self._get_field_prompt(field)
        return None

    def _get_field_prompt(self, field_name: str) -> str:
        """Get user-friendly prompt for field"""
        prompts = {
            "person_name": "What is the person's name?",
            "person_age": "Approximate age? (e.g., 5, 15, 30)",
            "person_clothing": "What was they wearing? (describe clothes)",
            "person_last_seen": "When and where were they last seen?",
            "description": "Please describe what happened.",
            "location": "Where did this happen?",
            "injured_count": "How many people are injured?",
        }
        return prompts.get(field_name, f"Please provide: {field_name}")


# ============================================================
# INCIDENT HANDLER
# ============================================================


class IncidentHandler:
    """Main handler for incident reporting"""

    def __init__(self):
        self.active_reports: Dict[str, IncidentCollectionState] = {}

    async def start_report(self, chat_id: str, incident_type: IncidentType, initial_message: str = "") -> str:
        """
        Start a new incident report.
        Returns the first prompt to collect information.
        """
        logger.info("[INCIDENT] Starting report | chat_id=%s | type=%s", chat_id, incident_type.value)

        state = IncidentCollectionState(incident_type)
        self.active_reports[chat_id] = state

        if initial_message:
            state.add_field("description", initial_message)

        next_prompt = state.get_next_prompt()
        if next_prompt:
            return next_prompt
        else:
            return "Got all information. Processing your report..."

    async def add_report_info(self, chat_id: str, field_name: str, value: Any) -> str:
        """
        Add information to active report.
        Returns next prompt or confirmation.
        """
        if chat_id not in self.active_reports:
            return "No active report found. Please start over."

        state = self.active_reports[chat_id]
        state.add_field(field_name, value)

        if state.is_complete():
            report = await self.finalize_report(chat_id)
            return f"✅ Report submitted successfully!\n\nReport ID: {self._generate_report_id()}"
        else:
            next_prompt = state.get_next_prompt()
            return next_prompt if next_prompt else "Processing..."

    async def finalize_report(self, chat_id: str) -> Optional[IncidentReport]:
        """
        Finalize and submit report.
        """
        if chat_id not in self.active_reports:
            return None

        state = self.active_reports[chat_id]
        report_data = state.collected_data

        incident = IncidentReport(
            incident_type=state.incident_type,
            severity=self._calculate_severity(state.incident_type),
            description=report_data.get("description", ""),
            location=report_data.get("location"),
            injured_count=report_data.get("injured_count"),
            person_name=report_data.get("person_name"),
            person_age=report_data.get("person_age"),
            person_clothing=report_data.get("person_clothing"),
            person_last_seen=report_data.get("person_last_seen"),
        )

        logger.info(
            "[INCIDENT] Report finalized | chat_id=%s | type=%s | severity=%s",
            chat_id,
            incident.incident_type.value,
            incident.severity.value,
        )

        # Clean up
        del self.active_reports[chat_id]

        return incident

    def cancel_report(self, chat_id: str) -> str:
        """Cancel active report"""
        if chat_id in self.active_reports:
            del self.active_reports[chat_id]
            logger.info("[INCIDENT] Report cancelled | chat_id=%s", chat_id)
            return "Report cancelled. Safe travels! 🛡️"
        return "No active report to cancel."

    def _calculate_severity(self, incident_type: IncidentType) -> IncidentSeverity:
        """Calculate severity based on incident type"""
        critical_types = {
            IncidentType.CROWD_CRUSH,
            IncidentType.STAMPEDE,
            IncidentType.FIRE,
            IncidentType.MISSING_CHILD,
        }

        if incident_type in critical_types:
            return IncidentSeverity.CRITICAL

        high_types = {IncidentType.MEDICAL, IncidentType.MISSING_ADULT, IncidentType.ACCIDENT}
        if incident_type in high_types:
            return IncidentSeverity.HIGH

        return IncidentSeverity.MEDIUM

    def _generate_report_id(self) -> str:
        """Generate unique report ID"""
        import random
        import string
        return "".join(random.choices(string.ascii_uppercase + string.digits, k=8))


# ============================================================
# SINGLETON INSTANCE
# ============================================================

_incident_handler: Optional[IncidentHandler] = None


def get_incident_handler() -> IncidentHandler:
    """Get or create incident handler instance"""
    global _incident_handler
    if _incident_handler is None:
        _incident_handler = IncidentHandler()
    return _incident_handler
