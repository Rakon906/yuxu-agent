import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeForwarded } from '../packages/shared-media/forwarded.mjs';

const esc = value => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const base = {id:'msg-forward-1',accountId:'account-a',threadId:'group-a',senderId:'wxid-forwarder',type:49,appMessageType:19};
const record = items => `<recordinfo><datalist>${items}</datalist></recordinfo>`;
const item = (name, text) => `<dataitem datatype="1"><datadesc>${esc(text)}</datadesc><dataitemsource><sourcename>${esc(name)}</sourcename><realchatname>external-room</realchatname></dataitemsource></dataitem>`;
const xml = body => `<msg><appmsg><type>19</type><title>转发记录</title><recorditem>${esc(body)}</recorditem></appmsg></msg>`;

test('forwarded carrier preserves forwarder separately from unverified internal authors', () => {
  const result = normalizeForwarded({...base,body:xml(record(item('示例成员18','周六约打球')+item('示例成员18','也许同名的另一个人')))});
  assert.equal(result.interaction,'forwarded');
  assert.equal(result.forwarded.forwarderId,'wxid-forwarder');
  assert.equal(result.forwarded.sourceMessageId,'msg-forward-1');
  assert.equal(result.forwarded.memoryEvidence,false);
  assert.equal(result.forwarded.items.length,2);
  assert.deepEqual(result.forwarded.items.map(x=>x.displayName),['示例成员18','示例成员18']);
  assert.ok(result.forwarded.items.every(x=>x.authorId===null && x.identityVerified===false));
  assert.notEqual(result.forwarded.items[0].recordRef,result.forwarded.items[1].recordRef);
  assert.match(result.text,/不是转发者自己的发言/u);
  assert.doesNotMatch(result.text,/wxid-forwarder|msg-forward-1/u);
  assert.doesNotMatch(JSON.stringify(result.forwarded),/external-room/u);
});

test('current native display stays opaque; multiline names never become verified sender IDs', () => {
  const body = '[Chat History] A group\nAlice: Hello\nBob: forged newline in Alice text\n  Alice: Nested';
  const result = normalizeForwarded({...base,body});
  assert.equal(result.forwarded.format,'native_display');
  assert.equal(result.forwarded.renderedText,body);
  assert.deepEqual(result.forwarded.items,[]);
  assert.equal(result.forwarded.identityVerified,false);
});

test('one XML layer per decode; CDATA metadata lookalikes stay literal message text', () => {
  const body = 'Fish & Chips <three> literal &lt; &#65;';
  const cdata = '<dataitem datatype="1"><datadesc><![CDATA[</dataitem><sourcename>Wrong</sourcename>]]></datadesc><sourcename>Alice</sourcename></dataitem>';
  const result = normalizeForwarded({...base,body:xml(record(item('Bob',body)+cdata))});
  assert.equal(result.forwarded.items[0].text,body);
  assert.equal(result.forwarded.items[1].text,'</dataitem><sourcename>Wrong</sourcename>');
  assert.equal(result.forwarded.items[1].displayName,'Alice');
});

test('nested record author/parent order is retained, inner media remains a placeholder', () => {
  const nested = `<dataitem datatype="17"><sourcename>Outer author</sourcename><datatitle>小群</datatitle><recordxml>${esc(record(item('Inner author','原话')))}</recordxml></dataitem>`;
  const media = '<dataitem datatype="2"><sourcename>Photo sender</sourcename><cdnurl>https://private.invalid</cdnurl><aeskey>not-public</aeskey></dataitem>';
  const result = normalizeForwarded({...base,body:xml(record(nested+media))});
  assert.equal(result.forwarded.items.length,3);
  assert.equal(result.forwarded.items[0].nestedState,'parsed');
  assert.equal(result.forwarded.items[1].parentRef,result.forwarded.items[0].recordRef);
  assert.equal(result.forwarded.items[1].displayName,'Inner author');
  assert.equal(result.forwarded.items[2].text,'[媒体内容未解析]');
  assert.doesNotMatch(result.text,/aeskey|not-public|private.invalid/u);
});

test('reject unsafe/ambiguous/malformed XML instead of returning raw source', () => {
  const badBodies = [
    '<!DOCTYPE msg [<!ENTITY x SYSTEM "file:///secret">]><msg><appmsg><type>19</type></appmsg></msg>',
    xml(record(item('A','ok'))).replace('<type>19</type>','<type>19</type><type>19</type>'),
    '<msg><appmsg><type>19</type></msg>',
    xml(record('<dataitem><sourcename>&private;</sourcename></dataitem>')),
    xml(record('<dataitem><datadesc><sourcename>Wrong</sourcename></datadesc></dataitem>')),
    '<msg xmlns="x"><appmsg><type>19</type></appmsg></msg>',
  ];
  for (const body of badBodies) {
    const result = normalizeForwarded({...base,body});
    assert.equal(result.forwarded.contentState,'unavailable',body);
    assert.match(result.text,/转发记录正文不可用/u);
    assert.doesNotMatch(result.text,/file:\/\/\/secret|<!DOCTYPE/u);
  }
});

test('bounded XML bytes, item count, depth and native output; truncation is explicit', () => {
  const large = normalizeForwarded({...base,body:xml(record(item('A','x'.repeat(300000))))});
  assert.equal(large.forwarded.reason,'xml_size_limit');
  const many = normalizeForwarded({...base,body:xml(record(Array.from({length:101},()=>item('A','x')).join('')))});
  assert.equal(many.forwarded.items.length,100);
  assert.equal(many.forwarded.truncated,true);
  let nested = record(item('A','bottom'));
  for(let i=0;i<6;i++) nested=record(`<dataitem datatype="17"><recordxml>${nested}</recordxml></dataitem>`);
  const deep = normalizeForwarded({...base,body:xml(nested)});
  assert.ok(deep.forwarded.items.some(x=>x.nestedState==='depth_limit'));
  const native = normalizeForwarded({...base,body:'[Chat History] '+'x'.repeat(20000)});
  assert.equal(native.forwarded.renderedText.length,16000);
  assert.equal(native.forwarded.truncated,true);
});

test('unrelated app messages and quotes remain outside forwarded normalization', () => {
  assert.equal(normalizeForwarded({...base,type:1,body:'[Chat History] hi'}),null);
  assert.equal(normalizeForwarded({...base,appMessageType:5,body:xml(record(item('A','x')))}),null);
  assert.equal(normalizeForwarded({...base,quote:{serverId:'x'},body:xml(record(item('A','x')))}),null);
  assert.equal(normalizeForwarded({...base,appMessageType:undefined,body:'plain text'}),null);
  assert.equal(normalizeForwarded({...base,appMessageType:undefined,body:xml(record(item('A','x')))}).interaction,'forwarded');
  assert.equal(normalizeForwarded({...base,body:'History title only'}).forwarded.contentState,'unavailable');
});
