// 仅使用 OneBot 入站消息的可信字段，拒绝模型传入的身份声明。
export function isSelfMention(event, selfId) {
  const target = String(event?.self_id ?? selfId ?? '');
  return Boolean(target) && Array.isArray(event?.message)
    && event.message.some(segment => segment?.type === 'at' && String(segment.data?.qq) === target);
}

export function canReadBalance({ key, ownerQQ, sourceMessageId, messages = [], now = Date.now() }) {
  if (!/^\d+$/.test(String(ownerQQ ?? ''))) return false;
  if (key === `private:${ownerQQ}`) return true;
  if (!/^group:\d+$/.test(key) || !sourceMessageId) return false;
  const source = messages.findLast(message => message && !message.isSelf);
  if (!source || !source.isOwner || String(source.userId) !== String(ownerQQ) || source.atSelf !== true) return false;
  if (![source.messageId, source.seq].some(id => id != null && String(id) === String(sourceMessageId))) return false;
  const age = now - Number(source.time);
  if (!Number.isFinite(age) || age < 0 || age > 5 * 60_000) return false;
  return /余额|balance|(?:剩|还|有).{0,12}(?:钱|金额|额度|多少米|几米|口粮|伙食费)|(?:查|查询|看看|看下).{0,12}(?:米|口粮|伙食费)/i.test(String(source.plain ?? source.text ?? ''));
}
