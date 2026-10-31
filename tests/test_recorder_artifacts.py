"""制品结构一致性测试（G5 门禁自检 pytest 回退路径执行）。

目标仓为 Node/TS 项目，行为回归主体在 Vitest（npm test，tests/**/*.test.ts）。
本文件用语言无关方式锁定 MCP 交付物的结构契约——金额为分整数、录入必填字段、
注册配置只含凭据变量名（不含真实值）、汇率源为免费无密钥主机。
这些断言同时被 Vitest 侧覆盖逻辑行为，此处保证门禁回退运行器有真实断言可执行。
"""
import json
import os
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SCHEMA_PATH = REPO / "config/recorder.schema.json"
MCP_PATH = REPO / "config/money-growth-mcp.json"
FX_PATH = REPO / "scripts/mcp/fx.ts"
VITEST_PATH = REPO / "config/vitest.config.ts"


def _json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_recorder_schema_amounts_are_integer_cents() -> None:
    schema = _json(SCHEMA_PATH)
    assert schema["$schema"].endswith("draft-07/schema#")
    properties = schema["properties"]
    for field in ("assets", "income", "expense", "largeItems", "debts", "moduleGains"):
        item_props = properties[field]["items"]["properties"]
        cent_fields = [key for key in item_props if key.endswith("Cents")]
        assert cent_fields, field
        for key in cent_fields:
            declared = item_props[key]["type"]
            assert declared in ("integer", ["integer", "null"]), (field, key, declared)


def test_recorder_schema_required_top_level_fields() -> None:
    schema = _json(SCHEMA_PATH)
    assert schema["required"] == ["month", "treeConfigId", "catConfigId", "assets", "debts"]
    month_pattern = schema["properties"]["month"]["pattern"]
    assert re.match(month_pattern, "2026-10") and not re.match(month_pattern, "2026-13")


def test_mcp_registration_declares_only_variable_names() -> None:
    text = MCP_PATH.read_text(encoding="utf-8")
    config = _json(MCP_PATH)
    server = config["mcpServers"]["money-growth"]
    env_keys = set(server["env"])
    assert env_keys == {"MGS_ENV"}
    for key in ("MGS_URL", "MGS_INVITE_CODE", "MGS_USERNAME", "MGS_PASSWORD"):
        assert key not in server["env"]
        value = os.environ.get(key, "")
        if len(value) > 3:
            assert value not in text, key


def test_fx_sources_are_free_no_key_hosts() -> None:
    text = FX_PATH.read_text(encoding="utf-8")
    assert "api.frankfurter.dev" in text
    assert "open.er-api.com" in text
    assert not re.search(r"(api[_-]?key|apikey|access[_-]?token|token=)", text, re.IGNORECASE)


def test_vitest_scope_excludes_site_build() -> None:
    text = VITEST_PATH.read_text(encoding="utf-8")
    assert "tests/**/*.test.ts" in text
    assert "environment" in text and "node" in text
