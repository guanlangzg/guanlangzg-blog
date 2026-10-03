import unittest

from public_cache_policy import find_shared_cache_policy


class SharedCachePolicyTests(unittest.TestCase):
    def test_rejects_public_cache_control_max_age(self):
        issue = find_shared_cache_policy({"Cache-Control": "public, max-age=600"})

        self.assertEqual(issue, "cache-control: public, max-age=600")

    def test_rejects_shared_cache_max_age_without_public(self):
        issue = find_shared_cache_policy({"Cache-Control": "max-age=600"})

        self.assertEqual(issue, "cache-control: max-age=600")

    def test_rejects_shared_cache_specific_max_age(self):
        issue = find_shared_cache_policy({"Cache-Control": "s-maxage=600"})

        self.assertEqual(issue, "cache-control: s-maxage=600")

    def test_rejects_cdn_cache_control_max_age(self):
        issue = find_shared_cache_policy({"CDN-Cache-Control": "max-age=600"})

        self.assertEqual(issue, "cdn-cache-control: max-age=600")

    def test_rejects_surrogate_control_max_age(self):
        issue = find_shared_cache_policy({"Surrogate-Control": "max-age=600"})

        self.assertEqual(issue, "surrogate-control: max-age=600")

    def test_allows_private_response_with_max_age(self):
        issue = find_shared_cache_policy({"Cache-Control": "private, max-age=600"})

        self.assertIsNone(issue)

    def test_allows_no_store_response(self):
        issue = find_shared_cache_policy({"Cache-Control": "no-store, max-age=600"})

        self.assertIsNone(issue)

    def test_rejects_conflicting_public_and_private_directives(self):
        issue = find_shared_cache_policy({"Cache-Control": "private, public"})

        self.assertEqual(issue, "cache-control: private, public")

    def test_rejects_field_scoped_private_with_max_age(self):
        issue = find_shared_cache_policy({"Cache-Control": 'private="set-cookie", max-age=600'})

        self.assertEqual(issue, 'cache-control: private="set-cookie", max-age=600')

    def test_checks_cdn_policy_even_when_cache_control_is_no_store(self):
        issue = find_shared_cache_policy({
            "Cache-Control": "no-store",
            "CDN-Cache-Control": "max-age=600",
        })

        self.assertEqual(issue, "cdn-cache-control: max-age=600")

    def test_ignores_non_cacheable_directives_and_unrelated_headers(self):
        issue = find_shared_cache_policy({
            "Cache-Control": "no-cache, must-revalidate",
            "Content-Type": "text/html",
        })

        self.assertIsNone(issue)


if __name__ == "__main__":
    unittest.main()
