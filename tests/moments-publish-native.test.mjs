import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { encodeFields, decodeMessage } from '../packages/moments/protobuf.mjs';
import { buildTextPostXml, buildTextPostBody, readPostXml, parsePostReply,
  buildPostXml, buildPostBody, validatePostDraft, validateUploadedMedia,
  parsePostIdentity, NativeMomentsPublisher } from '../packages/moments/publish-native.mjs';

const draft = { key: 'example', accountId: 'account-test', selfUserId: 'wxid_test',
  text: '摸鱼 & <休息> 😴\n换行', visibility: 'friends', createdAt: '2026-11-11T08:00:00.000Z',
  clientId: '1234567890abcdef1234567890abcdef', attemptedAt: 1794384000000 };
const momentId = '15047588497357935372';
const asset = { kind: 'image', path: fileURLToPath(new URL('../.runtime/example-moment.jpg', import.meta.url)),
  sha256: 'a'.repeat(64), md5: 'b'.repeat(32), width: 320, height: 240, bytes: 1234, mimeType: 'image/jpeg' };
const upload = { sha256: asset.sha256, md5: asset.md5, width: 320, height: 240, bytes: 1234,
  url: 'https://shmmsns.qpic.cn/sns/fixture-image/0', urlType: 1,
  thumbUrl: 'https://shmmsns.qpic.cn/sns/fixture-image/150', thumbType: 1 };
const imageDraft = { ...draft, media: [asset], uploadedMedia: [upload] };

// Outgoing official-client evidence: overall style1, media type2 and id0,
// type attributes from uploaded URLs, media/private0 independent of post privacy.
// Server-returned media IDs are assigned independently from the outgoing zero.
function imageXml({ contentStyle = 1, mediaType = 2, url = upload.url, thumbUrl = upload.thumbUrl,
  urlType = 1, thumbType = 1, width = '320.0', height = '240.0', bytes = '1234',
  md5 = '', count = 1, mediaId = '8234567' } = {}) {
  const media = `<media><id>${mediaId}</id><type>${mediaType}</type><url type="${urlType}"${md5 ? ` md5="${md5}"` : ''}>${url}</url>` +
    `<thumb type="${thumbType}">${thumbUrl}</thumb><size width="${width}" height="${height}" totalSize="${bytes}"/></media>`;
  return `<TimelineObject><id>${momentId}</id><username>${draft.selfUserId}</username><private>0</private>` +
    `<contentDesc><![CDATA[${draft.text}]]></contentDesc><ContentObject><contentStyle>${contentStyle}</contentStyle>` +
    `<mediaList>${media.repeat(count)}</mediaList></ContentObject></TimelineObject>`;
}

// Response layout independently established by the supported client's serializers:
// BaseResponse #1; SnsObject #2; object id #1, author #2, ObjectDesc #5.
// These fixtures test handling, not acceptance of a real publication.
function reply({ id = momentId, author = draft.selfUserId, text = draft.text,
  privacy = '0', code = 0, omitObject = false, xmlOverride } = {}) {
  const base = encodeFields([{ number: 1, varint: BigInt.asUintN(64, BigInt(code)) }]);
  if (omitObject || code !== 0) return encodeFields([{ number: 1, bytes: base }]).toString('hex');
  const xml = xmlOverride ?? `<TimelineObject><id>${id}</id><username>${author}</username>` +
    `<private>${privacy}</private><contentDesc><![CDATA[${text}]]></contentDesc></TimelineObject>`;
  const desc = encodeFields([{ number: 1, varint: Buffer.byteLength(xml) }, { number: 2, bytes: xml }]);
  const obj = encodeFields([{ number: 1, varint: BigInt(id) }, { number: 2, bytes: author }, { number: 5, bytes: desc }]);
  return encodeFields([{ number: 1, bytes: base }, { number: 2, bytes: obj }]).toString('hex');
}

