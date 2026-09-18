---
name: api-contracts
description: Inspect and preserve observable HTTP contracts when changing request handling, validation, responses, or service behavior.
---

Read the issue and current route/service implementation. Identify the expected successful response and relevant failure responses. Preserve documented status codes, response shapes, and existing caller-visible behavior unless the issue explicitly changes them.

Prefer behavioral checks over assertions about internal helpers. Consider boundaries and malformed input without adding unrelated requirements. Reuse existing local abstractions and avoid dependency changes unless explicitly authorized.
