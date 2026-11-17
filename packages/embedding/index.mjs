import { createServer } from 'node:http';

export const LOCAL_EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
export const LOCAL_EMBEDDING_DIMENSION = 384;
export const LOCAL_EMBEDDING_PORT = 11435;

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};

export function createEmbeddingServer(embed) {
  if (typeof embed !== 'function') throw new TypeError('embed must be a function');
  let queue = Promise.resolve();
  return createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      json(response, 200, { status: 'ok', model: LOCAL_EMBEDDING_MODEL, dimensions: LOCAL_EMBEDDING_DIMENSION });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/embeddings') {
      json(response, 404, { error: { message: 'Not found' } });
      return;
    }
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 65536) {
          json(response, 413, { error: { message: 'Embedding request is too large' } });
          return;
        }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const inputs = typeof body.input === 'string' ? [body.input] : body.input;
      if (body.model !== LOCAL_EMBEDDING_MODEL) throw new Error('Unsupported embedding model');
      if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 16 ||
          inputs.some(value => typeof value !== 'string' || !value.trim() || value.length > 8192)) {
        throw new Error('input must contain 1 to 16 nonempty strings of at most 8192 characters');
      }
      const task = async () => {
        const data = [];
        for (const [index, input] of inputs.entries()) {
          const embedding = await embed(input);
          if (!Array.isArray(embedding) || embedding.length !== LOCAL_EMBEDDING_DIMENSION ||
              !embedding.every(Number.isFinite)) throw new Error('Embedding model returned invalid dimensions');
          data.push({ object: 'embedding', index, embedding });
        }
        return data;
      };
      const pending = queue.then(task);
      queue = pending.then(() => {}, () => {});
      const data = await pending;
      json(response, 200, { object: 'list', data, model: LOCAL_EMBEDDING_MODEL,
        usage: { prompt_tokens: 0, total_tokens: 0 } });
    } catch (error) {
      json(response, error instanceof SyntaxError ? 400 : 422, { error: { message: error.message } });
    }
  });
}