async function fixture(t, handler) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    calls.push({ ...payload, path: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(await handler(payload, calls.length)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const client = new NativeMomentsPublisher({ baseUrl: `http://127.0.0.1:${server.address().port}`,
    token: 'fixture-token', accountId: draft.accountId, selfUserId: draft.selfUserId });
  return { client, calls };
}

test('text codec encodes UTF-8 buffer and escapes XML without adding a second BaseRequest', () => {
  const xml = buildTextPostXml(draft);
  assert.match(xml, /&amp; &lt;休息&gt;/u);
  assert.match(xml, /<contentStyle>2<\/contentStyle>/u);
  assert.equal(readPostXml(xml).text, draft.text);
  const fields = decodeMessage(Buffer.from(buildTextPostBody(draft), 'hex')).fields;
  assert.equal(fields.some(f => f.number === 1), false);
  assert.equal(fields.find(f => f.number === 2).message.find(f => f.number === 1).varint,
    String(Buffer.byteLength(xml)));
  assert.equal(fields.find(f => f.number === 7).text, draft.clientId);
  const privateDraft = { ...draft, visibility: 'private' };
  const privateFields = decodeMessage(Buffer.from(buildTextPostBody(privateDraft), 'hex')).fields;
  assert.equal(privateFields.find(f => f.number === 5).varint, '1');
  assert.equal(readPostXml(buildTextPostXml(privateDraft)).visibility, 'private');
});

test('text codec refuses unsupported payloads, invalid XML characters and invalid identities', () => {
  for (const changed of [{ text: '' }, { text: '\ud800' }, { text: 'a\u0000b' },
    { text: 'a'.repeat(5001) }, { visibility: 'selected' }, { media: [{}] },
    { media: false }, { media: {} }, { audience: 5 },
    { audience: ['friend'] }, { selfUserId: 'x<y' }]) {
    assert.throws(() => buildTextPostBody({ ...draft, ...changed }));
  }
});

test('XML verification preserves CDATA, literal entities, leading spaces and newlines', () => {
  const text = '  &#38; <private>1</private>\n😴  ';
  assert.equal(parsePostReply(reply({ text })).object.text, text);
  assert.equal(parsePostReply(reply({ text })).object.visibility, 'friends');
  assert.equal(readPostXml(buildTextPostXml({ ...draft, text: 'a\rb\nc' })).text, 'a\rb\nc');
  assert.throws(() => readPostXml('<!DOCTYPE x><TimelineObject/>'), /declaration/u);
  assert.throws(() => readPostXml('<TimelineObject><private>0</bad></TimelineObject>'), /Mismatched/u);
  for (const invalid of ['<username broken>', '<username/garbage>']) {
    assert.throws(() => readPostXml(buildTextPostXml(draft).replace('<username>', invalid)), /Invalid XML/u);
  }
});

test('receipt retains uint64 IDs exactly and distinguishes explicit rejection from missing object', () => {
  assert.equal(parsePostReply(reply()).momentId, momentId);
  assert.equal(parsePostReply(reply({ code: -1 })).baseCode, -1);
  assert.equal(parsePostReply(reply({ omitObject: true })).momentId, null);
  assert.throws(() => parsePostReply(''), /size/u);
  assert.throws(() => parsePostReply(reply({ id: '0' })), /object ID/u);
});

test('publication and verification use separate write/read requests on the same account', async t => {
  const f = await fixture(t, p => ({ cgi: p.cgi, baseCode: 0, replyHex: reply() }));
  const accepted = await f.client.publish(draft);
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.verified, undefined);
  const verified = await f.client.verify({ ...draft, momentId: accepted.momentId });
  assert.equal(verified.verified, true);
  assert.deepEqual(f.calls.map(c => [c.cgi, c.withBaseRequest, c.write]), [[209, true, true], [210, true, undefined]]);
  assert.ok(f.calls.every(c => c.path === '/v1/accounts/account-test/moments/probe'));
  assert.ok(f.calls.every(c => c.auth === 'Bearer fixture-token'));
  assert.equal(decodeMessage(Buffer.from(f.calls[1].bodyHex, 'hex')).fields[0].varint, momentId);
});

test('zero baseCode without object ID and daemon failure never mean accepted', async t => {
  const f = await fixture(t, (p, count) => count === 1
    ? { cgi: p.cgi, baseCode: 0, replyHex: reply({ omitObject: true }) }
    : { ok: false, detail: 'not supported' });
  assert.equal((await f.client.publish(draft)).state, 'needs_review');
  assert.equal((await f.client.publish(draft)).state, 'needs_review');
});

test('server rejection is reported explicitly', async t => {
  const f = await fixture(t, p => ({ cgi: p.cgi, baseCode: -1, replyHex: reply({ code: -1 }) }));
  assert.deepEqual(await f.client.publish(draft), { state: 'rejected', baseCode: -1, momentId: null });
});

test('verification rejects wrong author, text, visibility or object ID', async t => {
  const samples = [{ author: 'wxid_other' }, { text: 'different' }, { privacy: '1' }, { id: '1234' }];
  const f = await fixture(t, (p, count) => ({ cgi: p.cgi, baseCode: 0, replyHex: reply(samples[count - 1]) }));
  for (const _sample of samples) assert.equal((await f.client.verify({ ...draft, momentId })).verified, false);
  assert.ok(f.calls.every(c => c.cgi === 210 && !c.write));
});

test('a lost receipt is not recovered by fuzzy timeline matching or reposting', async t => {
  const f = await fixture(t, () => { throw new Error('Must not call network'); });
  assert.equal((await f.client.verify(draft)).reason, 'missing_receipt_id');
  await assert.rejects(() => f.client.publish({ ...draft, accountId: 'other-account' }), /identity mismatch/u);
  assert.equal(f.calls.length, 0);
});

test('conflicting response envelope and protobuf status are refused', async t => {
  const f = await fixture(t, p => ({ cgi: p.cgi, baseCode: 0, replyHex: reply({ code: -1 }) }));
  await assert.rejects(() => f.client.publish(draft), /status mismatch/u);
});

test('publisher rejects unsafe origins and unreasonable timeouts', () => {
  const options = { token: 't', accountId: draft.accountId, selfUserId: draft.selfUserId };
  assert.throws(() => new NativeMomentsPublisher({ ...options, baseUrl: 'http://example.com' }), /HTTPS/u);
  assert.throws(() => new NativeMomentsPublisher({ ...options, baseUrl: 'http://localhost:6174', timeoutMs: 0 }), /timeout/u);
});

test('an unfamiliar XML layout retains original response and a reliable receipt ID', async t => {
  const raw = reply({ xmlOverride: `<TimelineObject><id>${momentId}</id></TimelineObject>` });
  assert.equal(parsePostIdentity(raw).momentId, momentId);
  assert.throws(() => parsePostReply(raw), /XML/u);
  const f = await fixture(t, p => ({ cgi: p.cgi, baseCode: 0, replyHex: raw }));
  const saved = [];
  const result = await f.client.publish(draft, { onResponse: row => saved.push(row) });
  assert.equal(result.state, 'needs_review');
  assert.equal(result.momentId, momentId);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].phase, 'publish');
  assert.equal(JSON.parse(saved[0].responseBody).replyHex, raw);
  assert.equal(saved[0].responseBody.includes('fixture-token'), false);
  assert.equal(f.calls.length, 1);
});

