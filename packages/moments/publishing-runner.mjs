import { readMomentAsset, validateMomentAsset } from './publish-assets.mjs';
import { draftDigest } from './publish-service.mjs';
import { validateMomentPublishingPlan } from './publishing-content.mjs';
import { gameParticipationViolation } from '../participation/game-boundary.mjs';

const GENERATE_AHEAD_MS = 10 * 60_000;
const GAP_MS = 36 * 3_600_000;
const RUNNABLE = new Set(['selected', 'ready', 'prepared']);
const UNCERTAIN = new Set(['evaluating', 'generating', 'dispatching', 'needs_review']);
const TERMINAL = new Set(['verified', 'rejected']);

function clock(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_000_000_000_000_000) throw new Error('Invalid publishing clock');
  return value;
}
function budgetReason(policy, now) {
  // assess() includes the current job as active. Its independent budget fields
  // still let us avoid paid generation when that job cannot be sent.
  if (!policy.window.open) return 'outside_window';
  if (policy.rollingCount >= 3) return 'rolling_limit';
  if (policy.weekCount >= policy.week.target) return 'weekly_target_reached';
  if (policy.lastAttemptAt !== null && now - policy.lastAttemptAt < GAP_MS) return 'minimum_gap';
  return null;
}
function checkedDraft(draft, job, service, accountId) {
  const expectedKey = `auto-moment-${job.id}`;
  if (!draft || draft.key !== expectedKey || draft.accountId !== accountId || job.accountId !== accountId ||
      service.accountId !== accountId || draft.selfUserId !== service.selfUserId ||
      draft.text !== job.text || draft.visibility !== job.visibility ||
      !Array.isArray(draft.media) || draft.media.length !== 1 ||
      JSON.stringify(validateMomentAsset(draft.media[0])) !== JSON.stringify(validateMomentAsset(job.asset)) ||
      draft.digest !== draftDigest(draft) ||
      job.publicationKey && job.publicationKey !== draft.key ||
      job.publicationDigest && job.publicationDigest !== draft.digest) {
    throw new Error('Publishing draft does not match scheduled job');
  }
  return draft;
}
function checkedPlan(result, candidate) {
  if (!result || typeof result !== 'object') throw new Error('Invalid publishing plan');
  const payload = result.action === 'none' ? { action: result.action, reason: result.reason }
    : { action: result.action, candidateId: result.candidateId, caption: result.caption,
      imageKind: result.imageKind, imagePrompt: result.imagePrompt, reason: result.reason };
  const plan = validateMomentPublishingPlan(payload, [candidate]);
  if (plan.action === 'publish' && (
    result.topicKey !== undefined && result.topicKey !== candidate.topicKey ||
    result.fingerprint !== undefined && result.fingerprint !== candidate.fingerprint ||
    result.expiresAt !== undefined && result.expiresAt !== candidate.expiresAt)) {
    throw new Error('Publishing plan changed candidate identity');
  }
  return plan;
}

/** Run at most one planning call, one image generation and one publication.
 * Ownership and startup recovery belong to the worker. This function never
 * retries a model/image call or polls an uncertain publication automatically.
 */
