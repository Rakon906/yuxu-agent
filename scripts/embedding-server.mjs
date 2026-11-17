import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env as transformersEnv, pipeline } from '@huggingface/transformers';
import { createEmbeddingServer, LOCAL_EMBEDDING_DIMENSION, LOCAL_EMBEDDING_MODEL,
  LOCAL_EMBEDDING_PORT } from '../packages/embedding/index.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

const port = Number(process.env.SOCIOMEM_EMBEDDING_PORT ?? LOCAL_EMBEDDING_PORT);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('SOCIOMEM_EMBEDDING_PORT must be 1..65535');

transformersEnv.cacheDir = join(projectRoot, '.cache', 'hf-models');
const modelRoot = join(transformersEnv.cacheDir, ...LOCAL_EMBEDDING_MODEL.split('/'));
const cached = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']
  .every(name => existsSync(join(modelRoot, name)));
transformersEnv.allowRemoteModels = !cached;
console.log(cached ? 'Loading cached local embedding model...' : 'Downloading embedding model into project cache...');
const extractor = await pipeline('feature-extraction', LOCAL_EMBEDDING_MODEL, { dtype: 'q8' });
const embed = async text => {
  const result = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(result.data);
};
const check = await embed('SocioMem 本地向量服务');
if (check.length !== LOCAL_EMBEDDING_DIMENSION) throw new Error('Local embedding model dimension mismatch');

const server = createEmbeddingServer(embed);
server.on('error', error => { console.error(`embedding: ${error.message}`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`Local embedding service: http://127.0.0.1:${port} (${LOCAL_EMBEDDING_MODEL}, ${LOCAL_EMBEDDING_DIMENSION} dimensions)`);
});
