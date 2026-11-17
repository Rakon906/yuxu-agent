---
"@agent-wechat/cli": patch
---

Add an admin-only Moments image upload route for an already authenticated
account. It accepts one staged JPEG up to1MiB, verifies its SHA256 and dimensions,
and returns server image and thumbnail URLs only after a complete upload receipt.
The route does not publish a timeline post or retry an uncertain upload. Callers
must persist intent and reconcile publication separately.
