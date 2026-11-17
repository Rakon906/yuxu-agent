import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { anthropicKey } from '../model/anthropic.mjs';
import { appendImageUsage, recordImageUsage } from '../telemetry/image-usage.mjs';
import { projectRoot } from '../../scripts/runtime.mjs';

export const SELFIE_APPEARANCE = 'an ordinary young adult woman in her early twenties with realistic East ' +
  'Asian features, not a model, a soft oval face, dark brown eyes with natural double eyelids and no ' +
  'heavy eye makeup, straight thin eyebrows, a small nose, natural pink lips, fair skin with natural ' +
  'texture, visible pores, slight unevenness and a light blush, a small mole under her right eye and a ' +
  'tiny mole beside the left corner of her mouth, long wavy black hair with bangs, wearing a pure white ' +
  'oversized shark hoodie with light-blue accents (white and light blue palette), shark eyes and fins on ' +
  'the hood, a tiny fish zipper charm, a fish hairpin and a small pearl earring, a white pleated skirt, ' +
  'black socks and light-blue sneakers';

const MAX_BYTES = 12 * 1024 * 1024;
// Match the bounded original-image upload profile. Preview/thumbnail budgets
// belong to the sender and must never be used to shrink this original.
export const WECHAT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const WECHAT_IMAGE_MAX_EDGE = 4096;

