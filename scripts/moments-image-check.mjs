/** Read-only end-to-end SNS image check. Never likes, comments, publishes or logs credentials. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { selectOnlineAccount } from '../packages/wechat-adapter/real-config.mjs';
import { MomentsDaemonClient } from '../packages/moments/daemon-client.mjs';
import { parseTimelineReply, timelineBody } from '../packages/moments/timeline.mjs';
import { validateMomentImage } from '../packages/moments/media.mjs';
import { projectRoot } from './runtime.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node scripts/moments-image-check.mjs [--limit 1..3]\nReads the current account feed and downloads photos through its native daemon. Saves private results under .runtime; sends nothing.');
  process.exit(0);
}
if (args.some((arg, i) => arg !== '--limit' && args[i - 1] !== '--limit')) throw new Error('Unknown image check argument');
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 1;
if (!Number.isInteger(limit) || limit < 1 || limit > 3) throw new Error('Image check limit must be 1..3');
const dataDir = resolve(projectRoot, '.runtime/agent-wechat');
const account = selectOnlineAccount(JSON.parse(execFileSync(
  join(projectRoot, '.tools/agent-wechat/v1.3.2/wx.exe'),
  ['--json', '--data-dir', dataDir, 'accounts', 'list'], { encoding: 'utf8', windowsHide: true })).items, {});
const client = new MomentsDaemonClient({ baseUrl: 'http://127.0.0.1:6174',
  accountId: account.accountId, token: readFileSync(join(dataDir, 'api-token'), 'utf8').trim() });
const reply = await client.probe(211, timelineBody(), { withBaseRequest: true });
if (reply.ok === false) throw new Error('Timeline unavailable');
const timeline = parseTimelineReply(reply.replyHex);
const photos = timeline.objects.filter(moment => moment.author?.id !== account.selfUserId)
  .flatMap(moment => moment.media.filter(media => media.type === 2 && media.md5 && media.url)
    .map(media => ({ momentId: moment.id, media }))).slice(0, limit);
if (!photos.length) throw new Error('No friend photo available in current timeline');
const output = join(projectRoot, '.runtime/moments-image-check', new Date().toISOString().replace(/[:.]/gu, '-'));
mkdirSync(output, { recursive: true });
const results = [];
for (const [index, { momentId, media }] of photos.entries()) {
  try {
    const image = validateMomentImage(await client.downloadImage(momentId, media), { ...media, momentId });
    const path = join(output, `image-${index + 1}.${image.extension}`);
    writeFileSync(path, image.bytes, { flag: 'wx' });
    results.push({ index: index + 1, ok: true, momentId, mediaId: media.id,
      bytes: image.byteLength, sha256: image.sha256, nativeBinding: image.nativeBinding,
      declaredMd5Matches: image.declaredMd5Matches, declaredBytesMatch: image.declaredBytesMatch, path });
  } catch (error) {
    results.push({ index: index + 1, ok: false, error: error.message });
  }
}
writeFileSync(join(output, 'results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ checked: results.length, passed: results.filter(x => x.ok).length,
  failed: results.filter(x => !x.ok).length, output, results: results.map(({ momentId, mediaId, sha256, ...r }) => r) }));
if (results.some(x => !x.ok)) process.exitCode = 1;
