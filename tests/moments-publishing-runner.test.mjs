import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { prepareMomentImage } from '../packages/moments/publish-assets.mjs';
import { MomentsPublishService, MomentsPublishStore, draftDigest } from '../packages/moments/publish-service.mjs';
import { MomentsPublishingSchedule } from '../packages/moments/publishing-schedule.mjs';
import { runPublishingCycle } from '../packages/moments/publishing-runner.mjs';

const HOUR = 3_600_000;
const at = value => Date.parse(`${value}+08:00`);
const hash = value => createHash('sha256').update(value).digest('hex');
const ACCOUNT = 'account-1';
const SELF = 'wxid-test';
async function fixture(t) {
  mkdirSync(resolve('.runtime/runs'), { recursive: true });
  const dir = mkdtempSync(resolve('.runtime/runs/moments-runner-'));
  const input = join(dir, 'fixture.png');
  await sharp({ create: { width: 24, height: 18, channels: 3, background: '#69b8d0' } }).png().toFile(input);
  const asset = await prepareMomentImage(input, { assetDir: join(dir, 'assets') });
  const f = { dir, asset, time: at('2026-11-09T12:00:00'),
    calls: { model: 0, image: 0, upload: 0, publish: 0, verify: 0, online: 0 }, plans: [], logs: [] };
  f.now = () => f.time;
  f.schedulePath = join(dir, 'schedule.sqlite');
  f.schedule = new MomentsPublishingSchedule(f.schedulePath, { now: f.now, random: () => 0 });
  f.publishStore = new MomentsPublishStore(join(dir, 'publish.sqlite'), { now: f.now });
  f.service = new MomentsPublishService({ store: f.publishStore, accountId: ACCOUNT, selfUserId: SELF, gateway: {
    uploadImage: async a => {
      f.calls.upload++;
      return { sha256: a.sha256, md5: a.md5, width: a.width, height: a.height, bytes: a.bytes,
        url: 'https://mmsns.qpic.cn/test/image/0', urlType: 1,
        thumbUrl: 'https://mmsns.qpic.cn/test/image/150', thumbType: 1 };
    },
    publish: async draft => {
      f.calls.publish++;
      assert.equal(f.schedule.get(ACCOUNT, draft.key.slice('auto-moment-'.length)).state, 'dispatching');
      return { state: 'accepted', momentId: '123456' };
    },
    verify: async () => { f.calls.verify++; return { verified: true, momentId: '123456' }; },
  } });
  f.candidate = (id = 'daily:rest', extra = {}) => ({ id, kind: 'daily', topicKey: id,
    fingerprint: hash(id), title: '休息一会儿', summary: '想躺着发会儿呆', detailText: '', source: 'builtin',
    url: null, firstSeenAt: null, lastSeenAt: null, publishedAt: null, eventTimeVerified: false,
    expiresAt: f.time + 24 * HOUR, ...extra });
  f.plan = async request => {
    f.calls.model++; f.plans.push(request);
    return { action: 'publish', candidateId: request.candidates[0].id, caption: '想躺着发会儿呆',
      imageKind: 'picture', imagePrompt: '柔和灯光下的舒适抱枕小角落', reason: '自然的日常心情' };
  };
  f.generate = async job => {
    f.calls.image++; assert.equal(job.state, 'generating');
    assert.equal(f.schedule.get(ACCOUNT, job.id).state, 'generating');
    return asset;
  };
  f.online = async () => { f.calls.online++; return true; };
  f.run = extra => runPublishingCycle({ schedule: f.schedule, service: f.service, accountId: ACCOUNT,
    candidates: [f.candidate()], plan: f.plan, generate: f.generate, enabled: true,
    now: f.now, online: f.online, log: event => f.logs.push(event), ...extra });
  t.after(() => { f.schedule.close(); f.publishStore.close(); });
  return f;
}
async function selected(f, extra) {
  const result = await f.run(extra);
  assert.equal(result.job?.state, 'selected', JSON.stringify(result));
  return result.job;
}
async function prepared(f) {
  const job = await selected(f);
  f.time = job.dueAt - 10 * 60_000;
  const result = await f.run();
  assert.equal(result.job?.state, 'prepared', JSON.stringify(result));
  return result.job;
}

