// 每条主人指令只尝试发表一次；网络结果不明确时保留记录，禁止自动重发。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const RIGHTS = { public: 1, friends: 4, self: 64 };

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function createQzonePublisher({ stateFile, authorize, resolveSource, audit, send, log = () => {} }) {
  let entries = {};
  if (fs.existsSync(stateFile)) {
    // 日志损坏时不把它当空库，以免重启后重复发帖。
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (saved.version !== 1 || !saved.entries || typeof saved.entries !== 'object' || Array.isArray(saved.entries)) {
      throw new Error('说说发布记录格式错误');
    }
    entries = saved.entries;
  }
  const inflight = new Map();
  function persist() {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    const temp = `${stateFile}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ version: 1, entries }, null, 2) + '\n', { mode: 0o600, flush: true });
      fs.renameSync(temp, stateFile);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  function previousResult(entry) {
    if (entry.status !== 'published') {
      throw fail('这条指令已尝试发布，结果待核实；请先在小号空间确认，勿自动重试。', 409);
    }
    return { ok: true, duplicate: true, status: 'published', visibility: entry.visibility, tid: entry.tid, time: entry.time };
  }
  async function publish(body, token) {
    const { key, content, visibility, sourceMessageId } = body ?? {};
    authorize(key, token);
    if (typeof content !== 'string' || !content.trim() || content.length > 1000) throw fail('说说正文应为1至1000字');
    if (!Object.hasOwn(RIGHTS, visibility)) throw fail('请明确可见范围：public=公开、friends=好友、self=仅自己');
    if (typeof sourceMessageId !== 'string' || !sourceMessageId.trim()) throw fail('请提供主人发表指令的消息ID');
    const sourceId = resolveSource(key, sourceMessageId);
    audit(content);
    const id = crypto.createHash('sha256').update(`${key}:${sourceId}`).digest('hex');
    const digest = crypto.createHash('sha256').update(JSON.stringify([content.trim(), visibility])).digest('hex');
    if (entries[id]) {
      if (entries[id].digest !== digest) throw fail('该主人指令已有发布记录；更换正文需由主人发送新指令', 409);
      if (inflight.has(id)) return inflight.get(id);
      return previousResult(entries[id]);
    }
    const entry = { digest, status: 'pending', visibility, attemptedAt: new Date().toISOString() };
    entries[id] = entry;
    try { persist(); } catch (error) { delete entries[id]; throw error; }
    const operation = (async () => {
      try {
        const data = await send({ content: content.trim(), images: [], ugc_right: RIGHTS[visibility] });
        entry.status = 'published';
        entry.tid = data?.tid == null ? null : String(data.tid);
        entry.time = data?.time ?? null;
        persist();
        log(`[qzone] 发布成功 visibility=${visibility} tid=${entry.tid ?? '未返回'} request=${id.slice(0, 12)}`);
        return { ok: true, duplicate: false, status: 'published', visibility, tid: entry.tid, time: entry.time };
      } catch (error) {
        entry.status = 'unknown';
        try { persist(); } catch (saveError) { log(`[qzone] 发布状态保存失败: ${saveError.message}`); }
        // 不转发网关原始异常，防止异常中的 URL/凭据进入 QQ。
        log(`[qzone] 结果待核实 request=${id.slice(0, 12)} error=${error?.name || 'Error'}`);
        throw fail('发表说说失败或结果待核实；请查看小号空间确认后再发新指令，勿自动重复发布。', 502);
      }
    })();
    inflight.set(id, operation);
    try { return await operation; } finally { inflight.delete(id); }
  }
  return { publish };
}