export async function runPublishingCycle({ schedule, service, accountId, candidates = [],
  plan, generate, now = Date.now, enabled = false, online, log } = {}) {
  const calls = { model: 0, generation: 0, publish: 0 };
  const result = (state, reason, job = null, extra = {}) => ({ state, reason, job, calls: { ...calls }, ...extra });
  // Disabled must not even inspect databases, network status or provider wiring.
  if (enabled !== true) return result('disabled', 'disabled');
  let job = null;
  let phase = 'configuration';
  let ownsDispatch = false;
  const emit = async event => {
    if (typeof log !== 'function') return;
    try { await log(event); } catch { /* Logging must not change a publication outcome. */ }
  };
  const isOnline = async (force = false) => {
    if (typeof online !== 'function') return false;
    try { return await online({ force }) === true; } catch { return false; }
  };
  const expired = () => clock(now) >= job.expiresAt;
  const expire = reason => {
    job = schedule.get(accountId, job.id);
    if (RUNNABLE.has(job.state) || job.state === 'generating') {
      job = schedule.failBeforeDispatch(accountId, job.id, reason);
    }
    return result(job.state, reason, job);
  };
  try {
    if (typeof accountId !== 'string' || !accountId || !service || service.accountId !== accountId ||
        typeof service.selfUserId !== 'string' || !service.selfUserId ||
        typeof service.get !== 'function' || typeof service.draft !== 'function' || typeof service.send !== 'function' ||
        !schedule || typeof schedule.consider !== 'function') throw new Error('Invalid publishing account or collaborators');
    clock(now);
    if (!await isOnline()) return result('offline', 'offline');

    phase = 'lookup';
    const jobs = schedule.list(accountId, { limit: 500 });
    const uncertain = jobs.find(item => UNCERTAIN.has(item.state));
    if (uncertain) return result('needs_review', `${uncertain.state}_requires_reconciliation`, uncertain);
    job = jobs.filter(item => RUNNABLE.has(item.state)).sort((a, b) => a.createdAt - b.createdAt)[0] ?? null;
    if (!job) {
      const policy = schedule.assess(accountId);
      if (!policy.eligible) return result('waiting', policy.reason, null, { policy });
      if (!Array.isArray(candidates) || candidates.length > 100) throw new Error('Invalid publishing candidates');
      if (typeof plan !== 'function') throw new Error('Publishing planner is required');
      phase = 'consider';
      let candidate;
      for (const offered of candidates) {
        if (!offered || !Number.isSafeInteger(offered.expiresAt) || offered.expiresAt <= clock(now)) continue;
        const claim = schedule.consider({ accountId, opportunityKey: offered.id, sourceFingerprint: offered.fingerprint,
          topicKey: offered.topicKey, expiresAt: offered.expiresAt, source: offered });
        if (claim.claimed) { job = claim.job; candidate = job.source; break; }
        if (!['already_considered', 'recent_topic', 'opportunity_expired'].includes(claim.reason)) {
          return result('waiting', claim.reason, claim.job, { policy: claim.policy });
        }
      }
      if (!job) return result('idle', 'no_new_opportunity');
      phase = 'planning';
      calls.model++;
      const proposal = checkedPlan(await plan({ candidates: [candidate], now: clock(now),
        recentPosts: jobs.filter(item => item.attemptedAt !== null && item.text).slice(0, 12)
          .reverse().map(item => ({ caption: item.text })) }), candidate);
      if (clock(now) >= job.expiresAt) {
        job = schedule.failBeforeDispatch(accountId, job.id, 'opportunity_expired_during_planning');
        return result(job.state, job.reason, job);
      }
      if (proposal.action === 'none') {
        job = schedule.decline(accountId, job.id, proposal.reason || 'model_declined');
        await emit({ event: 'moments_publishing_declined', accountId, jobId: job.id });
        return result('declined', 'model_declined', job);
      }
      job = schedule.select(accountId, job.id, { text: proposal.caption, imageKind: proposal.imageKind,
        imagePrompt: proposal.imagePrompt, visibility: 'friends' });
      await emit({ event: 'moments_publishing_selected', accountId, jobId: job.id, dueAt: job.dueAt });
      if (job.state !== 'selected') return result(job.state, job.reason, job);
    }

    // Recheck persisted jobs before paid image generation or dispatch, including
    // drafts created before this capability boundary was installed.
    if (gameParticipationViolation(`${job.text ?? ''}\n${job.imagePrompt ?? ''}`,
      { contextText: `${job.source?.title ?? ''} ${job.source?.summary ?? ''}` })) return expire('cannot_play_games');
    phase = 'budget';
    if (expired()) return expire('opportunity_expired');
    const policy = schedule.assess(accountId);
    job = schedule.get(accountId, job.id);
    const blocked = budgetReason(policy, clock(now));
    if (blocked) return result('waiting', blocked, job, { policy });

    if (job.state === 'selected') {
      if (clock(now) < job.dueAt - GENERATE_AHEAD_MS) return result('waiting', 'before_generation_window', job);
      if (!await isOnline(true)) return result('offline', 'offline', job);
      if (expired()) return expire('opportunity_expired_before_generation');
      if (typeof generate !== 'function') throw new Error('Publishing image generator is required');
      const claimed = schedule.claimGeneration(accountId, job.id);
      job = claimed.job;
      if (!claimed.claimed) return result('waiting', claimed.reason, job);
      phase = 'generation';
      calls.generation++;
      const asset = validateMomentAsset(await generate(job));
      // Verify local bytes as well as the generator's claimed metadata/digest.
      await readMomentAsset(asset);
      job = schedule.saveAsset(accountId, job.id, asset);
      if (expired()) return expire('opportunity_expired_after_generation');
      await emit({ event: 'moments_publishing_image_ready', accountId, jobId: job.id, sha256: asset.sha256 });
    }

    if (job.state === 'ready') {
      phase = 'draft';
      if (expired()) return expire('opportunity_expired_before_binding');
      await readMomentAsset(job.asset);
      const draft = checkedDraft(service.draft({ key: `auto-moment-${job.id}`, accountId,
        text: job.text, visibility: job.visibility, media: [job.asset] }), job, service, accountId);
      if (draft.state !== 'draft' || draft.attemptedAt !== null) {
        throw new Error('Publication ledger already contains an attempt');
      }
      job = schedule.bindPublication(accountId, job.id, { key: draft.key, digest: draft.digest });
    }
    if (job.state !== 'prepared') return result('waiting', `job_${job.state}`, job);
    if (expired()) return expire('opportunity_expired_before_dispatch');
    if (clock(now) < job.dueAt) return result('waiting', 'not_due', job);
    if (!await isOnline(true)) return result('offline', 'offline', job);
    phase = 'dispatch_validation';
    await readMomentAsset(job.asset);
    const draft = checkedDraft(service.get(job.publicationKey), job, service, accountId);
    if (draft.state !== 'draft' || draft.attemptedAt !== null) throw new Error('Publication ledger already contains an attempt');
    if (expired()) return expire('opportunity_expired_before_dispatch');
    const claim = schedule.beginDispatch(accountId, job.id);
    job = claim.job;
    if (!claim.claimed) return result('waiting', claim.reason, job, { policy: claim.policy });
    ownsDispatch = true;
    phase = 'publication';
    calls.publish++;
    const published = checkedDraft(await service.send(job.publicationKey, job.publicationDigest), job, service, accountId);
    const outcome = ['verified', 'accepted', 'rejected', 'needs_review'].includes(published.state)
      ? published.state : 'needs_review';
    job = schedule.settle(accountId, job.id, { state: outcome, momentId: published.momentId ?? null,
      reason: outcome === 'needs_review' ? 'publication_requires_reconciliation' : null });
    await emit({ event: 'moments_publishing_outcome', accountId, jobId: job.id, state: job.state, momentId: job.momentId });
    return result(job.state, job.reason ?? 'publication_completed', job);
  } catch (error) {
    // Persist uncertainty before returning; never call service.send/status here.
    if (job?.id) {
      try {
        job = schedule.get(accountId, job.id);
        if (job && ownsDispatch && job.attemptedAt !== null && !TERMINAL.has(job.state)) {
          job = schedule.settle(accountId, job.id, { state: 'needs_review', reason: `${phase}_failed` });
        } else if (job && ['evaluating', 'selected', 'generating', 'ready', 'prepared'].includes(job.state)) {
          job = schedule.failBeforeDispatch(accountId, job.id, `${phase}_failed`);
        }
      } catch { /* A database failure leaves the prior durable claim in place. */ }
    }
    await emit({ event: 'moments_publishing_error', accountId, jobId: job?.id ?? null, phase,
      errorName: /^[A-Za-z][A-Za-z0-9_]{0,60}$/u.test(error?.name ?? '') ? error.name : 'Error' });
    return result(job?.state ?? 'error', `${phase}_failed`, job);
  }
}
