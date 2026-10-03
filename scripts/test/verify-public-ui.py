from base64 import b64encode
from hashlib import sha256
from html.parser import HTMLParser
from pathlib import Path
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import expect, sync_playwright

from public_cache_policy import find_shared_cache_policy
from ui_smoke_helpers import assert_min_touch_target, assert_no_horizontal_overflow, get_base_url


BASE_URL = get_base_url()
OUTPUT_DIR = Path("output/playwright")


class InlineScriptParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts = []
        self.current_script = None

    def handle_starttag(self, tag, attrs):
        if tag != "script":
            return
        attributes = dict(attrs)
        if "src" in attributes:
            return
        script_type = (attributes.get("type") or "").split(";")[0].strip().lower()
        if script_type and script_type not in {
            "module",
            "text/javascript",
            "application/javascript",
            "text/ecmascript",
            "application/ecmascript",
        }:
            return
        self.current_script = {
            "nonce": attributes.get("nonce"),
            "content": [],
        }
        self.scripts.append(self.current_script)

    def handle_data(self, data):
        if self.current_script is not None:
            self.current_script["content"].append(data)

    def handle_endtag(self, tag):
        if tag == "script":
            self.current_script = None


def assert_inline_scripts_allowed_by_csp(response, path):
    assert response is not None, f"No document response received for {path}"
    shared_cache_policy = find_shared_cache_policy(response.headers)
    assert shared_cache_policy is None, (
        f"Public HTML is shared-cacheable on {path}: {shared_cache_policy}"
    )
    assert response.headers.get("x-nextjs-prerender") != "1", f"Next.js prerendered {path}"
    assert response.headers.get("x-nextjs-cache") not in {"HIT", "STALE"}, f"Next.js served cached HTML on {path}"
    csp = response.headers.get("content-security-policy", "")
    directives = {
        parts[0]: parts[1:]
        for directive in csp.split(";")
        if (parts := directive.strip().split())
    }
    script_sources = directives.get("script-src-elem") or directives.get("script-src") or directives.get("default-src", [])
    parser = InlineScriptParser()
    parser.feed(response.text())

    for script in parser.scripts:
        content = "".join(script["content"])
        nonce_source = f"'nonce-{script['nonce']}'" if script["nonce"] else None
        script_hash = f"'sha256-{b64encode(sha256(content.encode('utf-8')).digest()).decode('ascii')}'"
        uses_nonce_or_hash = any(
            source.startswith(("'nonce-", "'sha256-", "'sha384-", "'sha512-"))
            for source in script_sources
        )
        allowed = nonce_source in script_sources if nonce_source else False
        allowed |= script_hash in script_sources
        allowed |= "'unsafe-inline'" in script_sources and not uses_nonce_or_hash
        assert allowed, f"CSP blocks an inline script on {path}"

    assert parser.scripts, f"No inline scripts found in document response for {path}"


def assert_mobile_public_touch_targets(page):
    assert_min_touch_target(page.get_by_label("搜索文章和链接"), "header search button")
    assert_min_touch_target(page.get_by_role("link", name="导航"), "header navigation link")
    assert_min_touch_target(page.get_by_role("link", name="博客"), "header blog link")


def verify_page(page, path, heading, console_errors, page_errors):
    target_url = f"{BASE_URL}{path}"

    document_response = None
    for attempt in range(2):
        try:
            with page.expect_response(
                lambda response: response.request.resource_type == "document"
                and response.url == target_url,
                timeout=90000,
            ) as response_info:
                page.goto(target_url, wait_until="domcontentloaded", timeout=90000)
            document_response = response_info.value
            break
        except PlaywrightTimeoutError:
            if attempt == 1:
                raise
            page.goto("about:blank", timeout=10000)

    assert_inline_scripts_allowed_by_csp(document_response, path)

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

            verify_page(page, "/", "记录值得回看的内容，整理实用的知识与导航", console_errors, page_errors)
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
