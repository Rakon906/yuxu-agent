---
"@agent-wechat/cli": patch
---

Allow the Moments post route through the explicit diagnostic write path on an
existing native session. Read-only requests still reject publishing. This adds
transport support only; callers must validate request bodies, persist intent,
and verify receipts before claiming a published post. Live publication has not
been validated by this change.