test('response is captured before JSON parsing or HTTP error handling', async () => {
  for (const status of [200, 503]) {
    const saved = [];
    const client = new NativeMomentsPublisher({ baseUrl: 'http://localhost:6174', token: 'secret',
      accountId: draft.accountId, selfUserId: draft.selfUserId,
      fetchImpl: async () => new Response('malformed server response', { status }) });
    await assert.rejects(() => client.publish(draft, { onResponse: row => saved.push(row) }));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].responseBody, 'malformed server response');
    assert.equal(saved[0].httpStatus, status);
  }
});

test('failure to persist a received response never repeats the write request', async t => {
  const f = await fixture(t, p => ({ cgi: p.cgi, baseCode: 0, replyHex: reply() }));
  await assert.rejects(() => f.client.publish(draft, { onResponse: () => { throw new Error('disk full'); } }), /disk full/u);
  assert.equal(f.calls.length, 1);
});

test('receipt recovery requires an intact saved publishing response and a unique ID', () => {
  const client = new NativeMomentsPublisher({ baseUrl: 'http://localhost:6174', token: 't',
    accountId: draft.accountId, selfUserId: draft.selfUserId,
    fetchImpl: () => { throw new Error('Recovery must not call network'); } });
  const row = id => {
    const body = JSON.stringify({ cgi: 209, baseCode: 0, replyHex: reply({ id }) });
    return { phase: 'publish', http_status: 200, body, sha256: createHash('sha256').update(body).digest('hex') };
  };
  const saved = row(momentId);
  assert.equal(client.recoverReceipt(draft, [saved]).momentId, momentId);
  assert.equal(client.recoverReceipt(draft, [{ ...saved, sha256: 'wrong' }]), null);
  assert.equal(client.recoverReceipt(draft, [{ ...saved, phase: 'detail' }]), null);
  assert.equal(client.recoverReceipt(draft, [saved, row('123')]), null);
});

