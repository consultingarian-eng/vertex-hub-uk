"""frontend/app.config.js must vary exactly one field, and only on demand.

That file exists solely so the hosted Metro dev server can serve a plain SPA
shell instead of building expo-router's server-rendering graph — bundling
~2200 modules twice in one Node process is what crashed CG1-Metro on its heap
limit. Everything else has to pass through untouched, because the same config
drives the production web export (`npx expo export --platform web`, run in the
backend image) and every native build.

The risk this guards against is a careless edit to app.config.js silently
dropping or reshaping a key for ALL builds. So the assertion is deep equality
against app.json, not a spot-check of a few fields.

Evaluates the config with plain node — no Expo CLI, no network, no build.
"""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

FRONTEND = Path(__file__).resolve().parents[1] / "frontend"
APP_JSON = FRONTEND / "app.json"
APP_CONFIG = FRONTEND / "app.config.js"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is required to evaluate app.config.js"
)


def resolve(env_value=None) -> dict:
    """Run app.config.js the way Expo does and return the config it produces."""
    env = {"PATH": "/opt/homebrew/bin:/usr/bin:/bin:/usr/local/bin"}
    # Windows: node needs SYSTEMROOT to start at all, and its own PATH entry.
    if os.environ.get("SYSTEMROOT"):
        env["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
        env["PATH"] = os.environ.get("PATH", "")
    if env_value is not None:
        env["EXPO_WEB_SPA"] = env_value
    proc = subprocess.run(
        ["node", "-e", "process.stdout.write(JSON.stringify(require('./app.config.js')()))"],
        cwd=FRONTEND, env=env, capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 0, f"app.config.js failed to evaluate:\n{proc.stderr}"
    return json.loads(proc.stdout)


@pytest.fixture(scope="module")
def app_json() -> dict:
    return json.loads(APP_JSON.read_text(encoding="utf-8"))["expo"]


def test_app_config_exists():
    assert APP_CONFIG.is_file(), "app.config.js is what this whole module is about"


# ─── the default path: production web + native builds ───────────────────────

@pytest.mark.parametrize("env_value", [None, "", "0", "false", "1 "])
def test_config_is_untouched_unless_explicitly_opted_in(app_json, env_value):
    """Anything other than exactly "1" must leave app.json alone.

    Deliberately includes '1 ' with a trailing space: an env var that merely
    *looks* like the opt-in must not silently reconfigure a production build.
    """
    assert resolve(env_value) == app_json


def test_production_web_export_still_gets_static_output(app_json):
    # The backend image serves the output of `expo export --platform web`,
    # which needs the static renderer. Losing this breaks the browser app.
    assert resolve()["web"]["output"] == "static"
    assert app_json["web"]["output"] == "static"


# ─── the opted-in path: the Metro dev server only ───────────────────────────

def test_opt_in_switches_web_to_a_single_page_shell():
    assert resolve("1")["web"]["output"] == "single"


def test_opt_in_changes_nothing_except_web_output(app_json):
    """The actual safety property. If this file ever starts dropping plugins,
    renaming the scheme, or mangling the bundle identifier, that lands in every
    Expo Go session and every build — so pin it to a one-key delta.
    """
    spa = resolve("1")
    assert set(spa) == set(app_json), "top-level keys must match app.json exactly"
    for key in app_json:
        if key == "web":
            continue
        assert spa[key] == app_json[key], f"{key!r} must be passed through untouched"
    # ...and within `web`, only `output` moves.
    assert set(spa["web"]) == set(app_json["web"])
    for key in app_json["web"]:
        if key == "output":
            continue
        assert spa["web"][key] == app_json["web"][key], f"web.{key!r} must be untouched"


def test_the_passthrough_assertion_is_not_vacuous(app_json):
    # Guards against app.json being empty/trivial, which would make the
    # deep-equality checks above pass without proving anything.
    assert len(app_json) >= 5
    assert app_json.get("plugins"), "expected plugins to be present to compare"
