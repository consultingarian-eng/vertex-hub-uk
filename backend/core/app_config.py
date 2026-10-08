"""Deployment-level settings that more than one module needs."""
from __future__ import annotations

import os


def app_base_url(request=None) -> str:
    """Public base URL of this deployment, e.g. "https://app.example.org".

    APP_BASE_URL wins. Without it, fall back to the host the request came in
    on (honouring the proxy's X-Forwarded-* headers), else "" — callers then
    produce a same-origin relative link, which works for the web app because
    the backend serves it.
    """
    base = (os.environ.get("APP_BASE_URL") or "").strip().rstrip("/")
    if base or request is None:
        return base
    try:
        headers = request.headers
        host = (headers.get("x-forwarded-host") or headers.get("host") or "").split(",")[0].strip()
        proto = (headers.get("x-forwarded-proto") or request.url.scheme or "https").split(",")[0].strip()
        return f"{proto}://{host}".rstrip("/") if host else ""
    except Exception:
        return ""
