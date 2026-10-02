import os


def get_editor_login_secret(default_secret: str) -> str:
    return (
        os.environ.get("EDITOR_LOGIN_SECRET")
        or os.environ.get("EDITOR_ACCESS_TOKEN")
        or default_secret
    )


def create_authenticated_context(browser, base_url: str, viewport, default_secret: str):
    context = browser.new_context(viewport=viewport)
    status_response = context.request.get(
        f"{base_url.rstrip('/')}/api/editor-auth",
        timeout=90000,
    )

    if status_response.status != 200:
        body = status_response.text()
        context.close()
        raise AssertionError(
            f"Editor auth status failed: status={status_response.status} body={body[:500]}"
        )

    response = context.request.post(
        f"{base_url.rstrip('/')}/api/editor-auth",
        headers={"Content-Type": "application/json"},
        data={"secret": get_editor_login_secret(default_secret)},
        timeout=90000,
    )

    if response.status != 200:
        body = response.text()
        context.close()
        raise AssertionError(
            f"Editor login failed: status={response.status} body={body[:500]}"
        )

    return context