export async function prepareWechatImage(png) {
  if (!Buffer.isBuffer(png) || !png.length) throw new Error('Generated image is empty');
  const source = sharp(png, { limitInputPixels: WECHAT_IMAGE_MAX_EDGE ** 2 });
  const meta = await source.metadata();
  if (meta.format === 'jpeg' && png.length <= WECHAT_IMAGE_MAX_BYTES &&
      meta.width <= WECHAT_IMAGE_MAX_EDGE && meta.height <= WECHAT_IMAGE_MAX_EDGE) return png;
  const bytes = await source
    .resize({ width: WECHAT_IMAGE_MAX_EDGE, height: WECHAT_IMAGE_MAX_EDGE,
      fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
  if (bytes.length > WECHAT_IMAGE_MAX_BYTES) throw new Error('Generated original exceeds the image upload budget');
  return bytes;
}
const blocked = /(?:裸|色情|性爱|强奸|血腥|尸体|自杀|枪|毒品|nude|naked|nsfw|porn|gore|blood|weapon)/iu;

const cleanPrompt = (value, max) => String(value ?? '')
  .replace(/[\u0000-\u001f]/gu, ' ').trim().slice(0, max);

export function buildSelfiePrompt(scene) {
  const clean = cleanPrompt(scene, 200);
  if (!clean) throw new Error('Selfie scene is required');
  if (blocked.test(clean)) throw new Error('Selfie scene is not allowed');
  return `Use the reference images only for facial identity, body proportions and outfit design. ` +
    'They are character references, not style references: do not copy their anime, cartoon, ' +
    'illustration or 3D-render style, pose, hand position, camera angle, expression, close-up ' +
    `framing or background. Render a candid photorealistic smartphone selfie of ${SELFIE_APPEARANCE}. ` +
    `Adapt her naturally to this scene: ${clean}. ` +
    'Even if the scene text mentions anime, cartoon, comic or illustration, treat those words as ' +
    'subject matter only and still output a real photograph. ' +
    'Real camera optics, ordinary everyday appearance, minimal makeup, natural skin texture with ' +
    'visible pores, subtle skin imperfections and natural facial asymmetry, natural eye size and ' +
    'facial proportions, no beauty filter, no social-media filter, no airbrushing, no heavy makeup, ' +
    'no professional retouching, realistic indoor room lighting, accurate adult anatomy and ' +
    'proportions, normal head-to-body ratio (not chibi, not an oversized head, not a tiny body), ' +
    'face centered and clearly visible, natural expression, avoid extreme head tilt, wide-angle face ' +
    'distortion or asymmetrical eyes. ' +
    'No anime, no cartoon, no illustration, no painting, no 3D render, no plastic skin, ' +
    'no oversized eyes, no text, no watermark.';
}

export function buildPicturePrompt(prompt) {
  const clean = cleanPrompt(prompt, 300);
  if (!clean) throw new Error('Picture prompt is required');
  if (blocked.test(clean)) throw new Error('Picture prompt is not allowed');
  return `${clean}. Render a photorealistic photograph with natural lighting, realistic detail and ` +
    'textures and a real photographic look. Even if the request mentions anime, cartoon, comic or ' +
    'illustration, treat those words as subject matter only and output a real photograph. ' +
    'No anime, no cartoon, no illustration, no painting, no 3D render, no text, no watermark';
}

export function selfieDir() {
  return join(projectRoot, '.runtime', 'selfies');
}

export function pictureDir() {
  return join(projectRoot, '.runtime', 'pictures');
}

export function defaultReferencePath() {
  return process.env.SOCIOMEM_SELFIE_REFERENCE ??
    join(projectRoot, '.runtime', 'images', 'agent-avatar.webp');
}

export function defaultBodyReferencePath() {
  return process.env.SOCIOMEM_SELFIE_BODY_REFERENCE ??
    join(projectRoot, '.runtime', 'images', 'agent-avatar-full.webp');
}

async function referenceData(referencePath) {
  if (!existsSync(referencePath)) throw new Error('Selfie reference image is missing');
  const png = await sharp(readFileSync(referencePath))
    .resize({ width: 1024, height: 1024, fit: 'inside' }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

export function defaultImageModels() {
  return (process.env.SOCIOMEM_IMAGE_MODELS ??
    (process.env.SOCIOMEM_IMAGE_MODEL ?? 'gpt-6-luna'))
    .split(',').map(value => value.trim()).filter(Boolean);
}

async function generateFromPrompt({ prompt, referencePaths = [], outputDir,
  apiKey = anthropicKey(), timeoutMs = 240000, fetchImpl = fetch,
  models = defaultImageModels(), component = 'image_generation', onUsage = appendImageUsage } = {}) {
  if (!apiKey) throw new Error('Image generation requires an OpenCode Go API key');
  const endpoint = process.env.SOCIOMEM_IMAGE_ENDPOINT ??
    'https://opencode.ai/inference/go/openai/v1/responses';
  const references = [];
  for (const path of referencePaths.filter(Boolean)) references.push(await referenceData(path));
  const content = [{ type: 'input_text', text: prompt },
    ...references.map(reference => ({ type: 'input_image', image_url: reference }))];
  let generated = null;
  let usedModel = null;
  let lastError = null;
  const operationId = randomUUID();
  const service = new URL(endpoint).hostname === 'opencode.ai' ? 'opencode' : 'openai-compatible';
  for (const [index, model] of models.entries()) {
    const started = performance.now(), at = new Date().toISOString(), requestId = randomUUID();
    let response, payload, errorName = null;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`,
          'x-opencode-session': 'sociomem-image' },
        body: JSON.stringify({ model,
          input: [{ role: 'user', content }],
          tools: [{ type: 'image_generation', size: '1024x1536', quality: 'high' }] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Error responses may also provide usage; never log the body, prompt or credentials.
      try { payload = await response.json(); } catch { payload = null; }
      if (!response.ok) {
        errorName = 'Error';
        lastError = new Error(`Image generation failed: HTTP ${response.status} (${model})`);
        if ([403, 404, 429, 500, 502, 503, 504].includes(response.status)) continue;
        throw lastError;
      }
      const found = payload?.output?.find(item => item.type === 'image_generation_call' &&
        typeof item.result === 'string' && item.result);
      if (!found) {
        errorName = 'Error';
        lastError = new Error(`Image generation returned no image (${model})`); continue;
      }
      generated = found;
      usedModel = model;
      break;
    } catch (error) { errorName = error.name; throw error; }
    finally { recordImageUsage({ at, requestId, operationId, attempt: index + 1, component,
      service, modelRequested: model, response, payload, elapsedMs: performance.now() - started,
      errorName, onUsage }); }
  }
  if (!generated) throw lastError ?? new Error('Image generation failed');
  const png = Buffer.from(generated.result, 'base64');
  if (!png.length || png.length > MAX_BYTES) throw new Error('Generated image size is invalid');
  const bytes = await prepareWechatImage(png);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const sourceSha256 = createHash('sha256').update(png).digest('hex');
  const sourceFormat = (await sharp(png).metadata()).format;
  if (!['png', 'jpeg', 'webp'].includes(sourceFormat)) throw new Error('Unsupported generated source image');
  mkdirSync(outputDir, { recursive: true });
  const sourcePath = join(outputDir, `${sourceSha256}.source.${sourceFormat === 'jpeg' ? 'jpg' : sourceFormat}`);
  if (!existsSync(sourcePath)) writeFileSync(sourcePath, png, { flag: 'wx', mode: 0o600 });
  const filename = join(outputDir, `${sha256}.jpg`);
  if (!existsSync(filename)) writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 });
  return { path: filename, sha256, sourcePath, sourceSha256, prompt, model: usedModel,
    mediaType: 'image/jpeg', bytes: bytes.length };
}

export async function generateSelfie({ scene, referencePath = defaultReferencePath(),
  bodyReferencePath = defaultBodyReferencePath(),
  apiKey = anthropicKey(), timeoutMs = 240000, fetchImpl = fetch,
  models = defaultImageModels(), component = 'selfie', onUsage = appendImageUsage,
  outputDir = selfieDir() } = {}) {
  const referencePaths = [referencePath, bodyReferencePath].filter(path => path && existsSync(path));
  return generateFromPrompt({ prompt: buildSelfiePrompt(scene), referencePaths, outputDir,
    apiKey, timeoutMs, fetchImpl, models, component, onUsage });
}

export async function generatePicture({ prompt, apiKey = anthropicKey(), timeoutMs = 240000,
  fetchImpl = fetch, models = defaultImageModels(), component = 'picture', onUsage = appendImageUsage,
  outputDir = pictureDir() } = {}) {
  return generateFromPrompt({ prompt: buildPicturePrompt(prompt), outputDir,
    apiKey, timeoutMs, fetchImpl, models, component, onUsage });
}
