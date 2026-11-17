import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_EMBEDDING_DIMENSION, LOCAL_EMBEDDING_MODEL, LOCAL_EMBEDDING_PORT } from '../packages/embedding/index.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export function configureLocalMemory({ enableHarness = false } = {}) {
  const port = Number(process.env.SOCIOMEM_EMBEDDING_PORT ?? LOCAL_EMBEDDING_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('SOCIOMEM_EMBEDDING_PORT must be 1..65535');
  process.env.SOCIOMEM_EMBEDDING_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.SOCIOMEM_EMBEDDING_MODEL = LOCAL_EMBEDDING_MODEL;
  process.env.SOCIOMEM_EMBEDDING_DIMENSION = String(LOCAL_EMBEDDING_DIMENSION);
  delete process.env.SOCIOMEM_EMBEDDING_API_KEY;
  process.env.SOCIOMEM_MEMORY_ROOT ??= join(projectRoot, '.runtime', 'memory');
  if (enableHarness) process.env.SOCIOMEM_MEMORY_ENABLED = '1';
}
