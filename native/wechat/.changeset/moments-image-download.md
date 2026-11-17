---
"@agent-wechat/cli": patch
---

Add a read-only Moments image endpoint for the current authenticated account.
The endpoint accepts a timeline ID and media ID, retrieves their current server
descriptor, and downloads and decodes the photo over HTTPS without an official
client. It reports the downloaded variant's hashes separately from advertised
XML metadata. Account authorization, response limits and image decoding checks
apply before image bytes are returned; the endpoint performs no social action.
