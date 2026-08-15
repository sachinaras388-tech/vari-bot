import httpx

_shared_client: httpx.AsyncClient | None = None


def get_shared_http_client() -> httpx.AsyncClient:
    """Return a singleton AsyncClient with keep-alive and pooled connections."""
    global _shared_client
    if _shared_client is None:
        try:
            _shared_client = httpx.AsyncClient(
                http2=True,
                follow_redirects=True,
                timeout=httpx.Timeout(10.0, connect=2.0, read=10.0, write=5.0),
                limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
            )
        except RuntimeError:
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
