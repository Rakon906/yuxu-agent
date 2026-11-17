process.env.SOCIOMEM_CAPTURE_ONLY = '1';
process.env.SOCIOMEM_MEMORY_ENABLED = '0';
process.env.SOCIOMEM_DIARY_ENABLED = '0';
await import('./watch-wechat.mjs');
