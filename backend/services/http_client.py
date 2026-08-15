import importlib.util
import logging
import httpx

logger = logging.getLogger(__name__)

_shared_client: httpx.AsyncClient | None = None


def _detect_http2_support() -> bool:
    """Return True if the optional 'h2' package is importable in this environment."""
    return importlib.util.find_spec("h2") is not None


def get_shared_http_client() -> httpx.AsyncClient:
    """Return a singleton AsyncClient with keep-alive and pooled connections.

    This will enable HTTP/2 only when the 'h2' dependency is available. If
    HTTP/2 is requested but not usable, fall back to a plain HTTP/1.1 client.
    """
    global _shared_client
    if _shared_client is None:
        http2_enabled = _detect_http2_support()
        if not http2_enabled:
            logger.info("http2 support unavailable; creating httpx AsyncClient without http2")

        try:
            _shared_client = httpx.AsyncClient(
                http2=http2_enabled,
                follow_redirects=True,
                timeout=httpx.Timeout(10.0, connect=2.0, read=10.0, write=5.0),
                limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
            )
        except Exception as exc:  # pragma: no cover - defensive fallback
            logger.warning("failed to create httpx AsyncClient with http2=%s: %s", http2_enabled, exc)
            _shared_client = httpx.AsyncClient(
                follow_redirects=True,
                timeout=httpx.Timeout(10.0, connect=2.0, read=10.0, write=5.0),
                limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
            )

    return _shared_client


async def close_shared_http_client() -> None:
    global _shared_client
    if _shared_client is not None:
        await _shared_client.aclose()
        _shared_client = None
