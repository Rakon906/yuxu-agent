import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { WeChatAdapter } from '../packages/wechat-adapter/index.mjs';
import { WeChatClient } from '../packages/wechat-adapter/client.mjs';
import { ParticipationLedger, runParticipationCycle } from '../packages/participation/index.mjs';
import { buildPicturePrompt, buildSelfiePrompt, defaultImageModels, generatePicture,
  generateSelfie, prepareWechatImage, WECHAT_IMAGE_MAX_BYTES, WECHAT_IMAGE_MAX_EDGE }
  from '../packages/selfie/index.mjs';
import sharp from 'sharp';
import { projectRoot } from '../scripts/runtime.mjs';
import { startWeChatFixture, ACCOUNT, GROUP, SELF, TOKEN } from './fixtures/wechat-server.mjs';

const start = Date.parse('2026-11-02T14:00:00+08:00');
const png = await sharp({ create: { width: 16, height: 16, channels: 3,
  background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
const decision = (reply, extra = {}) => ({ isQuestion: false, isAddressed: false,
  isFollowup: false, answeredByHuman: false, shouldReply: Boolean(reply), reply,
  reason: 'synthetic decision', stickers: [], selfie: null, ...extra });

async function setup(t, { sendEnabled = true } = {}) {
  await mkdir(join(projectRoot, '.runtime'), { recursive: true });
  const root = await mkdtemp(join(projectRoot, '.runtime', 'participation-selfie-test-'));
  const inboxPath = join(root, 'inbox.sqlite');
  const source = new AdapterStore(inboxPath, ACCOUNT);
  const outbox = new AdapterStore(join(root, 'participation.sqlite'), ACCOUNT);
  const ledger = new ParticipationLedger(outbox);
  const server = await startWeChatFixture();
  const client = new WeChatClient({ baseUrl: server.origin, token: TOKEN, accountId: ACCOUNT });
  const adapter = new WeChatAdapter({ client, store: outbox, allowedGroups: [GROUP],
    selfUserId: SELF, sendingEnabled: sendEnabled, cooldownMs: 0 });
  let sequence = 0;
  const insert = (id, senderId, text, options = {}) => source.commitEvent(String(++sequence), {
    platform: 'wechat', accountId: ACCOUNT, groupId: GROUP, userId: senderId,
    sourceMessageId: id, text, eventTime: new Date(start).toISOString(),
    recordedAt: new Date(start).toISOString(), mentions: options.mentions ??
      { state: 'known', self: false, userIds: [] },
  }, 'text');
  t.after(async () => { source.close(); outbox.close(); await server.close(); });
  const cycle = (now, model, extra = {}) => runParticipationCycle({ ledger, adapter, model,
    inboxPath, accountId: ACCOUNT, groupId: GROUP, now, startAtLatest: false, sendEnabled, ...extra });
  return { root, source, outbox, ledger, server, insert, cycle };
}

test('generateSelfie falls back to grok when gpt is region-blocked', async () => {  const root = await mkdtemp(join(projectRoot, '.runtime', 'selfie-fallback-test-'));
  const referencePath = join(root, 'avatar.png');
  writeFileSync(referencePath, png);
  const models = [];
  const result = await generateSelfie({ scene: '测试自拍', referencePath, apiKey: 'test-key',
    outputDir: root, onUsage: () => {},
    models: ['gpt-6-luna', 'grok-4.7'],
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      models.push(body.model);
      if (body.model === 'gpt-6-luna') {
        return { ok: false, status: 403, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({
        output: [{ type: 'image_generation_call', status: 'completed',
          result: png.toString('base64') }] }) };
    } });
  assert.deepEqual(models, ['gpt-6-luna', 'grok-4.7']);
  assert.equal(result.model, 'grok-4.7');
});

test('an explicit selfie request generates and sends one selfie', async t => {
  const f = await setup(t);
  f.insert('m1', 'alice', '@肥鱼不肥 发张自拍看看', { mentions: { state: 'known', self: true, userIds: [SELF] } });
  await f.cycle(start, () => assert.fail('not due'));
  const calls = [];
  const model = () => decision('', { shouldReply: true,
    selfie: { scene: '对着镜头歪头自拍', reason: '群友明确要自拍' } });
  const result = await f.cycle(start + 15001, model, {
    sendSelfie: async ({ selfie }) => { calls.push(selfie); return { state: 'sent', key: 'k' }; },
  });
  assert.equal(result.status, 'sent');
  assert.equal(result.selfie, '对着镜头歪头自拍');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scene, '对着镜头歪头自拍');
  assert.equal(f.server.state.posts, 0, 'selfie-only turns do not post text');
  assert.equal(f.ledger.task('m1').state, 'sent');
});

test('a selfie is dropped when the message did not ask for one', async t => {
  const f = await setup(t);
  f.insert('m1', 'alice', '今天真热');
  await f.cycle(start, () => assert.fail('not due'));
  let calls = 0;
  const model = () => decision('', { shouldReply: false,
    selfie: { scene: '对着镜头自拍', reason: '模型主动加的' } });
  const result = await f.cycle(start + 90001, model, {
    sendSelfie: async () => { calls++; return { state: 'sent', key: 'k' }; },
  });
  assert.notEqual(result.status, 'sent');
  assert.equal(calls, 0);
  assert.equal(f.server.state.posts, 0);
});

test('default image models use only gpt-6-luna', () => {
  assert.deepEqual(defaultImageModels(), ['gpt-6-luna']);
});

test('selfie prompt carries the fixed appearance and rejects empty or blocked scenes', () => {
  const prompt = buildSelfiePrompt('刚睡醒的自拍');
  assert.match(prompt, /black hair/u);
  assert.match(prompt, /shark hoodie/u);
  assert.match(prompt, /刚睡醒的自拍/u);
  assert.match(prompt, /photorealistic/u);
  assert.match(prompt, /no anime/iu);
  assert.match(buildSelfiePrompt('动漫展上的自拍'), /subject matter only/u);
  assert.throws(() => buildSelfiePrompt(''), /required/u);
  assert.throws(() => buildSelfiePrompt('裸照'), /not allowed/u);
});

test('generateSelfie sends the reference image and saves the returned image', async () => {
  const root = await mkdtemp(join(projectRoot, '.runtime', 'selfie-ref-test-'));
  const referencePath = join(root, 'avatar.png');
  writeFileSync(referencePath, png);
  let request;
  const result = await generateSelfie({ scene: '测试自拍', referencePath, bodyReferencePath: referencePath,
    apiKey: 'test-key', outputDir: root, onUsage: () => {},
    fetchImpl: async (url, options) => {
      request = { url: url.toString(), headers: options.headers, body: JSON.parse(options.body) };
      return { ok: true, status: 200, json: async () => ({
        output: [{ type: 'image_generation_call', status: 'completed',
          result: png.toString('base64') }] }) };
    } });
  assert.equal(request.url, 'https://opencode.ai/inference/go/openai/v1/responses');
  assert.equal(request.headers.authorization, 'Bearer test-key');
  assert.equal(request.body.model, 'gpt-6-luna');
  assert.equal(request.body.tools[0].type, 'image_generation');
  assert.match(request.body.input[0].content[0].text, /reference image/u);
  assert.equal(request.body.input[0].content.length, 3);
  assert.match(request.body.input[0].content[1].image_url, /^data:image\/png;base64,/u);
  assert.match(request.body.input[0].content[2].image_url, /^data:image\/png;base64,/u);
  assert.equal(result.mediaType, 'image/jpeg');
  assert.ok(existsSync(result.path));
});

test('picture prompt accepts a drawing request and rejects empty or blocked prompts', () => {
  const prompt = buildPicturePrompt('画一碗');
  assert.match(prompt, /画一碗/u);
  assert.match(prompt, /photorealistic/iu);
  assert.match(prompt, /no illustration/u);
  assert.match(buildPicturePrompt('一张动漫插画，海边日落'), /subject matter only/u);
  assert.throws(() => buildPicturePrompt(''), /required/u);
  assert.throws(() => buildPicturePrompt('血腥场面'), /not allowed/u);
});

test('generatePicture sends no reference image', async () => {
  let request;
  const root = await mkdtemp(join(projectRoot, '.runtime', 'picture-usage-test-'));
  const result = await generatePicture({ prompt: '画一碗', apiKey: 'test-key',
    outputDir: root, onUsage: () => {},
    fetchImpl: async (url, options) => {
      request = { body: JSON.parse(options.body) };
      return { ok: true, status: 200, json: async () => ({
        output: [{ type: 'image_generation_call', status: 'completed',
          result: png.toString('base64') }] }) };
    } });
  assert.equal(request.body.input[0].content.length, 1);
  assert.equal(request.body.input[0].content[0].type, 'input_text');
  assert.equal(result.mediaType, 'image/jpeg');
  assert.ok(result.path.startsWith(root));
  assert.deepEqual(readFileSync(result.sourcePath), png);
});

test('generated images retain full dimensions and do not use the preview byte budget', async () => {
  const width = 1024, height = 1536;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) & 0xff;
  const large = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const prepared = await prepareWechatImage(large);
  assert.ok(prepared.length > 0);
  assert.ok(prepared.length <= WECHAT_IMAGE_MAX_BYTES, `bytes=${prepared.length}`);
  const meta = await sharp(prepared).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, width);
  assert.equal(meta.height, height);
  assert.ok(prepared.length > 65520);
  assert.ok(Math.max(meta.width, meta.height) <= WECHAT_IMAGE_MAX_EDGE);
  assert.deepEqual(await prepareWechatImage(prepared), prepared);
});
