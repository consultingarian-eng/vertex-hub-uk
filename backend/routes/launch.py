"""Public 'Open the app' landing page (no auth), in the brand colours.

One shareable link — <your app URL>/launch — that opens the app the PWA way:
tap "Open <app name>" and add it to your home screen (iPhone Safari / Android
Chrome steps shown). The web app is the only install route; /get-app is a
permanent redirect here for old links.

Names come from core.brand (APP_NAME / ORG_NAME env). The logo is a lime
wordmark on a transparent background, so it always sits on the forest green;
it is served by this same app at /api/logo.png, and the monogram favicon is
inlined so the page needs nothing else.
"""
import os
import base64
from html import escape

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from core import brand as B

router = APIRouter()

# The page is served by the same app it opens, so a same-origin link works on
# every deployment without configuration.
WEB_APP_URL = "/"
LOGO_URL = "/api/logo.png"

_ASSETS = os.path.join(os.path.dirname(__file__), "..", "assets")


def _data_uri(filename: str, mime: str) -> str:
    try:
        with open(os.path.join(_ASSETS, filename), "rb") as f:
            return f"data:{mime};base64," + base64.b64encode(f.read()).decode()
    except Exception:
        return ""


_ICON = _data_uri("icon.svg", "image/svg+xml")
_ICON_LINK = f'<link rel="icon" type="image/svg+xml" href="{_ICON}">' if _ICON else ""

_APP = escape(B.APP_NAME)
_ORG = escape(B.ORG_NAME)

_HTML = f"""<!doctype html>
<html lang="en-GB"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="{B.FOREST}">
<title>Open {_APP}</title>
{_ICON_LINK}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="{B.GOOGLE_FONTS_HREF}" rel="stylesheet">
<style>
  :root {{
    --forest:{B.FOREST}; --deep:{B.DEEP}; --mid:{B.MID};
    --lime:{B.LIME}; --lime-dark:{B.LIME_DARK};
    --paper:{B.PAPER}; --rule:{B.RULE};
    --on-dark-muted:#b9c9b8;
    --display:{B.FONT_HEADING}; --body:{B.FONT_BODY};
    color-scheme:dark;
  }}
  * {{ box-sizing:border-box; -webkit-tap-highlight-color:transparent; }}
  body {{ margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    padding:28px 16px; font-family:var(--body); color:var(--paper);
    background:
      radial-gradient(900px 480px at 50% -8%, rgba(183,223,88,.10) 0%, transparent 60%),
      linear-gradient(180deg, var(--forest) 0%, var(--deep) 100%);
    background-color:var(--forest);
  }}
  .card {{ width:100%; max-width:410px; text-align:center; }}
  .logo {{ width:190px; max-width:70%; height:auto; margin:0 auto 22px; display:block; }}
  .kicker {{ font-size:11px; font-weight:700; letter-spacing:.2em;
    text-transform:uppercase; color:var(--lime); margin-bottom:8px; }}
  h1 {{ font-family:var(--display); font-weight:700; font-size:32px; letter-spacing:-.01em; margin:0 0 6px; color:var(--paper); }}
  .sub {{ color:var(--on-dark-muted); font-size:14px; margin:0 0 28px; }}
  .btn {{ display:flex; align-items:center; justify-content:center; gap:8px; width:100%;
    padding:16px; border-radius:14px; border:1px solid transparent; cursor:pointer;
    font-family:var(--body); font-size:16px; font-weight:700; text-decoration:none; margin-bottom:12px; }}
  .btn-primary {{ background:var(--lime); color:var(--forest); box-shadow:0 10px 30px rgba(0,0,0,.25); }}
  .btn-primary:hover {{ background:#c4e86d; }}
  .btn-primary:active {{ transform:translateY(1px); background:var(--lime-dark); }}
  .steps {{ text-align:left; background:var(--mid); border:1px solid rgba(206,219,199,.18); border-radius:16px;
    padding:16px 18px; margin-top:26px; }}
  .steps h2 {{ font-family:var(--display); font-size:16px; font-weight:600; margin:0 0 12px; color:var(--paper); }}
  .step {{ display:flex; gap:11px; align-items:flex-start; margin-bottom:11px; font-size:13px; color:var(--on-dark-muted); line-height:1.5; }}
  .step:last-child {{ margin-bottom:0; }}
  .num {{ flex:0 0 22px; height:22px; border-radius:50%; background:var(--lime); color:var(--forest);
    font-size:12px; font-weight:700; display:flex; align-items:center; justify-content:center; }}
  .foot {{ color:var(--on-dark-muted); font-size:11px; margin-top:22px; opacity:.85; }}
  b {{ color:var(--paper); }}
</style></head>
<body>
  <div class="card">
    <img class="logo" src="{LOGO_URL}" alt="{_ORG}">
    <div class="kicker">{_ORG}</div>
    <h1>{_APP}</h1>
    <p class="sub">Your coaching &amp; team app</p>

    <a class="btn btn-primary" href="{WEB_APP_URL}">Open {_APP} &nbsp;&rarr;</a>

    <div class="steps">
      <h2>Put {_APP} on your home screen</h2>
      <div class="step"><span class="num">1</span><div>Tap <b>Open {_APP}</b> above — it runs right in your browser, nothing to download.</div></div>
      <div class="step"><span class="num">2</span><div><b>iPhone:</b> in Safari, tap <b>Share</b> &rarr; <b>Add to Home Screen</b>.<br><b>Android:</b> in Chrome, tap <b>⋮</b> &rarr; <b>Add to Home screen</b>.</div></div>
      <div class="step"><span class="num">3</span><div>{_APP} gets its own icon and opens full-screen like any app — sign in with your {_ORG} login. It updates itself automatically.</div></div>
    </div>

    <p class="foot">{_APP} works on any phone or laptop — no app store, and updates arrive on their own.</p>
  </div>
</body></html>"""


@router.get("/launch", response_class=HTMLResponse)
@router.get("/go", response_class=HTMLResponse)
async def launch_page():
    return HTMLResponse(_HTML)


@router.get("/get-app")
async def get_android_app():
    """Retired Android APK link, kept as a permanent pointer to the /launch
    install page so any old link still lands somewhere useful."""
    from fastapi.responses import RedirectResponse
    return RedirectResponse("/launch", status_code=302)
