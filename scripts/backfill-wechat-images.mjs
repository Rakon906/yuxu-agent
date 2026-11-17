import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createStickerVision, imageMediaType, IMAGE_VISION_PROMPT } from '../packages/model/vision.mjs';
import { projectRoot } from './runtime.mjs';

const execFile = promisify(execFileCallback);
const env = process.env;
const apply = process.argv.includes('--apply');
const dbPath = env.SOCIOMEM_WECHAT_STORE ?? join(projectRoot, '.runtime', 'wechat-adapter', 'sociomem.sqlite');
const dataDir = env.SOCIOMEM_WECHAT_DATA_DIR ?? join(projectRoot, '.runtime', 'agent-wechat');
const cliPath = env.SOCIOMEM_WECHAT_CLI ?? join(projectRoot, '.tools', 'agent-wechat', 'v1.3.2', 'wx.exe');
const imageDir = join(projectRoot, '.runtime', 'images');

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout=5000');
const vision = createStickerVision({ provider: env.SOCIOMEM_VISION_PROVIDER ?? 'anthropic' });
const clean = (value, max) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f]/gu, ' ').trim().slice(0, max) : '';

const rows = db.prepare("SELECT id,message FROM inbox WHERE message LIKE '%\"imageError\"%' ORDER BY rowid").all();
if (!rows.length) console.log('No failed image rows');
for (const row of rows) {
  const message = JSON.parse(row.message);
  if (message.interaction !== 'image') continue;
  mkdirSync(imageDir, { recursive: true });
  const temporary = join(imageDir, `backfill-${process.pid}-${randomUUID().slice(0, 8)}.download`);
  try {
    await execFile(cliPath, ['--json', '--data-dir', dataDir, 'messages', 'media',
      message.groupId, message.sourceMessageId, '--output', temporary, '--wait', '30'],
      { encoding: 'utf8', windowsHide: true, timeout: 90000 });
    const bytes = readFileSync(temporary);
    const described = await vision({ bytes, prompt: IMAGE_VISION_PROMPT });
    const summary = clean(described.summary ?? described.scene, 240);
    const visibleText = clean(described.visibleText, 160);
    const tone = clean(described.tone, 120);
    const safety = ['safe', 'uncertain', 'unsafe'].includes(described.safety) ? described.safety : 'safe';
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const extension = imageMediaType(bytes).split('/')[1].replace('jpeg', 'jpg');
    const filename = join(imageDir, `${sha256}.${extension}`);
    if (!existsSync(filename)) writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 });
    const text = safety === 'unsafe'
      ? '[群友发送图片；内容可能不适合在群里转述]'
      : `[群友发送图片；以下是看图描述，不是群友原话] ${summary || '画面暂时无法描述'}` +
        (visibleText ? `；图中文字：${visibleText}` : '') +
        (tone ? `；可能语气/用途：${tone}` : '');
    const updated = { ...message, text, interaction: 'image', imageSummary: summary,
      imageVisibleText: visibleText, imageTone: tone, imageSafety: safety,
      imageSha256: sha256, imagePath: filename, imageModel: described.model ?? null };
    delete updated.imageError;
    delete updated.imageErrorMessage;
    if (apply) db.prepare('UPDATE inbox SET message=? WHERE id=?').run(JSON.stringify(updated), row.id);
    console.log(JSON.stringify({ id: row.id, applied: apply, summary, visibleText, tone, safety, filename }));
  } catch (error) {
    console.log(JSON.stringify({ id: row.id, errorType: error.name, errorMessage: String(error.message).slice(0, 300) }));
  } finally {
    rmSync(temporary, { force: true });
  }
}
db.close();