test('restored selected and prepared game posts stop before model, image or publication calls', async t => {
  for (const state of ['selected', 'prepared']) await t.test(state, async t => {
    const f = await fixture(t);
    const candidate = f.candidate('daily:game');
    let job = f.schedule.consider({ accountId: ACCOUNT, opportunityKey: candidate.id,
      sourceFingerprint: candidate.fingerprint, topicKey: candidate.topicKey,
      expiresAt: candidate.expiresAt, source: candidate }).job;
    job = f.schedule.select(ACCOUNT, job.id, { text: '我这就上号打三角洲',
      imageKind: 'selfie', imagePrompt: '肥鱼坐在电脑前玩三角洲', visibility: 'friends' });
    if (state === 'prepared') {
      f.schedule.claimGeneration(ACCOUNT, job.id);
      job = f.schedule.saveAsset(ACCOUNT, job.id, f.asset);
      const draft = f.service.draft({ key: `auto-moment-${job.id}`, text: job.text,
        visibility: job.visibility, media: [f.asset] });
      job = f.schedule.bindPublication(ACCOUNT, job.id, { key: draft.key, digest: draft.digest });
    }
    f.time = job.dueAt;
    const result = await f.run();
    assert.equal(result.state, 'failed');
    assert.equal(result.reason, 'cannot_play_games');
    assert.deepEqual(result.calls, { model: 0, generation: 0, publish: 0 });
    assert.equal(f.calls.upload + f.calls.publish + f.calls.verify, 0);
    assert.equal(f.schedule.get(ACCOUNT, job.id).attemptedAt, null);
    await f.run();
    assert.equal(f.calls.upload + f.calls.publish + f.calls.verify, 0);
  });
});

test('disabled returns before inspecting collaborators, model, image, status or network', async () => {
  const bomb = new Proxy({}, { get() { throw new Error('must not inspect disabled collaborators'); } });
  const result = await runPublishingCycle({ enabled: false, service: bomb, schedule: bomb,
    online: () => { throw new Error('must not check network'); }, now: () => { throw new Error('must not read clock'); } });
  assert.equal(result.state, 'disabled');
  assert.deepEqual(result.calls, { model: 0, generation: 0, publish: 0 });
});

test('offline or absent online provider never creates work or calls a model', async t => {
  const f = await fixture(t);
  for (const online of [undefined, async () => false, async () => { throw new Error('offline'); }]) {
    const result = await f.run({ online });
    assert.equal(result.state, 'offline');
    assert.deepEqual(result.calls, { model: 0, generation: 0, publish: 0 });
  }
  assert.deepEqual(f.schedule.list(ACCOUNT), []);
  assert.equal(f.calls.model + f.calls.image + f.calls.publish, 0);
});

test('wrong service account fails before online check and paid calls', async t => {
  const f = await fixture(t);
  const result = await f.run({ accountId: 'other-account' });
  assert.equal(result.state, 'error');
  assert.equal(result.reason, 'configuration_failed');
  assert.equal(f.calls.online + f.calls.model + f.calls.image + f.calls.publish, 0);
});

test('one candidate is planned; none is durable and decision cooldown prevents new-candidate polling costs', async t => {
  const f = await fixture(t);
  const result = await f.run({ candidates: [f.candidate('one'), f.candidate('two')], plan: async request => {
    f.calls.model++; assert.equal(request.candidates.length, 1); assert.equal(request.candidates[0].id, 'one');
    return { action: 'none', reason: '没什么自然想说的' };
  } });
  assert.equal(result.state, 'declined');
  assert.deepEqual(result.calls, { model: 1, generation: 0, publish: 0 });
  assert.equal((await f.run({ candidates: [f.candidate('two')] })).reason, 'decision_cooldown');
  assert.equal(f.calls.model, 1);
  assert.equal(f.calls.image + f.calls.publish, 0);
});

test('selected job waits until ten minutes before due; new candidates do not rerun planning', async t => {
  const f = await fixture(t);
  const job = await selected(f);
  assert.equal(job.dueAt, f.now() + 30 * 60_000);
  f.time = job.dueAt - 10 * 60_000 - 1;
  const result = await f.run({ candidates: [f.candidate('new-event')] });
  assert.equal(result.reason, 'before_generation_window');
  assert.equal(result.job.id, job.id);
  assert.deepEqual(result.calls, { model: 0, generation: 0, publish: 0 });
  assert.equal(f.calls.model, 1);
});

