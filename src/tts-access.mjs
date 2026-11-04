// 请求依据来自网关入站记录，模型只传引用，不能自报身份或伪造群内 @。
export function findVoiceRequest({ key, ownerQQ, sourceMessageId, messages = [], now = Date.now() }) {
  if (!/^(group|private):\d+$/.test(key) || !sourceMessageId) return null;
  if (key.startsWith('private:') && key !== `private:${ownerQQ}`) return null;
  const source = messages.findLast(message => message && !message.isSelf
    && [message.messageId, message.seq].some(id => id != null && String(id) === String(sourceMessageId)));
  if (!source || !/^\d+$/.test(String(source.userId ?? ''))) return null;
  if (key.startsWith('group:') && source.atSelf !== true) return null;
  if (key.startsWith('private:') && String(source.userId) !== String(ownerQQ)) return null;
  const age = now - Number(source.time);
  if (!Number.isFinite(age) || age < 0 || age > 5 * 60_000) return null;
  const text = String(source.plain ?? source.text ?? '');
  const explicit = /(?:用|发|来|给|要|听|变|转|改|以).{0,8}语音|语音.{0,10}(?:回复|回答|说|念|读|讲|告诉|来|聊)|(?:读|念)(?:给我听|出来|一下|一遍)|(?:开口|出声)说/.test(text);
  if (!explicit || /(?:不要|别|不用|不必|禁止).{0,5}(?:发|用|来|给|转)?语音/.test(text)) return null;
  return { sourceId: String(source.messageId ?? source.seq), userId: String(source.userId) };
}
