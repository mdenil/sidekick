"""Shared test stubs for running the Sidekick Hermes plugin tests standalone.

The real plugin imports Hermes gateway modules at package import time. In the
Sidekick repo test environment those modules are not installed, so install the
small surface the plugin needs before test modules import backends.hermes.plugin.
Individual older tests still carry local copies of this setup; keeping this
central version makes collection order deterministic.
"""

from __future__ import annotations

import os
import sys
import types


def pytest_configure(config):  # noqa: ARG001 - pytest hook signature
    os.environ.setdefault("VAPID_PUBLIC_KEY", "test-public-key")
    os.environ.setdefault("VAPID_PRIVATE_KEY", "test-private-key")
    if "gateway" not in sys.modules:
        sys.modules["gateway"] = types.ModuleType("gateway")

    if "gateway.config" not in sys.modules:
        cfg = types.ModuleType("gateway.config")

        class Platform:
            SIDEKICK = "sidekick"

        class PlatformConfig:
            pass

        cfg.Platform = Platform
        cfg.PlatformConfig = PlatformConfig
        sys.modules["gateway.config"] = cfg

    if "gateway.platforms" not in sys.modules:
        sys.modules["gateway.platforms"] = types.ModuleType("gateway.platforms")

    if "gateway.platforms.base" not in sys.modules:
        base = types.ModuleType("gateway.platforms.base")

        class BasePlatformAdapter:
            pass

        class MessageEvent:
            pass

        class MessageType:
            TEXT = "text"
            PHOTO = "photo"
            VIDEO = "video"
            AUDIO = "audio"
            DOCUMENT = "document"

        class SendResult:
            def __init__(self, success=True, message_id="", **kwargs):
                self.success = success
                self.message_id = message_id
                for key, value in kwargs.items():
                    setattr(self, key, value)

        base.BasePlatformAdapter = BasePlatformAdapter
        base.MessageEvent = MessageEvent
        base.MessageType = MessageType
        base.SendResult = SendResult
        sys.modules["gateway.platforms.base"] = base

    if "py_vapid" not in sys.modules:
        py_vapid = types.ModuleType("py_vapid")

        class Vapid:
            def generate_keys(self):
                return None

            def save_private_key(self):
                return b""

            def save_public_key(self):
                return b""

        py_vapid.Vapid = Vapid
        sys.modules["py_vapid"] = py_vapid

    if "pywebpush" not in sys.modules:
        pywebpush = types.ModuleType("pywebpush")

        class WebPushException(Exception):
            def __init__(self, *args, response=None, **kwargs):
                super().__init__(*args)
                self.response = response

        def webpush(*args, **kwargs):
            return None

        pywebpush.webpush = webpush
        pywebpush.WebPushException = WebPushException
        sys.modules["pywebpush"] = pywebpush

    if "aiohttp" not in sys.modules:
        aiohttp = types.ModuleType("aiohttp")
        web = types.ModuleType("aiohttp.web")

        class Response:
            def __init__(self, *, text="", status=200, content_type=None):
                self.text = text
                self.status = status
                self.content_type = content_type

        class Request:
            pass

        def json_response(data, status=200):
            import json
            return Response(text=json.dumps(data), status=status, content_type="application/json")

        web.Response = Response
        web.Request = Request
        web.json_response = json_response
        aiohttp.web = web
        sys.modules["aiohttp"] = aiohttp
        sys.modules["aiohttp.web"] = web
