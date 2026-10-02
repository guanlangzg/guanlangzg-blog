from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import expect, sync_playwright

from ui_smoke_helpers import assert_min_touch_target, assert_no_horizontal_overflow, get_base_url

BASE_URL = get_base_url()
SCREENSHOT_DIR = Path("output/playwright")
DEBUG_HTML_PATH = Path("output/editor-login-ui-debug.html")


def goto_editor_login(page) -> None:
    target_url = f"{BASE_URL}/editor/login"

    for attempt in range(2):
        try:
            page.goto(target_url, wait_until="domcontentloaded", timeout=90000)
            return
        except PlaywrightTimeoutError:
            if attempt == 1:
                raise
            page.goto("about:blank", timeout=10000)


def verify_page(browser, viewport, screenshot_name: str) -> None:
    context = browser.new_context(viewport=viewport)
    context.clear_cookies()
    page = context.new_page()
    page.set_default_timeout(90000)
    goto_editor_login(page)

    try:
        expect(page.get_by_role("heading", name="编辑区登录")).to_be_visible()
    except AssertionError:
        DEBUG_HTML_PATH.write_text(page.content(), encoding="utf-8")
        page.screenshot(path=SCREENSHOT_DIR / f"{screenshot_name}-failure.png", full_page=True)
        raise AssertionError(f"Editor login page did not render. Current URL: {page.url}")

    expect(page.get_by_label("编辑口令")).to_be_visible()
    expect(page.get_by_role("button", name="进入编辑区")).to_be_visible()
    expect(page.get_by_role("link", name="登录后进入运行时配置")).to_be_visible()
    expect(page.get_by_role("link", name="返回首页")).to_be_visible()
    assert_no_horizontal_overflow(page)

    if viewport["width"] < 640:
        assert_min_touch_target(
            page.get_by_label("编辑口令").first,
            "mobile editor login secret input",
        )
        assert_min_touch_target(
            page.get_by_role("button", name="进入编辑区").first,
            "mobile editor login submit action",
        )
        assert_min_touch_target(
            page.get_by_role("link", name="登录后进入运行时配置").first,
            "mobile runtime config link",
        )
        assert_min_touch_target(
            page.get_by_role("link", name="返回首页").first,
            "mobile editor login home link",
        )

    page.screenshot(path=str(SCREENSHOT_DIR / screenshot_name), full_page=True)
    context.close()


def main() -> None:
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        verify_page(browser, {"width": 1280, "height": 900}, "editor-login-desktop.png")
        verify_page(browser, {"width": 390, "height": 844}, "editor-login-mobile.png")
        browser.close()


if __name__ == "__main__":
    main()
