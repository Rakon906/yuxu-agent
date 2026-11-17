// Catch high-confidence personal put-downs before an optional group reply is sent.
// Context-sensitive teasing remains the model's job; this guard is a final backstop.
export function isNeedlesslyCruel(reply) {
  if (typeof reply !== 'string') return false;
  return /(?:下水道里捞|马桶里掏|遮羞布|脑子是租的|脑子.*?进水|嘴臭|垃圾话|你(?:有病|脑子有病)|帮你找个地缝|跟乌龟学的|养猪|发癫|管得挺宽|自我感觉良好.{0,16}叹为观止|你这脑洞.{0,12}搅拌机)/u.test(reply) ||
    /(?:你|您|他|她|[\p{Script=Han}]{1,4})这(?:嘴|脑子|智商|手速|水平).{0,18}(?:垃圾|恶心|废物|蠢|笨|臭|叹为观止)/u.test(reply);
}