test('happy path generates once, binds exact account/caption/image, then publishes once at due', async t => {
  const f = await fixture(t);
  const job = await prepared(f);
  assert.equal(f.calls.model, 1); assert.equal(f.calls.image, 1); assert.equal(f.calls.publish, 0);
  const draft = f.service.get(job.publicationKey);
  assert.equal(draft.key, `auto-moment-${job.id}`);
  assert.equal(draft.accountId, ACCOUNT); assert.equal(draft.selfUserId, SELF);
  assert.equal(draft.text, job.text); assert.equal(draft.visibility, 'friends');
  assert.equal(draft.media[0].sha256, f.asset.sha256); assert.equal(draft.digest, job.publicationDigest);
  f.time = job.dueAt;
  const sent = await f.run();
  assert.equal(sent.state, 'verified');
  assert.deepEqual(sent.calls, { model: 0, generation: 0, publish: 1 });
  assert.equal(f.calls.upload, 1); assert.equal(f.calls.publish, 1); assert.equal(f.calls.verify, 1);
  assert.equal(f.schedule.assess(ACCOUNT).rollingCount, 1);
  assert.equal((await f.run()).reason, 'minimum_gap');
  assert.equal(f.calls.model, 1); assert.equal(f.calls.image, 1); assert.equal(f.calls.publish, 1);
});

test('planner cannot switch candidate identity, source fingerprint or publish an unsafe caption', async t => {
  for (const variant of ['candidate', 'fingerprint', 'caption']) {
    const f = await fixture(t);
    const result = await f.run({ plan: async request => {
      const base = await f.plan(request);
      return variant === 'candidate' ? { ...base, candidateId: 'invented' } :
        variant === 'fingerprint' ? { ...base, fingerprint: 'c'.repeat(64) } :
          { ...base, caption: '加我 wxid_private' };
    } });
    assert.equal(result.state, 'failed'); assert.equal(result.reason, 'planning_failed');
    assert.equal(f.calls.model, 1); assert.equal(f.calls.image + f.calls.publish, 0);
  }
});

test('source expiring during image generation preserves cached result but never binds or publishes it', async t => {
  const f = await fixture(t);
  const job = await selected(f, { candidates: [f.candidate('short', { expiresAt: f.now() + HOUR })] });
  f.time = job.dueAt - 10 * 60_000;
  const result = await f.run({ generate: async value => { f.calls.image++; f.time = value.expiresAt; return f.asset; } });
  assert.equal(result.state, 'failed');
  assert.equal(result.reason, 'opportunity_expired_after_generation');
  assert.equal(result.job.asset.sha256, f.asset.sha256);
  assert.equal(result.job.publicationKey, null); assert.equal(result.job.attemptedAt, null);
  assert.deepEqual(result.calls, { model: 0, generation: 1, publish: 0 });
});

test('source expiring before or during online check never starts image generation', async t => {
  for (const expireInOnline of [false, true]) {
    const f = await fixture(t);
    const job = await selected(f, { candidates: [f.candidate('short', { expiresAt: f.now() + HOUR })] });
    f.time = expireInOnline ? job.dueAt - 10 * 60_000 : job.expiresAt;
    let checks = 0;
    const result = await f.run({ online: async () => {
      if (++checks === 2) f.time = job.expiresAt;
      return true;
    } });
    assert.equal(result.state, 'failed');
    assert.match(result.reason, /^opportunity_expired/u);
    assert.equal(f.calls.image + f.calls.publish, 0);
  }
});

test('ready asset survives a crash before draft creation and is reused after restart', async t => {
  const f = await fixture(t);
  const job = await selected(f);
  f.schedule.claimGeneration(ACCOUNT, job.id);
  f.schedule.saveAsset(ACCOUNT, job.id, f.asset);
  f.schedule.close();
  f.schedule = new MomentsPublishingSchedule(f.schedulePath, { now: f.now, random: () => { throw new Error('no new random due'); } });
  f.schedule.recoverInterrupted(ACCOUNT);
  f.time = job.dueAt;
  const result = await f.run({ generate: async () => { throw new Error('must reuse cached asset'); } });
  assert.equal(result.state, 'verified');
  assert.deepEqual(result.calls, { model: 0, generation: 0, publish: 1 });
  assert.equal(f.calls.image, 0); assert.equal(f.calls.publish, 1);
});

test('runner never recovers or retries interrupted generation on its own', async t => {
  const f = await fixture(t);
  const job = await selected(f);
  f.schedule.claimGeneration(ACCOUNT, job.id);
  f.time = job.dueAt;
  const result = await f.run();
  assert.equal(result.reason, 'generating_requires_reconciliation');
  assert.equal(f.schedule.get(ACCOUNT, job.id).state, 'generating');
  assert.deepEqual(result.calls, { model: 0, generation: 0, publish: 0 });
});

