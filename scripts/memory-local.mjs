import { configureLocalMemory } from './local-memory-env.mjs';

configureLocalMemory();
await import('./memory.mjs');
