// Capability boundary, not a ban on game topics. Only output text is inspected;
// context is the current target/topic, never the entire long-term chat history.
export const GAME_PARTICIPATION_BOUNDARY = '肥鱼不能亲自打游戏，包括三角洲及任何其他电子游戏；不能上号、加入队伍、担任队友、陪打、带人上分，也不能编造自己的游戏账号、段位、战绩或亲自游玩的经历。可以讨论游戏、看比赛、围观、给群友助威或帮他们约局。被邀请时自然说明自己不能亲自参加，再根据语境接话，不必重复固定解释。可以转述群友的邀约，但不能附加自己上号或参战的承诺。';

const games = '(?:三角洲(?:行动)?|石家庄|英雄联盟|王者(?:荣耀)?|和平精英|永劫无间|无畏契约|瓦洛兰特|原神|星穹铁道|崩铁|绝区零|绝地求生|吃鸡|守望先锋|魔兽|穿越火线|逆水寒|第五人格|鸣潮|游戏|LOL|DOTA(?:2)?|PUBG|CS(?:2|GO)?|Valorant|Delta\\s*Force)';
const gameContext = new RegExp(`${games}|开黑|排位|上分|游戏队友|上号|开一把|打[一两几]把|yyrjy`, 'iu');
const self = '(?:本公主|本鱼|肥鱼不肥|肥鱼|我(?:们|俩)?)';
const actions = `(?:上号|开黑|打排位|上分|组队|开[一两几]把|(?:当|做|成为)(?:你们?的?|群友的?|大家的?)?队友|(?:打|玩)(?:过|了|着)?(?:${games}|[一两几]把|[一两几]局)|(?:陪|带)你们?.{0,4}(?:打${games}|开黑|上分|打[一两几]把))`;
const selfAction = new RegExp(`${self}([^，,。！？!?；;\n]{0,18}?)(${actions})`, 'giu');
const contextualSelfAction = new RegExp(`${self}([^，,。！？!?；;\n]{0,16}?)(上线|打过|玩过|打了|玩了|来打|来玩|陪你们?打|陪你们?玩|带你们?飞|补位|进队|开一局|来一把|不太会[打玩])`, 'giu');

function textOf(value) {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/gu, '').trim() : '';
}

function withoutReportedQuotes(value) {
  return value.replace(/[“「『"]([^”」』"\n]{1,400})[”」』"]/gu, (whole, body, offset) => {
    const before = value.slice(Math.max(0, offset - 45), offset);
    // Explicit third-person attribution or discussing a phrase. A quoted promise
    // from the agent itself remains a promise and is still checked.
    if (/(?:他说|她说|你说|群友说|有人说|对方说|(?:示例成员47|示例成员9|群友|他们|她们|对方|有人|你|他|她).{0,8}(?:说|问|喊|写)(?:过|了|的是)?[：:]?)$/u.test(before) ||
        /(?:这句|那句|这句话|别说|不要说|不要回复|不要讲|不能说|不能回复|例如这句)[：:]?$/u.test(before)) return '「转述」';
    return whole;
  });
}

function isNegated(lead, tail) {
  if (/(?:不是不|不是不能|不是不会|并非不能|并非不会|并不是不能)/u.test(lead)) return false;
  return /(?:不能|无法|没法|不会|不可以|不方便|不打算|不想|不愿意|不参与|不|没)(?:亲自|自己|实际|真的|直接|再|去|和你|跟你|陪你){0,3}$/u.test(lead) ||
    /^(?:不了|不成|不了啦)/u.test(tail);
}

function refersToOthers(lead) {
  return /(?:建议|觉得|以为|希望|猜你|知道|听说|听你说|看你|看他们|看她们|看群友|看大家|围观|讨论|聊聊|问你|问大家|问问|喊你|喊他们|喊大家|叫你|叫他们|叫大家|劝你|等你|等他们|给你找|帮你找|帮大家找|这边有人)/u.test(lead);
}

function firstPersonAction(clause, pattern) {
  pattern.lastIndex = 0;
  for (const match of clause.matchAll(pattern)) {
    const lead = match[1];
    const tail = clause.slice(match.index + match[0].length);
    if (/(?:来打|陪你们?打)$/u.test(match[2]) && /^(?:电话|招呼|字|针|个比方|比方|水|工)/u.test(tail)) continue;
    if (!isNegated(lead, tail) && !refersToOthers(lead)) return true;
  }
  return false;
}

/**
 * Return a small non-content diagnostic, or null. This is intentionally a
 * backstop for explicit participation claims, not a semantic truth classifier.
 * The caller owns one bounded correction or a silent terminal outcome.
 */
export function gameParticipationViolation(text, { contextText = '' } = {}) {
  const value = withoutReportedQuotes(textOf(text));
  if (!value) return null;
  const relevant = gameContext.test(value) || gameContext.test(textOf(contextText));
  const clauses = value.split(/[，,。！？!?；;\n]|(?:但是|不过|可是|然而)/u).map(item => item.trim()).filter(Boolean);
  for (const clause of clauses) {
    if (firstPersonAction(clause, selfAction) || relevant && firstPersonAction(clause, contextualSelfAction)) {
      return { code: 'cannot_play_games', kind: 'first_person_action' };
    }
    // Asking others to play is allowed; inviting them to join the agent is not.
    if (relevant && /(?:跟我|和我|陪我|带我|拉我|加我|等我)(?:一起|一个|进队|入队|上线|上号|开黑|打|玩|来|吧|呀|啊|嘛|哦|哈|!|！|$)/u.test(clause) &&
        !/(?:别|不要|不用|不能|无法|没法).{0,4}(?:跟我|和我|陪我|带我|拉我|加我|等我)/u.test(clause) &&
        !/(?:跟我|和我|陪我).{0,2}(?:聊|讨论|看|围观)/u.test(clause)) {
      return { code: 'cannot_play_games', kind: 'game_invitation_acceptance' };
    }
    if (relevant && /^(?:(?:好|好啊|好呀|好嘞|行|行啊|可以|那|那就|嗯|来)[呀啊吧啦呢~～ ]*)*(?:我来|算我一个|带带我|带我一个|加我|拉我|等我|一起开黑|一起打[一两几]把)[呀啊吧啦呢~～ ]*$/u.test(clause)) {
      return { code: 'cannot_play_games', kind: 'game_invitation_acceptance' };
    }
    // Standalone agent promises may omit “我”. Do not match “你们赶紧上号”.
    if (relevant && /^(?:那|那就|这就|马上|立刻|等会儿?|一会儿?|今晚|明天|刚刚?|刚才|昨晚|昨天|正在|正想|想|手痒想|这两天有点手痒想|来|走|咱们|我们)(?:就|再|去|找人|一起|陪你们?|跟你们?|和你们?){0,3}(?:上号|上线|开黑|组队|打[一两几]把|来[一两几]把|玩[一两几]把|打三角洲|玩三角洲)/u.test(clause)) {
      return { code: 'cannot_play_games', kind: 'implicit_game_participation' };
    }
    if (relevant && /(?:正想|打算|准备|想)找人(?:打|玩)[一两几]把/u.test(clause) &&
        !/^(?:你|他|她|群友|大家).{0,6}(?:正想|打算|准备|想)找人/u.test(clause) &&
        !/(?:不|没)(?:打算|准备|想)/u.test(clause)) {
      return { code: 'cannot_play_games', kind: 'implicit_game_participation' };
    }
  }
  return null;
}