test('timeout leaves unknown attempt; later cycles never send or poll status again', async t => {
  const f = await fixture(t);
  const job = await prepared(f);
  let statusCalls = 0;
  f.service.status = async () => { statusCalls++; throw new Error('must not repeatedly check status'); };
  f.service.gateway.publish = async () => { f.calls.publish++; throw new Error('timeout contains secret do not log'); };
  f.time = job.dueAt;
  const sent = await f.run();
  assert.equal(sent.state, 'needs_review');
  assert.equal(f.schedule.assess(ACCOUNT).rollingCount, 1);
  for (let cycle = 0; cycle < 3; cycle++) {
    f.time += 60_000;
    assert.equal((await f.run()).reason, 'needs_review_requires_reconciliation');
  }
  assert.equal(f.calls.publish, 1); assert.equal(statusCalls, 0);
  assert.equal(JSON.stringify(f.logs).includes('secret'), false);
});

test('throw from send after scheduler claim is durable uncertainty and never becomes a fresh attempt', async t => {
  const f = await fixture(t);
  const job = await prepared(f);
  f.time = job.dueAt;
  f.service.send = async () => { throw new Error('failed transport setup'); };
  const result = await f.run();
  assert.equal(result.state, 'needs_review');
  assert.equal(result.job.attemptedAt, f.time);
  assert.equal(f.schedule.assess(ACCOUNT).rollingCount, 1);
  const retry = await f.run();
  assert.equal(retry.calls.publish, 0);
  assert.equal(retry.reason, 'needs_review_requires_reconciliation');
});

test('tampered image bytes and mismatched existing draft stop before publication', async t => {
  const f = await fixture(t);
  const job = await prepared(f);
  f.time = job.dueAt;
  writeFileSync(f.asset.path, 'changed cache bytes');
  const result = await f.run();
  assert.equal(result.state, 'failed');
  assert.equal(result.reason, 'dispatch_validation_failed');
  assert.equal(f.calls.publish + f.calls.upload, 0);
});

test('runner validates returned draft identity, text, image and digest independently of service', async t => {
  for (const variant of ['account', 'self', 'text', 'image', 'digest']) {
    const f = await fixture(t);
    const job = await selected(f);
    const draft = f.service.draft.bind(f.service);
    f.service.draft = input => {
      const value = structuredClone(draft(input));
      if (variant === 'account') value.accountId = 'foreign';
      if (variant === 'self') value.selfUserId = 'wxid_other';
      if (variant === 'text') value.text = '不同正文';
      if (variant === 'image') value.media[0].sha256 = 'c'.repeat(64);
      value.digest = variant === 'digest' ? 'a'.repeat(64) : draftDigest(value);
      return value;
    };
    f.time = job.dueAt;
    const result = await f.run();
    assert.equal(result.state, 'failed'); assert.equal(result.reason, 'draft_failed');
    assert.equal(result.job.publicationKey, null); assert.equal(result.calls.publish, 0);
  }
});

test('concurrent cycle observes active dispatch without downgrading it or duplicating send', async t => {
  const f = await fixture(t);
  const job = await prepared(f);
  f.time = job.dueAt;
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  let started;
  const start = new Promise(resolve => { started = resolve; });
  f.service.gateway.publish = async () => {
    f.calls.publish++; started(); await waiting;
    return { state: 'accepted', momentId: '123456' };
  };
  const sending = f.run();
  await start;
  const concurrent = await f.run();
  assert.equal(concurrent.reason, 'dispatching_requires_reconciliation');
  assert.equal(f.schedule.get(ACCOUNT, job.id).state, 'dispatching');
  finish();
  assert.equal((await sending).state, 'verified');
  assert.equal(f.calls.publish, 1);
});

test('planner exceptions and invalid generation results are not silently retried', async t => {
  const f = await fixture(t);
  const failed = await f.run({ plan: async () => { throw new Error('provider rejected'); } });
  assert.equal(failed.state, 'failed'); assert.equal(failed.reason, 'planning_failed');
  assert.equal((await f.run()).reason, 'decision_cooldown');
  f.time += 6 * HOUR;
  const job = await selected(f, { candidates: [f.candidate('other')] });
  f.time = job.dueAt;
  const result = await f.run({ generate: async () => ({ path: 'missing' }) });
  assert.equal(result.state, 'failed'); assert.equal(result.reason, 'generation_failed');
  assert.equal(result.calls.generation, 1); assert.equal(f.calls.publish, 0);
});

test('all considered or expired candidates are idle without additional model calls', async t => {
  const f = await fixture(t);
  const candidate = f.candidate();
  await f.run({ candidates: [candidate], plan: async () => ({ action: 'none', reason: '先不发' }) });
  f.time += 6 * HOUR;
  const result = await f.run({ candidates: [candidate, f.candidate('old', { expiresAt: f.time - 1 })] });
  assert.equal(result.reason, 'no_new_opportunity');
  assert.deepEqual(result.calls, { model: 0, generation: 0, publish: 0 });
});
