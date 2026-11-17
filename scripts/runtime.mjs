import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

function assertMode(modelMode) {
  if (modelMode !== 'test' && modelMode !== 'deepseek') throw new Error(`Unknown Harness model mode: ${modelMode}`);
}

export async function prepareRun(label = 'phase1', { modelMode = 'test', reasoningEffort = 'high' } = {}) {
  assertMode(modelMode);
  const parent = join(projectRoot, '.runtime', 'runs');
  await mkdir(parent, { recursive: true });
  const runRoot = await mkdtemp(join(parent, `${label}-`));
  const overlay = join(runRoot, 'plugins.yml');
  const pluginPath = fileURLToPath(new URL('../packages/harness-plugin/index.mjs', import.meta.url));
  const fixturePath = fileURLToPath(new URL('../tests/fixtures/model-plugin.mjs', import.meta.url));
  const modelPlugin = modelMode === 'deepseek'
    ? `    - id: llm-deepseek\n      name: '@deepseek-ai/dsh-llm-deepseek-api-key'\n      config:\n        apiKeyEnv: DEEPSEEK_API_KEY\n        reasoningEffort: ${reasoningEffort}\n`
    : `    - id: sociomem-test-model\n      name: ${JSON.stringify(fixturePath)}\n`;
  await writeFile(overlay, `- insert:\n    - id: sociomem\n      name: ${JSON.stringify(pluginPath)}\n${modelPlugin}`);
  return { runRoot, overlay, modelMode };
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('Harness maxTokens must be a positive integer');
  return parsed;
}

export function createRuntime(run, { groupId = 'demo-group', accountId, modelMode = run.modelMode ?? 'test', model, maxTokens, memoryEnabled = false, wechatDbPath } = {}) {
  assertMode(modelMode);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/API_KEY|TOKEN|SECRET|PASSWORD/i.test(key)) delete env[key];
  }
  env.SOCIOMEM_MEMORY_ENABLED = '0';
  delete env.SOCIOMEM_ACCOUNT_ID;
  const selectedModel = modelMode === 'deepseek' ? (model ?? process.env.SOCIOMEM_DEEPSEEK_MODEL ?? 'deepseek-v4-flash') : 'scripted-v1';
  const selectedMaxTokens = positiveInteger(maxTokens ?? (modelMode === 'deepseek' ? process.env.SOCIOMEM_DEEPSEEK_MAX_TOKENS : undefined), modelMode === 'deepseek' ? 1024 : 512);
  if (modelMode === 'deepseek') {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) throw new Error('DEEPSEEK_API_KEY is required for deepseek Harness mode');
    env.DEEPSEEK_API_KEY = key;
  }
  if (memoryEnabled) {
    if (!accountId) throw new Error('Memory tool requires a host-bound accountId');
    env.SOCIOMEM_MEMORY_ROOT = process.env.SOCIOMEM_MEMORY_ROOT ?? join(projectRoot, '.runtime', 'memory');
    for (const key of ['SOCIOMEM_MEMORY_ROOT', 'SOCIOMEM_EMBEDDING_BASE_URL', 'SOCIOMEM_EMBEDDING_MODEL', 'SOCIOMEM_EMBEDDING_DIMENSION', 'SOCIOMEM_EMBEDDING_API_KEY']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    env.SOCIOMEM_MEMORY_ENABLED = '1';
    env.SOCIOMEM_ACCOUNT_ID = accountId;
    env.SOCIOMEM_WECHAT_DB = wechatDbPath ?? join(projectRoot, '.runtime', 'wechat-adapter', 'sociomem.sqlite');
  }
  return new DeepSeekHarness({
    profile: 'sdk-minimal',
    dshHome: join(run.runRoot, 'harness'),
    patches: [run.overlay],
    processCwd: projectRoot,
    cwd: projectRoot,
    provider: modelMode === 'deepseek' ? 'deepseek-official' : 'sociomem-test', model: selectedModel, maxTokens: selectedMaxTokens,
    initializeTimeoutMs: 60000, requestTimeoutMs: 30000,
    env: { ...env, SOCIOMEM_RUN_ROOT: run.runRoot, SOCIOMEM_GROUP_ID: groupId,
      npm_config_cache: join(projectRoot, '.cache', 'npm'),
      PNPM_HOME: join(projectRoot, '.tools', 'pnpm'),
      PNPM_STORE_DIR: join(projectRoot, '.cache', 'pnpm-store'),
      COREPACK_HOME: join(projectRoot, '.cache', 'corepack'),
      TEMP: join(projectRoot, 'work', 'tmp'), TMP: join(projectRoot, 'work', 'tmp'),
    },
  });
}
