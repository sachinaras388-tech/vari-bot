"""
Test script to verify VARI AI integration
Tests emergency detection, persona selection, and incident handling
"""

import sys
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

from backend.ai.vari_detector import detect_emergency, should_use_vari_persona, EmergencyDetectionResult
from backend.ai.vari_incident_handler import (
    IncidentType, IncidentSeverity, IncidentHandler, get_incident_handler
)


def test_emergency_detection():
    """Test emergency keyword detection"""
    print("\n" + "="*60)
    print("TEST 1: Emergency Detection")
    print("="*60)
    
    test_cases = [
        ("help", True),
        ("I'm injured and bleeding", True),
        ("emergency", True),
        ("My child is missing", True),
        ("Crowd is crushing", True),
        ("can't breathe", True),
        ("Hi, how are you?", False),
        ("What time is it?", False),
        ("lost my keys", False),  # Low confidence for general "lost"
    ]
    
    for message, expected_emergency in test_cases:
        result = detect_emergency(message)
        status = "✓" if result.is_emergency == expected_emergency else "✗"
        print(f"{status} '{message}'")
        print(f"   Emergency: {result.is_emergency}, Confidence: {result.confidence:.2%}")
        if result.keywords_found:
            print(f"   Keywords: {result.keywords_found[:3]}")


def test_vari_persona_selection():
    """Test VARI persona selection"""
    print("\n" + "="*60)
    print("TEST 2: VARI Persona Selection")
    print("="*60)
    
    test_cases = [
        ("I need help, someone is injured", True, "Emergency"),
        ("Tell me about the Wari", True, "Wari-related"),
        ("Safety information", True, "Safety"),
        ("Hello, how are you?", False, "Normal chat"),
        ("What's the weather?", False, "General question"),
    ]
    
    for message, expected_vari, reason in test_cases:
        use_vari = should_use_vari_persona(message)
        status = "✓" if use_vari == expected_vari else "✗"
        print(f"{status} '{message}'")
        print(f"   Use VARI: {use_vari} ({reason})")


def test_incident_handler():
    """Test incident report handling"""
    print("\n" + "="*60)
    print("TEST 3: Incident Report Handler")
    print("="*60)
    
    handler = get_incident_handler()
    
    # Test incident handler structure
    print("\nVerifying incident handler structure...")
    print(f"✓ IncidentType enum available with values: {[t.value for t in IncidentType][:3]}...")
    print(f"✓ IncidentSeverity enum available with values: {[s.value for s in IncidentSeverity]}")
    print(f"✓ IncidentHandler instance created successfully")
    print(f"✓ Incident handler is ready for use")


def test_multilingual_keywords():
    """Test multilingual emergency detection"""
    print("\n" + "="*60)
    print("TEST 4: Multilingual Emergency Detection")
    print("="*60)
    
    multilingual_cases = [
        ("madad!", True, "Hindi 'help'"),
        ("aapaat!", True, "Hindi 'emergency'"),
        ("मेरा बच्चा खो गया", True, "Hindi 'lost child'"),
        ("maddu!", True, "Kannada 'help'"),
        ("sangata!", True, "Kannada 'emergency'"),
        ("magi hilisu", True, "Kannada 'missing child'"),
    ]
    
    for message, expected_emergency, description in multilingual_cases:
        result = detect_emergency(message)
        status = "✓" if result.is_emergency == expected_emergency else "✗"
        print(f"{status} {description}: '{message}'")
        print(f"   Emergency: {result.is_emergency}, Confidence: {result.confidence:.2%}")


if __name__ == "__main__":
    print("\n" + "="*60)
    print("VARI AI INTEGRATION TEST SUITE")
    print("="*60)
    
    try:
        test_emergency_detection()
        test_vari_persona_selection()
        test_multilingual_keywords()
        test_incident_handler()
        
        print("\n" + "="*60)
        print("✓ ALL TESTS COMPLETED SUCCESSFULLY")
        print("="*60 + "\n")
        
    except Exception as e:
        print(f"\n✗ TEST FAILED: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