test('photo codec binds upload receipts and uses the supported photo XML shape', () => {
  const xml = buildPostXml({ ...imageDraft, visibility: 'private' });
  assert.match(xml, /<private>1<\/private><contentDesc>/u);
  assert.match(xml, /<contentStyle>1<\/contentStyle>/u);
  assert.match(xml, /<media><id>0<\/id><type>2<\/type>/u);
  assert.match(xml, /<private>0<\/private><userData><\/userData><subType>0<\/subType>/u);
  assert.match(xml, /<url type="1">https:\/\/shmmsns.qpic.cn\/sns\/fixture-image\/0<\/url>/u);
  assert.match(xml, /<size width="320" height="240" totalSize="1234"\/>/u);
  assert.equal(xml.includes('md5='), false); // The official photo upload XML omits this attribute.
  const fields = decodeMessage(Buffer.from(buildPostBody(imageDraft), 'hex')).fields;
  assert.deepEqual(fields.map(field => field.number), [2, 5, 7]); // Field4 is with-user names, not image data.
  assert.equal(fields[0].message.find(field => field.number === 2).text, buildPostXml(imageDraft));
  assert.throws(() => buildTextPostBody(imageDraft), /Only text/u);
});

test('upload proof must match the draft image and cannot be replaced with a path or chat receipt', () => {
  const change = values => ({ ...imageDraft, uploadedMedia: [{ ...upload, ...values }] });
  for (const value of [undefined, [], [{ fileId: 'chat-file-id' }]]) {
    assert.throws(() => buildPostBody({ ...imageDraft, uploadedMedia: value }), /receipt|mismatch/u);
  }
  for (const mismatch of [{ sha256: 'c'.repeat(64) }, { md5: 'd'.repeat(32) },
    { width: 321 }, { height: 241 }, { bytes: 1235 }]) assert.throws(() => buildPostBody(change(mismatch)), /mismatch/u);
  for (const mismatch of [{ url: 'file:///private.jpg' }, { url: 'https://user:password@host/image' },
    { url: 'https://host/image#fragment' }, { thumbUrl: '' }, { urlType: '1' }, { thumbType: -1 }]) {
    assert.throws(() => buildPostBody(change(mismatch)));
  }
  assert.throws(() => validatePostDraft({ ...imageDraft, media: [asset, asset] }), /one Moments image/u);
  assert.throws(() => validateUploadedMedia({ ...draft, uploadedMedia: [upload] }), /receipt/u);
  assert.equal(validatePostDraft({ ...imageDraft, uploadedMedia: undefined }).media.length, 1);
});

test('photo URL escaping is lossless and duplicate attributes or media containers are rejected', () => {
  const url = `${upload.url}?a=1&b=2`;
  const xml = buildPostXml({ ...imageDraft, uploadedMedia: [{ ...upload, url }] });
  assert.match(xml, /a=1&amp;b=2/u);
  assert.equal(readPostXml(xml).media[0].url, url);
  assert.throws(() => readPostXml(xml.replace('<url type="1">', '<url type="1" type="2">')), /Ambiguous/u);
  assert.throws(() => readPostXml(xml.replace('</mediaList>', '</mediaList><mediaList/>')), /ambiguous/u);
  assert.throws(() => readPostXml(xml.replace('width="320"', 'width="NaN"').replace('width="320"', 'width="NaN"')), /width/u);
});

test('photo receipt and detail verification require matching upload media references', async t => {
  const f = await fixture(t, p => ({ cgi: p.cgi, baseCode: 0, replyHex: reply({ xmlOverride: imageXml() }) }));
  const result = await f.client.publish(imageDraft);
  assert.equal(result.state, 'accepted');
  const detail = await f.client.verify({ ...imageDraft, momentId });
  assert.equal(detail.verified, true);
  assert.equal(parsePostReply(reply({ xmlOverride: imageXml() })).object.media[0].id, '8234567');
  assert.deepEqual(f.calls.map(call => call.cgi), [209, 210]);
});

