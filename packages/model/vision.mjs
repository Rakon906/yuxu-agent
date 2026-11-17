import { createOllamaJsonModel, defaultOllamaModel } from './ollama.mjs';
import { createAnthropicJsonModel } from './anthropic.mjs';

export function imageMediaType(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error('Sticker image must be a Buffer');
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (/^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw new Error('Unsupported sticker image type');
}

export function stickerVisionPrompt(contexts) {
  return '只根据这张表情图片，输出JSON对象：summary（一句话总述画面里可见的角色、动作和文字）、' +
    'visibleText（逐字可读文字，看不清写空字符串）、tone（可能表达的语气，注明只是推测）、' +
    `context（从这些语境中选一个：${contexts.join('、')}）、` +
    'reusable（true或false，是否适合以后在群里再次发送）、' +
    'safety（safe、uncertain或unsafe，是否含辱骂、隐私、色情、暴力、政治敏感等不宜复用内容）、' +
    'reason（保存判断的简短原因）。不要猜群友身份、真实事件或聊天背景。';
}

export const IMAGE_VISION_PROMPT = '只根据这张群聊图片，输出JSON对象：summary（画面里可见的人、物、场景，简短客观）、' +
  'visibleText（图中可读文字，看不清写空字符串）、tone（可能传达的情绪或用途，注明只是推测）、' +
  'safety（safe、uncertain或unsafe：课程通知、聊天截图、生活照片和普通屏幕截图都算 safe；' +
  '只有明显色情、血腥暴力、辱骂或政治敏感才标 unsafe；看不清或可能有争议标 uncertain）。' +
  '不要猜群友身份或聊天背景。';

export function createStickerVision({ provider = process.env.SOCIOMEM_VISION_PROVIDER ?? 'ollama',
  anthropic = null, ollama = createOllamaJsonModel(),
  anthropicModel = process.env.SOCIOMEM_ANTHROPIC_MODEL ?? 'anthropic',
  ollamaModel = process.env.SOCIOMEM_OLLAMA_MODEL ?? defaultOllamaModel,
  maxTokens = 8000, onFallback = () => {} } = {}) {
  if (!['ollama', 'anthropic'].includes(provider)) throw new Error('Invalid vision provider');
  const remote = provider === 'anthropic' ? anthropic ?? createAnthropicJsonModel() : null;
  return async ({ bytes, prompt, signal }) => {
    signal?.throwIfAborted();
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('Invalid sticker image');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Sticker vision prompt is required');
    const data = bytes.toString('base64');
    if (remote) {
      try {
        const result = await remote({ component: 'vision', maxTokens, temperature: 0, signal,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: imageMediaType(bytes), data } },
            { type: 'text', text: prompt },
          ] }] });
        return { ...result, model: anthropicModel };
      } catch (error) { signal?.throwIfAborted(); onFallback(error); }
    }
    signal?.throwIfAborted();
    const result = await ollama({ component: 'vision', maxTokens, temperature: 0, signal,
      messages: [{ role: 'user', content: prompt, images: [data] }] });
    return { ...result, model: ollamaModel };
  };
}
