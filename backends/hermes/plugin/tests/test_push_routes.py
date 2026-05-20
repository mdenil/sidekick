import asyncio
import json
from types import SimpleNamespace

from backends.hermes.plugin.sidekick_routes import handle_test


class FakeRequest:
    def __init__(self, body):
        self._body = body

    async def json(self):
        return self._body


class FakeDispatcher:
    def __init__(self):
        self.envelopes = []

    def dispatch_envelope(self, env):
        self.envelopes.append(env)
        return {"delivered": 1, "pruned": 0}


def _body(resp):
    return json.loads(resp.text)


def test_push_test_endpoint_synthesizes_notification_kind():
    dispatcher = FakeDispatcher()
    ctx = SimpleNamespace(dispatcher=dispatcher)

    resp = asyncio.run(handle_test(ctx, FakeRequest({
        "chat_id": "chat-1",
        "kind": "cron",
        "text": "Cron fired",
    })))

    assert resp.status == 200
    assert dispatcher.envelopes == [{
        "type": "notification",
        "chat_id": "chat-1",
        "content": "Cron fired",
        "text": "Cron fired",
        "should_push": True,
        "kind": "cron",
    }]
    assert _body(resp)["envelope"]["kind"] == "cron"


def test_push_test_endpoint_agent_reply_kind_uses_reply_final():
    dispatcher = FakeDispatcher()
    ctx = SimpleNamespace(dispatcher=dispatcher)

    resp = asyncio.run(handle_test(ctx, FakeRequest({
        "chat_id": "chat-2",
        "kind": "agent_reply",
        "body": "Agent finished",
    })))

    assert resp.status == 200
    assert dispatcher.envelopes[0]["type"] == "reply_final"
    assert "kind" not in dispatcher.envelopes[0]
    assert dispatcher.envelopes[0]["content"] == "Agent finished"