test('photo verification rejects missing, extra, replaced, resized or unexpected media', async t => {
  const samples = [
    [{ count: 0 }, 'media_count_mismatch'], [{ count: 2 }, 'media_count_mismatch'],
    [{ contentStyle: 2 }, 'content_style_mismatch'], [{ mediaType: 1 }, 'media_type_mismatch'],
    [{ url: `${upload.url}?unproved=replacement` }, 'media_reference_mismatch'],
    [{ thumbUrl: `${upload.thumbUrl}/other` }, 'media_reference_mismatch'],
    [{ urlType: 2 }, 'media_reference_mismatch'], [{ thumbType: 2 }, 'media_reference_mismatch'],
    [{ width: '640' }, 'media_size_mismatch'], [{ height: '480' }, 'media_size_mismatch'],
    [{ bytes: '888' }, 'media_size_mismatch'], [{ md5: 'e'.repeat(32) }, 'media_md5_mismatch'],
  ];
  const f = await fixture(t, (p, count) => ({ cgi: p.cgi, baseCode: 0,
    replyHex: reply({ xmlOverride: imageXml(samples[count - 1][0]) }) }));
  for (const [, reason] of samples) {
    const checked = await f.client.verify({ ...imageDraft, momentId });
    assert.equal(checked.verified, false);
    assert.equal(checked.reason, reason);
  }
  assert.ok(f.calls.every(call => call.cgi === 210 && !call.write));
});

test('a text draft cannot be verified against a server object that unexpectedly contains an image', async t => {
  const f = await fixture(t, p => ({ cgi: p.cgi, baseCode: 0, replyHex: reply({ xmlOverride: imageXml() }) }));
  assert.equal((await f.client.verify({ ...draft, momentId })).reason, 'media_count_mismatch');
});

function savedImagePost(xml = imageXml()) {
  const body = JSON.stringify({ cgi: 209, baseCode: 0, replyHex: reply({ xmlOverride: xml }) });
  return { key: imageDraft.key, phase: 'publish', http_status: 200, body,
    sha256: createHash('sha256').update(body).digest('hex') };
}

test('rotated CDN paths require the exact accepted post media ID and original upload proof', async t => {
  const rotated = { url: 'https://shmmsns.qpic.cn/sns/rotated-reference/0',
    thumbUrl: 'https://shmmsns.qpic.cn/sns/rotated-reference/150' };
  const f = await fixture(t, p => ({ cgi: p.cgi, baseCode: 0, replyHex: reply({ xmlOverride: imageXml(rotated) }) }));
  const input = { ...imageDraft, momentId };
  const saved = savedImagePost();
  assert.equal((await f.client.verify(input, { publicationResponses: [saved] })).verified, true);
  for (const rows of [[], [{ ...saved, sha256: '0'.repeat(64) }], [{ ...saved, key: 'other-draft' }],
    [{ ...saved, phase: 'detail' }], [savedImagePost(imageXml({ url: `${upload.url}?wrong-upload` }))],
    [savedImagePost(imageXml({ mediaId: '0' }))], [saved, savedImagePost(imageXml({ mediaId: '999' }))]]) {
    assert.equal((await f.client.verify(input, { publicationResponses: rows })).verified, false);
  }
  assert.ok(f.calls.every(call => call.cgi === 210 && !call.write));
});

test('accepted media ID never authorizes changed content, dimensions, types or unsafe CDN addresses', async t => {
  const changes = [{ mediaId: '999' }, { width: '999' }, { bytes: '999' }, { md5: 'c'.repeat(32) },
    { urlType: 2 }, { thumbType: 2 }, { url: 'https://shmmsns.qpic.cn.evil.invalid/sns/image/0' },
    { url: 'https://shmmsns.qpic.cn:444/sns/image/0' }, { url: 'https://user@shmmsns.qpic.cn/sns/image/0' },
    { url: 'https://shmmsns.qpic.cn/sns/image/0#fragment' }];
  const f = await fixture(t, (p, count) => ({ cgi: p.cgi, baseCode: 0,
    replyHex: reply({ xmlOverride: imageXml({ url: 'https://shmmsns.qpic.cn/sns/rotated/0', ...changes[count - 1] }) }) }));
  for (const change of changes) {
    const result = await f.client.verify({ ...imageDraft, momentId }, { publicationResponses: [savedImagePost()] });
    assert.equal(result.verified, false, JSON.stringify(change));
  }
});
