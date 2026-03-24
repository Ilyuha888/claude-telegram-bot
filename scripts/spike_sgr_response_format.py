#!/usr/bin/env python3
"""
Spike: verify Gemini 2.5 Flash response_format (structured output / SGR) via openai SDK.

Tests three scenarios relevant to the orchestrator:
  1. json_object mode — basic JSON enforcement, no schema
  2. json_schema mode — schema-constrained output (Pydantic-derived)
  3. SGR pattern — schema includes a reasoning field before the decision field

Usage:
    OPENAI_API_KEY=<your-gemini-key> \\
    OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/ \\
    python scripts/spike_sgr_response_format.py

Default model: gemini-2.5-flash-preview-04-17
Override: MODEL=<model-id> python scripts/spike_sgr_response_format.py

Requires: openai >= 1.30 (json_schema response_format support)
"""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Any

try:
    import openai
    from pydantic import BaseModel, ValidationError
except ImportError as e:
    print(f"[ERROR] Missing dependency: {e}")
    print("Install with: pip install openai pydantic")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

API_KEY = os.environ.get("OPENAI_API_KEY", "")
BASE_URL = os.environ.get(
    "OPENAI_BASE_URL",
    "https://generativelanguage.googleapis.com/v1beta/openai/",
)
MODEL = os.environ.get("MODEL", "models/gemini-2.5-flash")


# ---------------------------------------------------------------------------
# Pydantic schemas for structured output
# ---------------------------------------------------------------------------


class IntentClassification(BaseModel):
    """Schema for Test 2: plain json_schema mode, no reasoning field."""

    intent: str
    confidence: str  # "high" | "medium" | "low"
    requires_tool: bool


class IntentClassificationWithReasoning(BaseModel):
    """Schema for Test 3: SGR pattern — reasoning field comes first."""

    reasoning: str  # LLM explains its logic here before committing
    intent: str
    confidence: str  # "high" | "medium" | "low"
    requires_tool: bool


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------

results: list[tuple[str, bool, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    results.append((name, condition, detail))
    status = "PASS" if condition else "FAIL"
    print(f"  [{status}] {name}" + (f" — {detail}" if detail else ""))


def pydantic_to_json_schema(model: type[BaseModel]) -> dict[str, Any]:
    """Convert a Pydantic model to a JSON schema dict for response_format."""
    schema = model.model_json_schema()
    # Remove $defs if present (openai expects a flat schema for simple models)
    return schema


# ---------------------------------------------------------------------------
# Test 1: json_object mode
# ---------------------------------------------------------------------------

def test_json_object_mode(client: openai.OpenAI) -> None:
    print("\n=== Test 1: json_object mode ===")
    t0 = time.perf_counter()
    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=[
                {
                    "role": "user",
                    "content": (
                        "Classify this user message as an intent. "
                        "Reply with a JSON object containing: "
                        "intent (string), confidence (high/medium/low), requires_tool (boolean). "
                        "Message: 'remind me to review my notes tomorrow at 9am'"
                    ),
                }
            ],
            response_format={"type": "json_object"},
        )
        elapsed_ms = (time.perf_counter() - t0) * 1000
        content = response.choices[0].message.content
        check("response received", content is not None, f"{elapsed_ms:.0f}ms")

        parsed = json.loads(content)  # type: ignore[arg-type]
        check("response is valid JSON", True)
        check("contains 'intent' key", "intent" in parsed, str(parsed.get("intent")))
        check("contains 'confidence' key", "confidence" in parsed)
        check("contains 'requires_tool' key", "requires_tool" in parsed)

    except json.JSONDecodeError as e:
        check("response is valid JSON", False, str(e))
    except openai.APIError as e:
        check("API call succeeded", False, f"{type(e).__name__}: {e}")


# ---------------------------------------------------------------------------
# Test 2: json_schema mode — typed schema, no reasoning
# ---------------------------------------------------------------------------

def test_json_schema_mode(client: openai.OpenAI) -> None:
    print("\n=== Test 2: json_schema mode (typed, no reasoning) ===")
    schema = pydantic_to_json_schema(IntentClassification)
    t0 = time.perf_counter()
    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=[
                {
                    "role": "user",
                    "content": (
                        "Classify this user message. "
                        "Message: 'show me all notes tagged #project'"
                    ),
                }
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "IntentClassification",
                    "strict": True,
                    "schema": schema,
                },
            },
        )
        elapsed_ms = (time.perf_counter() - t0) * 1000
        content = response.choices[0].message.content
        check("response received", content is not None, f"{elapsed_ms:.0f}ms")

        parsed = IntentClassification.model_validate_json(content)  # type: ignore[arg-type]
        check("parses against Pydantic schema", True)
        check(
            "confidence is valid enum value",
            parsed.confidence in {"high", "medium", "low"},
            parsed.confidence,
        )
        check("intent is non-empty string", bool(parsed.intent), parsed.intent)
        check(
            "requires_tool is boolean",
            isinstance(parsed.requires_tool, bool),
            str(parsed.requires_tool),
        )

    except ValidationError as e:
        check("parses against Pydantic schema", False, str(e))
    except openai.APIError as e:
        check("API call succeeded", False, f"{type(e).__name__}: {e}")


# ---------------------------------------------------------------------------
# Test 3: SGR pattern — reasoning field in schema
# ---------------------------------------------------------------------------

