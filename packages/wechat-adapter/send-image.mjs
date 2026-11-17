import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const encode = value => encodeURIComponent(value);

async function uploadSource(client, path) {
  const form = new FormData();
  form.append('file', new Blob([readFileSync(path)], { type: 'image/jpeg' }), basename(path));
  const response = await fetch(`${client.origin}/v1/accounts/${encode(client.accountId)}/uploads`, {
    method: 'POST', headers: { Authorization: `Bearer ${client.token}` }, body: form,
    signal: AbortSignal.timeout(120000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`image upload failed: HTTP ${response.status}`);
  const source = await response.json();
  if (typeof source?.id !== 'string' || !source.id) throw new Error('image upload returned no source id');
  return source.id;
}

async function sendStatus(client, id) {
  const response = await fetch(
    `${client.origin}/v1/accounts/${encode(client.accountId)}/sends/${encode(id)}`, {
      headers: { Authorization: `Bearer ${client.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30000), redirect: 'error',
    });
  if (!response.ok) throw new Error(`image send status failed: HTTP ${response.status}`);
  return response.json();
}

export async function sendImageWithStandard(client, { threadId, imagePath, standardPath = null,
  key, timeoutMs = 180000 } = {}) {
  if (typeof threadId !== 'string' || !threadId) throw new Error('Image send needs a thread');
  if (typeof key !== 'string' || !key) throw new Error('Image send needs an idempotency key');
  const sourceId = await uploadSource(client, imagePath);
  // Let the native sender prepare a separate preview when none is supplied.
  const standardSourceId = standardPath ? await uploadSource(client, standardPath) : null;
  const response = await fetch(`${client.origin}/v1/accounts/${encode(client.accountId)}/sends`, {
    method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${client.token}`, Accept: 'application/json',
      'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ threadId, kind: 'image', sourceId, standardSourceId,
      thumbnailSourceId: null }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`image send failed: HTTP ${response.status}`);
  let job = await response.json();
  const terminal = value => value?.phase === 'completed' || value?.phase === 'failed' ||
    ['needs_review', 'cancelled', 'failed'].includes(value?.state);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (terminal(job)) return job;
    await new Promise(resolve => setTimeout(resolve, 1000));
    job = await sendStatus(client, job.id);
  }
  return job;
}
