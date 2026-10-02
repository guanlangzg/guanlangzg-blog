import os
from typing import Any


DEFAULT_BASE_URL = "http://127.0.0.1:3210"


def get_base_url() -> str:
    return os.environ.get("BASE_URL") or os.environ.get("TEST_BASE_URL") or DEFAULT_BASE_URL


def assert_no_horizontal_overflow(page: Any) -> None:
    overflow = page.evaluate(
        "() => document.documentElement.scrollWidth - window.innerWidth"
    )
    assert overflow <= 1, f"Page has horizontal overflow: {overflow}px"


def assert_min_touch_target(locator: Any, label: str) -> None:
    for index in range(locator.count()):
        box = locator.nth(index).bounding_box()
        if box is not None:
            assert box["width"] >= 44 and box["height"] >= 44, (
                f"{label} touch target is too small: {box['width']}x{box['height']}"
            )
            return

    raise AssertionError(f"{label} is not visible")
