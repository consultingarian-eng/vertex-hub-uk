"""A backend/.env copied straight from .env.example must boot.

.env.example lists every setting, most of them blank (`OWNERIQ_LIVE_TTL=`,
`CI_SPLIT_GAP_S=`, `ANTHROPIC_MODEL=` …). A blank line in .env arrives as an
empty string, not as "unset", and `int("")` / `float("")` at import time used
to take the whole server down. Every env read now treats empty as unset
(`os.getenv(X) or default`). This test loads the example file exactly as a new
owner would copy it — only the required values filled in — and imports the app
in a clean subprocess.
"""
import os
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]


def _example_env() -> dict:
    env = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")}
    # Windows can't load its network stack (asyncio import) without SYSTEMROOT.
    if os.environ.get("SYSTEMROOT"):
        env["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
    for line in (BACKEND / ".env.example").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip()
    env.update(
        JWT_SECRET="example-secret-0123456789abcdef0123456789abcdef",
        ADMIN_EMAIL="owner@example.org",
        ADMIN_PASSWORD="example-password-123",
        DB_NAME="vertex_dev",
    )
    return env


def test_example_file_has_blank_optional_settings():
    env = _example_env()
    assert any(v == "" for v in env.values()), "the scenario under test needs blank lines"


def test_server_imports_with_every_example_setting_blank():
    result = subprocess.run(
        [sys.executable, "-c", "import server; print('ok')"],
        cwd=BACKEND, env=_example_env(), capture_output=True, text=True, timeout=120,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    assert result.stdout.strip().endswith("ok")
