import unittest

import httpx

from lab.upstream import session_error_detail


class UpstreamErrorTests(unittest.TestCase):
    def test_preserves_actionable_error_and_request_id(self) -> None:
        response = httpx.Response(
            400,
            json={"error": {
                "code": "invalid_request_error",
                "message": "Unsupported parameter: session.example",
                "param": "session.example",
            }},
            headers={"apim-request-id": "request-123"},
        )
        detail = session_error_detail(response, "azure")
        self.assertIn("HTTP 400", detail)
        self.assertIn("code: invalid_request_error", detail)
        self.assertIn("param: session.example", detail)
        self.assertIn("Unsupported parameter: session.example", detail)
        self.assertIn("request_id: request-123", detail)

    def test_redacts_credentials_and_request_content_in_all_fields(self) -> None:
        response = httpx.Response(
            400,
            json={"error": {
                "message": "key secret-key and Bearer secret-token; offer private-sdp; prompt private-prompt",
                "param": "secret-key",
                "innererror": {"private": "never-forward-this"},
            }},
            headers={"x-request-id": "secret-key"},
        )
        detail = session_error_detail(
            response, "azure", sensitive_values=("secret-key", "secret-token", "private-sdp", "private-prompt")
        )
        for value in ("secret-key", "secret-token", "private-sdp", "private-prompt", "never-forward-this"):
            self.assertNotIn(value, detail)
        self.assertIn("[redacted]", detail)

    def test_malformed_or_unstructured_responses_do_not_leak_body(self) -> None:
        for body in (None, [], {"error": "private"}, {"error": {"message": {"private": "body"}}}):
            with self.subTest(body=body):
                detail = session_error_detail(httpx.Response(502, json=body), "azure")
                self.assertIn("did not provide a structured", detail)
                self.assertNotIn("private", detail)
        self.assertNotIn("private html", session_error_detail(httpx.Response(400, text="private html"), "azure"))

    def test_error_fields_are_bounded_and_newlines_normalized(self) -> None:
        detail = session_error_detail(
            httpx.Response(400, json={"error": {"message": "a\n" + "x" * 5000}}), "azure"
        )
        self.assertLess(len(detail), 1700)
        self.assertIn("message: a x", detail)


if __name__ == "__main__":
    unittest.main()
