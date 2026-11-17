export const GROUP_TOPIC_CATEGORIES = new Set(['游戏', '电竞', '旅游', '美食']);

// 具体词只放能明确指向话题的：不放「游戏」「吃饭」「好玩」这类泛词，否则每个人、每条消息都会被命中。
export const TOPIC_TERMS = {
  游戏: ['英雄联盟', 'lol', '瓦罗兰特', '无畏契约', 'valorant', '三角洲', '王者荣耀', '原神',
    '黑神话', 'steam', '单机', '绝地求生', '永劫无间', '我的世界', '塞尔达', '艾尔登法环',
    'csgo', 'cs2', 'dota', '幻兽帕鲁'],
  电竞: ['lpl', 'lck', 'kpl', 'msi', 's赛', '世界赛', '电竞', 'vct', '季后赛', '小组赛',
    '战队', 'bo5'],
  旅游: ['旅游', '旅行', '自驾', '景区', '出游', '机票', '民宿', '签证', '露营', '徒步'],
  美食: ['美食', '火锅', '烧烤', '探店', '小吃', '菜谱', '餐厅', '奶茶', '咖啡', '甜品',
    '夜宵', '面馆', '烤肉', '螺蛳粉'],
};

const normalizeText = value => String(value ?? '').normalize('NFKC').toLowerCase();

export function matchTopics(text) {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const hits = [];
  for (const [topic, terms] of Object.entries(TOPIC_TERMS)) {
    for (const term of terms) {
      if (normalized.includes(term)) hits.push({ topic, term });
    }
  }
  return hits;
}

export function isGroupTopic(text) {
  return matchTopics(text).length > 0;
}
