from pathlib import Path
import os

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import expect, sync_playwright

from ui_smoke_helpers import assert_min_touch_target, assert_no_horizontal_overflow, get_base_url


BASE_URL = get_base_url()
OUTPUT_DIR = Path("output/playwright")


def assert_mobile_public_touch_targets(page):
    assert_min_touch_target(page.get_by_label("搜索文章和链接"), "header search button")
    assert_min_touch_target(page.get_by_role("link", name="导航"), "header navigation link")
    assert_min_touch_target(page.get_by_role("link", name="博客"), "header blog link")


def verify_page(page, path, heading, console_errors, page_errors):
    target_url = f"{BASE_URL}{path}"

    for attempt in range(2):
        try:
            page.goto(target_url, wait_until="domcontentloaded", timeout=90000)
            break
        except PlaywrightTimeoutError:
            if attempt == 1:
                raise
            page.goto("about:blank", timeout=10000)

    try:
        expect(page.locator("h1").filter(has_text=heading).first).to_be_visible()
    except AssertionError:
        print(f"Failed route: {path}")
        print(f"Current URL: {page.url}")
        print("Console errors:")
        print("\n".join(console_errors[-5:]))
        print("Page errors:")
        print("\n".join(page_errors[-5:]))
        print(page.locator("body").inner_text()[:1000])
        page.screenshot(path=OUTPUT_DIR / f"failure-{path.strip('/') or 'home'}.png", full_page=True)
        raise
    assert_no_horizontal_overflow(page)


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    console_errors = []
    page_errors = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)

        for name, viewport in {
            "desktop": {"width": 1440, "height": 1000},
            "mobile": {"width": 390, "height": 844},
        }.items():
            is_mobile = name == "mobile"
            page = browser.new_page(viewport=viewport)
            page.on(
                "console",
                lambda message: console_errors.append(message.text)
                if message.type == "error"
                else None,
            )
            page.on("pageerror", lambda error: page_errors.append(str(error)))

            verify_page(page, "/", "把解决过的问题，整理成下次还能用的笔记", console_errors, page_errors)
            if is_mobile:
                assert_mobile_public_touch_targets(page)
            page.screenshot(path=OUTPUT_DIR / f"home-{name}.png", full_page=True)

            verify_page(page, "/blog", "文章归档", console_errors, page_errors)
            if is_mobile:
                assert_mobile_public_touch_targets(page)
                assert_min_touch_target(page.get_by_role("link", name="全部类型").first, "blog all kind filter")
                if page.get_by_role("link", name="全部分类").count():
                    assert_min_touch_target(page.get_by_role("link", name="全部分类").first, "blog all category filter")
            page.screenshot(path=OUTPUT_DIR / f"blog-{name}.png", full_page=True)

            verify_page(
                page,
                "/posts/2026-05-25-getting-started",
                "从这里开始读这本公开笔记",
                console_errors,
                page_errors,
            )
            if is_mobile:
                assert_mobile_public_touch_targets(page)
                assert_min_touch_target(page.get_by_role("link", name="返回归档").first, "post back link")
                if page.get_by_role("navigation").filter(has_text="目录").count():
                    assert_min_touch_target(
                        page.get_by_role("navigation").filter(has_text="目录").first.locator("a").first,
                        "post table of contents link",
                    )
                if page.get_by_role("heading", name="相关内容").count():
                    assert_min_touch_target(
                        page.get_by_role("link").filter(has_text="从这里开始读这本公开笔记").first,
                        "related post link",
                    )
            page.screenshot(path=OUTPUT_DIR / f"post-{name}.png", full_page=True)

            verify_page(page, "/navigation", "常用链接导航", console_errors, page_errors)
            if is_mobile:
                assert_mobile_public_touch_targets(page)
                assert_min_touch_target(page.get_by_role("button", name="全部").first, "navigation all filter")
            page.get_by_label("搜索导航链接").fill("MDN")
            if is_mobile:
                assert_min_touch_target(page.get_by_label("清空搜索").first, "navigation clear search button")
            expect(page.get_by_text("MDN Web Docs").first).to_be_visible()
            assert_no_horizontal_overflow(page)
            page.screenshot(path=OUTPUT_DIR / f"navigation-search-{name}.png", full_page=True)
            page.close()

        browser.close()

    assert not console_errors, "\n".join(console_errors)
    assert not page_errors, "\n".join(page_errors)


if __name__ == "__main__":
    main()
