import { installVoiceModel, voiceModelDir } from '../packages/voice/index.mjs';

const dir = process.env.SOCIOMEM_VOICE_MODEL_DIR ?? voiceModelDir();
const origins = (process.env.SOCIOMEM_VOICE_MODEL_ORIGINS ??
  'https://huggingface.co,https://hf-mirror.com')
  .split(',').map(value => value.trim().replace(/\/$/u, '')).filter(Boolean);
try {
  await installVoiceModel({ dir, origins, log: message => console.log(message) });
  console.log(JSON.stringify({ ok: true, dir }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, dir, error: error.message }));
  process.exitCode = 1;
}
