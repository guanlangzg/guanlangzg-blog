from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import expect, sync_playwright

from editor_auth import create_authenticated_context
from ui_smoke_helpers import assert_no_horizontal_overflow, get_base_url

BASE_URL = get_base_url()
SCREENSHOT_DIR = Path("output/playwright")


def open_command_input(page):
    search_input = page.locator('input[aria-label="搜索文章或链接"]')

    for _ in range(3):
        page.get_by_role("button", name="搜索文章和链接").first.wait_for(state="visible")
        page.get_by_role("button", name="搜索文章和链接").first.click()

        try:
            search_input.wait_for(state="visible", timeout=5000)
            return search_input
        except PlaywrightTimeoutError:
            page.keyboard.press("Control+K")

        try:
            search_input.wait_for(state="visible", timeout=5000)
            return search_input
        except PlaywrightTimeoutError:
            page.wait_for_timeout(1000)

    search_input.wait_for(state="visible")
    return search_input


def main() -> None:
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = create_authenticated_context(browser, BASE_URL, {"width": 1280, "height": 900}, "local-dev-only-secret")
        page = context.new_page()
        page.set_default_timeout(60000)
        console_errors: list[str] = []
        page_errors: list[str] = []

        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )
        page.on("pageerror", lambda error: page_errors.append(str(error)))

        page.goto(f"{BASE_URL}/editor/settings", wait_until="domcontentloaded", timeout=60000)
        settings_heading = page.get_by_role("heading", name="站点设置")

        try:
            expect(settings_heading).to_be_visible()
        except AssertionError:
            raise AssertionError(
                f"Settings page did not render. url={page.url} body={page.locator('body').inner_text(timeout=1000)[:500]}"
            )

        expect(page.get_by_label("站点名称")).to_be_visible()
        expect(page.get_by_label("首页描述")).to_be_visible()
        expect(page.locator("header").get_by_role("button", name="保存设置")).to_be_visible()
        expect(page.locator("#site-settings-form").get_by_role("button", name="保存设置")).to_be_visible()
        assert_no_horizontal_overflow(page)
        page.screenshot(path=str(SCREENSHOT_DIR / "editor-settings-desktop.png"), full_page=True)

        page.goto(f"{BASE_URL}/", wait_until="domcontentloaded", timeout=90000)
        search_input = open_command_input(page)
        search_input.fill(":admin")
        expect(page.get_by_text("站点设置")).to_be_visible()

        mobile_context = create_authenticated_context(browser, BASE_URL, {"width": 390, "height": 844}, "local-dev-only-secret")
        mobile_page = mobile_context.new_page()
        mobile_page.set_default_timeout(60000)
        mobile_page.goto(f"{BASE_URL}/editor/settings", wait_until="domcontentloaded")
        expect(mobile_page.get_by_role("heading", name="站点设置")).to_be_visible()
        expect(mobile_page.get_by_text("已启用运行时数据目录")).to_be_visible()
        assert_no_horizontal_overflow(mobile_page)

        site_save = mobile_page.locator("#site-settings-form").get_by_role("button", name="保存设置")
        site_save_box = site_save.bounding_box()
        assert site_save_box is not None and site_save_box["width"] > 280, "Site settings save button should span mobile form width"
        r2_save = mobile_page.get_by_role("button", name="保存 R2 配置")
        expect(r2_save).to_be_enabled()
        r2_save_box = r2_save.bounding_box()
        assert r2_save_box is not None and r2_save_box["width"] > 280, "R2 save button should span mobile form width"
        mobile_page.screenshot(path=str(SCREENSHOT_DIR / "editor-settings-mobile.png"), full_page=True)

        browser.close()

        relevant_console_errors = [
            error
            for error in console_errors
            if "Failed to fetch RSC payload" not in error
        ]

        if relevant_console_errors or page_errors:
            raise AssertionError(
                f"Browser errors found: console={relevant_console_errors}, page={page_errors}"
            )


if __name__ == "__main__":
    main()
