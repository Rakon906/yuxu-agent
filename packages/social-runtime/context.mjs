import { createHash } from 'node:crypto';

const key = id => typeof id === 'string' && id
  ? `M_${createHash('sha256').update(id).digest('base64url').slice(0, 12)}` : null;
const short = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : null;
const array = value => Array.isArray(value) ? value : [];
const evidence = items => array(items).slice(-8).map(item => ({
  sourceMessageId: short(item.sourceMessageId, 2000), speakerKey: key(item.speakerId),
  at: short(item.at, 40), quote: short(item.quote, 300), action: short(item.action, 30),
}));

/** Only selected public fields cross the model boundary; transport IDs remain host-side. */
export function publicSocialContext(value = {}) {
  return {
    revision: Number.isSafeInteger(value?.revision) ? value.revision : null,
    activities: array(value?.activities).slice(0, 8).map(item => ({
      id: short(item.id), topic: short(item.topic, 120), organizerKey: key(item.organizerId),
      eventAt: short(item.eventAt, 40), day: short(item.day, 20), precise: item.precise === true,
      dateText: short(item.dateText, 40), timeText: short(item.timeText, 40), state: short(item.state, 30),
      revision: item.revision, lastSourceAt: short(item.lastSourceAt, 40),
      participants: array(item.participants).slice(0, 30).map(person => ({
        speakerKey: key(person.userId), state: short(person.state, 30),
      })), participantsTruncated: array(item.participants).length > 30,
      evidence: evidence(item.evidence),
    })),
    relationships: array(value?.relationships).slice(0, 8).map(item => ({
      id: short(item.id), speakerKeys: array(item.userIds).slice(0, 2).map(key),
      relationType: short(item.relationType, 30), status: short(item.status, 40), revision: item.revision,
      assertedBy: array(item.assertedBy).slice(0, 2).map(key), deniedBy: array(item.deniedBy).slice(0, 2).map(key),
      lastSourceAt: short(item.lastSourceAt, 40), evidence: evidence(item.evidence),
    })),
    members: array(value?.members).slice(0, 40).map(person => ({ speakerKey: key(person.userId),
      name: short(person.displayName, 80), preferredNames: array(person.preferredNames).slice(0, 8).map(name => short(name, 80)),
    })),
  };
}