def test_sgr_reasoning_schema(client: openai.OpenAI) -> None:
    print("\n=== Test 3: SGR pattern — reasoning field before decision ===")
    schema = pydantic_to_json_schema(IntentClassificationWithReasoning)
    t0 = time.perf_counter()
    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are an intent classifier for a personal assistant. "
                        "First explain your reasoning, then provide your classification."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        "Classify this user message. "
                        "Message: 'what did I decide about the API design last week?'"
                    ),
                },
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "IntentClassificationWithReasoning",
                    "strict": True,
                    "schema": schema,
                },
            },
        )
        elapsed_ms = (time.perf_counter() - t0) * 1000
        content = response.choices[0].message.content
        check("response received", content is not None, f"{elapsed_ms:.0f}ms")

        parsed = IntentClassificationWithReasoning.model_validate_json(content)  # type: ignore[arg-type]
        check("parses against SGR schema", True)
        check(
            "reasoning field is non-empty",
            len(parsed.reasoning) > 10,
            f"{len(parsed.reasoning)} chars",
        )
        check(
            "confidence is valid enum value",
            parsed.confidence in {"high", "medium", "low"},
            parsed.confidence,
        )
        check("intent is non-empty string", bool(parsed.intent), parsed.intent)

        # Print the reasoning so we can inspect auditability
        print(f"\n  Reasoning field content:\n  > {parsed.reasoning[:200]}")
        print(f"  Intent: {parsed.intent!r} | Confidence: {parsed.confidence} | Tool: {parsed.requires_tool}")

    except ValidationError as e:
        check("parses against SGR schema", False, str(e))
    except openai.APIError as e:
        check("API call succeeded", False, f"{type(e).__name__}: {e}")


# ---------------------------------------------------------------------------
# Test 4: SGR on session compaction (realistic call type)
# ---------------------------------------------------------------------------

class CompactionOutput(BaseModel):
    reasoning: str  # why these items were selected/dropped
    rolling_summary: str
    extracted_pending_tasks: list[str]
    extracted_open_loops: list[str]


def test_sgr_compaction(client: openai.OpenAI) -> None:
    print("\n=== Test 4: SGR on session compaction (realistic call) ===")
    schema = pydantic_to_json_schema(CompactionOutput)
    t0 = time.perf_counter()
    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You compact conversation history into structured session state. "
                        "First reason about what to keep, then produce the output."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        "Compact this conversation history:\n\n"
                        "User: Can you draft a note summarizing the API design meeting?\n"
                        "Assistant: Sure, I've drafted a note and sent it for review.\n"
                        "User: Also remind me to follow up with the team on Thursday.\n"
                        "Assistant: I've scheduled a reminder for Thursday.\n"
                        "User: What was the conclusion on authentication?\n"
                        "Assistant: We decided to use JWT with a 24h expiry and refresh tokens."
                    ),
                },
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "CompactionOutput",
                    "strict": True,
                    "schema": schema,
                },
            },
        )
        elapsed_ms = (time.perf_counter() - t0) * 1000
        content = response.choices[0].message.content
        check("response received", content is not None, f"{elapsed_ms:.0f}ms")

        parsed = CompactionOutput.model_validate_json(content)  # type: ignore[arg-type]
        check("parses against compaction schema", True)
        check("reasoning field populated", len(parsed.reasoning) > 10, f"{len(parsed.reasoning)} chars")
        check("rolling_summary populated", len(parsed.rolling_summary) > 10)
        check(
            "extracted_pending_tasks is a list",
            isinstance(parsed.extracted_pending_tasks, list),
            f"{len(parsed.extracted_pending_tasks)} items",
        )
        check(
            "extracted_open_loops is a list",
            isinstance(parsed.extracted_open_loops, list),
            f"{len(parsed.extracted_open_loops)} items",
        )

    except ValidationError as e:
        check("parses against compaction schema", False, str(e))
    except openai.APIError as e:
        check("API call succeeded", False, f"{type(e).__name__}: {e}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    if not API_KEY:
        print(
            "[SKIP] OPENAI_API_KEY is not set.\n"
            "Set OPENAI_API_KEY and OPENAI_BASE_URL to run the spike.\n\n"
            "Example:\n"
            "  OPENAI_API_KEY=<key> \\\n"
            "  OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/ \\\n"
            "  python scripts/spike_sgr_response_format.py"
        )
        return 0

    print(f"Model : {MODEL}")
    print(f"Endpoint: {BASE_URL}")
    print(f"openai SDK: {openai.__version__}")

    client = openai.OpenAI(api_key=API_KEY, base_url=BASE_URL)

    test_json_object_mode(client)
    test_json_schema_mode(client)
    test_sgr_reasoning_schema(client)
    test_sgr_compaction(client)

    # Summary
    print("\n" + "=" * 60)
    passed = sum(1 for _, ok, _ in results if ok)
    failed = sum(1 for _, ok, _ in results if not ok)
    print(f"Results: {passed} passed, {failed} failed, {len(results)} total")

    if failed:
        print("\nFAILED checks:")
        for name, ok, detail in results:
            if not ok:
                print(f"  - {name}" + (f" ({detail})" if detail else ""))
        return 1

    print("\nAll checks PASSED.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
