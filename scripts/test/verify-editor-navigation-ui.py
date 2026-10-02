from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import expect, sync_playwright

from editor_auth import create_authenticated_context
from ui_smoke_helpers import assert_min_touch_target, assert_no_horizontal_overflow, get_base_url

BASE_URL = get_base_url()
OUTPUT_DIR = Path("output/playwright")
DEBUG_HTML_PATH = Path("output/editor-navigation-ui-debug.html")


def goto_editor_navigation(page) -> None:
    target_url = f"{BASE_URL}/editor/navigation"

    for attempt in range(2):
        try:
            page.goto(target_url, wait_until="domcontentloaded", timeout=90000)
            return
        except PlaywrightTimeoutError:
            if attempt == 1:
                raise
            page.goto("about:blank", timeout=10000)


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)

        for name, viewport in {
            "desktop": {"width": 1440, "height": 960},
            "mobile": {"width": 390, "height": 844},
        }.items():
            context = create_authenticated_context(browser, BASE_URL, viewport, "local-dev-only-secret")
            page = context.new_page()
            page.set_default_timeout(90000)
            goto_editor_navigation(page)

            try:
                expect(page.get_by_role("heading", name="导航编辑器")).to_be_visible()
            except AssertionError:
                DEBUG_HTML_PATH.write_text(page.content(), encoding="utf-8")
                page.screenshot(path=OUTPUT_DIR / f"editor-navigation-{name}-failure.png", full_page=True)
                raise AssertionError(f"Navigation editor page did not render. Current URL: {page.url}")
            expect(page.get_by_role("button", name="添加分类")).to_be_visible()
            page.get_by_role("button", name="添加工具").first.click()
            expect(page.get_by_text("工具名称").first).to_be_visible()
            expect(page.get_by_text("URL").first).to_be_visible()
            expect(page.get_by_text("描述").first).to_be_visible()
            expect(page.get_by_text("标签").first).to_be_visible()
            assert_no_horizontal_overflow(page)

            if name == "mobile":
                assert_min_touch_target(
                    page.get_by_role("link", name="返回").first,
                    "mobile topbar back action",
                )
                assert_min_touch_target(
                    page.locator('label[aria-label="导入导航数据"]').first,
                    "mobile import action",
                )
                assert_min_touch_target(
                    page.get_by_role("button", name="添加工具").first,
                    "mobile add tool action",
                )
                assert_min_touch_target(
                    page.get_by_role("button", name="确认添加").first,
                    "mobile confirm add tool action",
                )
                assert_min_touch_target(
                    page.get_by_role("button", name="取消").first,
                    "mobile cancel add tool action",
                )
                assert_min_touch_target(
                    page.get_by_role("button", name="编辑分类：常用入口").first,
                    "mobile category edit action",
                )
                assert_min_touch_target(
                    page.get_by_role("link", name="打开工具：GitHub").first,
                    "mobile tool open action",
                )
                assert_min_touch_target(
                    page.get_by_role("button", name="编辑工具：GitHub").first,
                    "mobile tool edit action",
                )
                page.get_by_role("button", name="编辑工具：GitHub").first.click()
                assert_min_touch_target(
                    page.get_by_role("button", name="保存").first,
                    "mobile save tool action",
                )
                assert_min_touch_target(
                    page.get_by_role("button", name="取消").first,
                    "mobile cancel tool edit action",
                )

            page.screenshot(path=OUTPUT_DIR / f"editor-navigation-{name}.png", full_page=True)
            context.close()

        browser.close()


if __name__ == "__main__":
    main()
