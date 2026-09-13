"""Proposed SDK compatibility tests; real SDK routing and wire serialization."""
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from acp.agent.connection import AgentSideConnection
from acp.agent.router import build_agent_router
from acp.client.router import build_client_router
from acp.schema import SessionNotification
from acp.utils import serialize_params


@pytest.mark.asyncio
@pytest.mark.parametrize("session,supported", [
    (None, False), ({}, False), ({"compaction": None}, False), ({"compaction": {}}, True),
])
async def test_initialization_preserves_compaction_negotiation(session, supported):
    captured = {}
    async def initialize(**kwargs):
        captured.update(kwargs)
    router = build_agent_router(SimpleNamespace(initialize=initialize), use_unstable_protocol=True)
    capabilities = {"auth": {"terminal": False}}
    if session is not None:
        capabilities["session"] = session
    await router("initialize", {"protocolVersion": 1, "clientCapabilities": capabilities}, False)
    parsed = captured["client_capabilities"]
    parsed_session = getattr(parsed, "session", None)
    assert (getattr(parsed_session, "compaction", None) is not None) is supported
    if supported:
        assert serialize_params(parsed)["session"] == {"compaction": {}}


async def roundtrip(update):
    received = []
    async def session_update(**kwargs):
        received.append(kwargs)
    client_router = build_client_router(SimpleNamespace(session_update=session_update))
    wire = []
    async def send_notification(method, params):
        wire.append((method, params))
        await client_router(method, params, True)
    connection = object.__new__(AgentSideConnection)
    connection._conn = SimpleNamespace(send_notification=send_notification)
    await connection.session_update("s1", update)
    assert len(received) == 1
    assert received[0]["session_id"] == "s1"
    return wire[0], received[0]["update"]


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["in_progress", "completed", "failed", "cancelled", "future_status", "_custom"])
async def test_lifecycle_uses_standard_session_update_roundtrip(status):
    update = {"sessionUpdate": "compaction_update", "compactionId": "c1", "status": status}
    (method, params), parsed = await roundtrip(update)
    assert method == "session/update"
    assert params == {"sessionId": "s1", "update": update}
    assert parsed.compaction_id == "c1"
    assert parsed.status == status


@pytest.mark.asyncio
@pytest.mark.parametrize("patch", [
    {}, {"summary": None}, {"summary": []}, {"error": None}, {"_meta": None},
    {"summary": [{"type": "text", "text": "synthetic summary"}]},
    {"_meta": {"test": 1}},
])
async def test_update_patch_omission_null_empty_and_values_survive_serialization(patch):
    update = {"sessionUpdate": "compaction_update", "compactionId": "c1", "status": "completed", **patch}
    (_, params), parsed = await roundtrip(update)
    assert params["update"] == update
    assert serialize_params(SessionNotification(session_id="s1", update=parsed))["update"] == update


@pytest.mark.asyncio
async def test_failed_error_and_summary_chunk_roundtrip():
    error = {"sessionUpdate": "compaction_update", "compactionId": "c1", "status": "failed", "error": "synthetic error"}
    assert (await roundtrip(error))[0][1]["update"] == error
    chunk = {"sessionUpdate": "compaction_summary_chunk", "compactionId": "c1", "content": {"type": "text", "text": "synthetic"}}
    assert (await roundtrip(chunk))[0][1]["update"] == chunk


@pytest.mark.parametrize("patch", [
    {"status": "in_progress", "summary": [{"type": "text", "text": "not complete"}]},
    {"status": "completed", "error": "not a failure"},
    {"status": 5}, {"compactionId": 5},
])
def test_invalid_compaction_payloads_reject(patch):
    update = {"sessionUpdate": "compaction_update", "compactionId": "c1", "status": "in_progress", **patch}
    with pytest.raises(ValidationError):
        SessionNotification(session_id="s1", update=update)


@pytest.mark.asyncio
async def test_legacy_message_payload_remains_unchanged():
    update = {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hello"}}
    (method, params), parsed = await roundtrip(update)
    assert method == "session/update"
    assert params == {"sessionId": "s1", "update": update}
    assert parsed.content.text == "hello"


@pytest.mark.parametrize("update", [
    {"sessionUpdate": "not_a_real_update"},
    {"sessionUpdate": "agent_message_chunk", "content": {"type": "not_a_real_content"}},
    {"sessionUpdate": "agent_message_chunk"},
])
def test_unknown_or_malformed_legacy_updates_still_reject(update):
    with pytest.raises(ValidationError):
        SessionNotification(session_id="s1", update=update)
