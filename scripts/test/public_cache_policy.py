import re
from collections.abc import Mapping


CACHE_POLICY_HEADERS = (
    "cache-control",
    "cdn-cache-control",
    "surrogate-control",
)
CACHE_DIRECTIVE_PATTERN = re.compile(
    r"(?:^|,)\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)(\s*=\s*(?:\"[^\"]*\"|[^,]*))?"
)
SHARED_CACHE_DIRECTIVES = {"max-age", "s-maxage"}


def parse_cache_directives(value: str) -> list[tuple[str, bool]]:
    return [
        (match.group(1).lower(), match.group(2) is not None)
        for match in CACHE_DIRECTIVE_PATTERN.finditer(value)
    ]


def find_shared_cache_policy(headers: Mapping[str, str]) -> str | None:
    for header_name, value in headers.items():
        normalized_name = header_name.lower()
        if normalized_name not in CACHE_POLICY_HEADERS:
            continue

        directives = parse_cache_directives(value)
        names = {name for name, _ in directives}
        explicitly_private = any(
            name in {"private", "no-store"} and not has_value
            for name, has_value in directives
        )
        if "public" in names or (names & SHARED_CACHE_DIRECTIVES and not explicitly_private):
            return f"{normalized_name}: {value}"

    return None
