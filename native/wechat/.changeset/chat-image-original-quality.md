---
"@agent-wechat/cli": patch
---

Preserve validated JPEG chat originals up to 8 MiB and 4096 pixels per edge.
Upload originals in correlated CDN chunks, with a separate preview up to
512 KiB and a thumbnail up to 65,520 bytes. These are implementation bounds,
not a statement of the service's maximum supported image size.
