import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFields } from '../packages/moments/protobuf.mjs';
import { parseTimelineReply, parseTimelineXml, timelineBody } from '../packages/moments/timeline.mjs';

const xml = `<TimelineObject><id>9001</id><username>wxid_author</username>` +
  `<createTime>1793812334</createTime><contentDesc>A &amp; B</contentDesc>` +
  `<private>0</private><ContentObject><contentStyle>1</contentStyle>` +
  `<mediaList><media><id>m1</id><type>2</type><description>图</description>` +
  `<url type="1" md5="0123456789abcdef0123456789abcdef">http://example.invalid/m.jpg</url>` +
  `<thumb type="1">http://example.invalid/t.jpg</thumb>` +
  `<size width="1080.000000" height="1920.000000" totalSize="12345"></size>` +
  `</media></mediaList></ContentObject>` +
  `<location poiName="某地" poiAddress="某路" poiClassifyType="0" city="上海"></location>` +
  `</TimelineObject>`;

const object = encodeFields([
  { number: 1, varint: 15047588497357935372n },
  { number: 2, bytes: 'wxid_author' },
  { number: 3, bytes: '作者' },
  { number: 4, varint: 1793812334 },
  { number: 5, bytes: encodeFields([{ number: 1, varint: Buffer.byteLength(xml) }, { number: 2, bytes: xml }]) },
  { number: 7, varint: 1 },
  { number: 8, varint: 1 },
  { number: 9, bytes: encodeFields([{ number: 1, bytes: 'wxid_like' }, { number: 2, bytes: '点赞人' },
    { number: 6, varint: 1793812400 }]) },
  { number: 12, bytes: encodeFields([{ number: 1, bytes: 'wxid_comment' }, { number: 2, bytes: '评论人' },
    { number: 5, bytes: '说得好' }, { number: 6, varint: 1793812500 }, { number: 7, varint: 33 }]) },
]);

const reply = encodeFields([
  { number: 1, bytes: encodeFields([{ number: 1, varint: 0 }]) },
  { number: 2, bytes: '0123456789abcdef' },
  { number: 3, varint: 1 },
  { number: 4, bytes: object },
]);

test('timeline body carries maxId and minId after the daemon-supplied BaseRequest', () => {
  assert.equal(timelineBody(), '18002000');
  assert.equal(timelineBody({ maxId: 5, minId: 7 }), '18052007');
});

test('timeline XML exposes text, media, location and decoded entities', () => {
  const parsed = parseTimelineXml(xml);
  assert.equal(parsed.text, 'A & B');
  assert.equal(parsed.username, 'wxid_author');
  assert.equal(parsed.media.length, 1);
  assert.equal(parsed.media[0].url, 'http://example.invalid/m.jpg');
  assert.equal(parsed.media[0].md5, '0123456789abcdef0123456789abcdef');
  assert.equal(parsed.media[0].width, 1080);
  assert.equal(parsed.media[0].bytes, 12345);
  assert.equal(parsed.location.name, '某地');
});

test('timeline reply keeps author, likes and comments with their own identities', () => {
  const parsed = parseTimelineReply(reply);
  assert.equal(parsed.baseCode, 0);
  assert.equal(parsed.firstPageMd5, '0123456789abcdef');
  assert.equal(parsed.count, 1);
  assert.equal(parsed.objects.length, 1);
  const moment = parsed.objects[0];
  assert.equal(moment.id, '15047588497357935372');
  assert.deepEqual(moment.author, { id: 'wxid_author', name: '作者' });
  assert.equal(moment.text, 'A & B');
  assert.equal(moment.createTime, 1793812334);
  assert.equal(moment.media[0].thumbUrl, 'http://example.invalid/t.jpg');
  assert.deepEqual(moment.likes, [{ userId: 'wxid_like', name: '点赞人', createTime: 1793812400 }]);
  assert.equal(moment.comments.length, 1);
  assert.equal(moment.comments[0].userId, 'wxid_comment');
  assert.equal(moment.comments[0].text, '说得好');
  assert.equal(moment.comments[0].commentId, '33');
});

test('a non-zero base code is rejected instead of normalized', () => {
  assert.throws(() => parseTimelineReply(encodeFields([
    { number: 1, bytes: encodeFields([{ number: 1, varint: 5 }, { number: 2, bytes: 'denied' }]) },
  ])), /base code 5/u);
});
