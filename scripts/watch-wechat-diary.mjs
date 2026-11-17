import { configureLocalMemory } from './local-memory-env.mjs';

configureLocalMemory({ enableHarness: true });
process.env.SOCIOMEM_DIARY_ENABLED = '1';
await import('./watch-wechat.mjs');
