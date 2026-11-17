import { createHash } from 'node:crypto';

const casualKinds = new Set(['ordinary', 'followup', 'mention']);
const nonConversationKinds = new Set(['life_event', 'interest_update', 'plan']);
const discussedVoice = /语音|嗓音|声线|声音|音色|念出来|读出来/u;
const reportedSpeech = /(?:他说|她说|别人说|朋友说|同事说|有人说|转述|转发|引用)|[“”「」『』"]|^\s*>/u;
const narratedVoice = /(?:他|她|朋友|同事|同学|别人|有人|人家).{0,8}(?:发|回|用).{0,6}语音|(?:昨天|刚才|刚刚|之前|已经|刚).{0,6}(?:发|回|用).{0,6}语音|(?:我|俺|我们).{0,4}(?:发|回|用).{0,6}语音/u;
const textIntent = /(?:别|不要|不用|不想|不需要|不方便|不爱|不喜欢|不许|不能).{0,8}(?:语音|声音|念出来|读出来)|(?:语音|声音).{0,5}(?:不要|不用|别发|别用|不想听)|(?:用|改成|换成|发|回|打).{0,3}(?:文字|字回复)|(?:文字|打字).{0,4}(?:就好|就行|回复|回答)|(?:别|不要).{0,4}说话/u;
const voiceIntent = /(?:发|回|来|用).{0,6}语音|(?:想听|听听|听一下|想听听).{0,6}(?:声音|嗓音)|语音.{0,4}(?:回|说|答)|(?:念|读)出来(?:给我听)?/u;
const structuredText = /https?:\/\/|www\.|\[[^\]\n]+\]\([^\n]+\)|`|(?:^|\n)\s*(?:\$|PS\s+[A-Z]:|(?:const|let|var|def|function|class)\s)|(?:=>|<\/?[a-z][^>]*>)|[{}][;\n]/iu;
const contactOrNumbers = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|\d{4,}|(?:\d[\s-]){5,}\d|(?:手机号|电话号码|身份证|银行卡|验证码|微信号|QQ号|账号|密码)/iu;
// This is intentionally a conservative delivery-format rule, not a general safety classifier.
const seriousTopic = /(?:住院|手术|急诊|确诊|重病|去世|葬礼|自杀|自残|报警|诈骗|性骚扰|性侵|家暴|身份证|银行卡|验证码|密码|合同|欠款|还款|借款)/u;
const no = reason => ({ selected: false, reason });

/**
 * Pick a delivery format for an already-approved reply; this never creates a reply.
 * sourceRows must be the current task's chronological, host-scoped original rows,
 * not retrieved history or model-authored summaries. A quoted/relayed row cannot
 * authorize voice. Text length uses UTF-16 units, matching the synthesis boundary.
 */
export function chooseVoiceReply({ text, sourceRows = [], addressed = false, kind,
  isQuestion = false, key, probability = 0.15 } = {}) {
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError('Voice probability must be a finite number from 0 to 1');
  }
  if (typeof text !== 'string' || !text.trim()) return no('empty_reply');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) return no('invalid_reply_text');
  const reply = text.trim();
  if (!/[\p{L}\p{N}]/u.test(reply)) return no('non_spoken_reply');
  if (structuredText.test(reply)) return no('structured_text');
  if (contactOrNumbers.test(reply)) return no('contact_or_numbers');
  if (nonConversationKinds.has(kind)) return no('non_conversation_task');

  let lastIntent = null, anyTextIntent = false, voiceDiscussed = false, serious = seriousTopic.test(reply);
  for (const row of Array.isArray(sourceRows) ? sourceRows : []) {
    if (!row || typeof row.text !== 'string') continue;
    voiceDiscussed ||= discussedVoice.test(row.text);
    serious ||= seriousTopic.test(row.text);
    if (!['text', 'voice', undefined].includes(row.interaction) || row.quote ||
        (row.interaction === 'voice' && row.voiceState !== 'done') || reportedSpeech.test(row.text) ||
        row.recalled || row.revoked || row.deleted || ['recalled', 'revoked', 'deleted'].includes(row.state)) continue;
    if (textIntent.test(row.text)) {
      lastIntent = 'text';
      anyTextIntent = true;
    } else if (!narratedVoice.test(row.text.replace(/(?:给我|帮我|替我|为我)/gu, '')) && voiceIntent.test(row.text)) lastIntent = 'voice';
  }
  if (lastIntent === 'text') return no('explicit_text');
  // A direct request can override the short casual/question defaults, but not
  // structured content, serious subjects or a non-conversation initiative.
  if (serious) return no('serious_topic');
  if (lastIntent === 'voice') {
    if (addressed !== true) return no('voice_not_addressed');
    if (text.length > 160) return no('explicit_voice_too_long');
    return { selected: true, reason: 'explicit_voice' };
  }
  if (anyTextIntent) return no('current_turn_text_preference');
  if (voiceDiscussed) return no('voice_discussion_without_request');
  if (!casualKinds.has(kind)) return no('non_casual_kind');
  if (isQuestion !== false) return no('question_requires_text');
  if (text.length > 80) return no('random_voice_too_long');
  if (probability === 0) return no('random_disabled');
  if (typeof key !== 'string' || !key || key.length > 8192 || /[\u0000-\u001f]/u.test(key)) return no('missing_stable_key');
  const digest = createHash('sha256').update('sociomem-voice-selection-v1\0').update(key).digest();
  const draw = Number(digest.readBigUInt64BE(0) >> 11n) / 9007199254740992;
  return { selected: draw < probability, reason: draw < probability ? 'random_voice' : 'random_text' };
}
