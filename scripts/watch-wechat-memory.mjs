import { configureLocalMemory } from './local-memory-env.mjs';

configureLocalMemory({ enableHarness: true });
await import('./watch-wechat.mjs');
