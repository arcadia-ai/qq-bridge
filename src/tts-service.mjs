import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeDelivery, instructionUnits } from './tts-delivery.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const monthInShanghai = now => new Date(now + 8 * 3600_000).toISOString().slice(0, 7);
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

// 云端合成与 QQ 发送分开注入，便于验证额度、崩溃恢复和不确定发送状态。
export function createTtsService({ stateFile, cacheDir, getSettings, getCredentials, synthesize, inspect, send, now = Date.now, log = () => {} }) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  // 音频目录继承部署时的共享组，供容器内 QQ 进程只读；账本仍仅 root 可读。
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o750 });
  fs.chmodSync(cacheDir, 0o2750);
  let state = { version: 1, months: {}, jobs: {} };
  if (fs.existsSync(stateFile)) {
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (state.version !== 1 || !state.months || !state.jobs || Array.isArray(state.months) || Array.isArray(state.jobs)) throw new Error();
      for (const [month, value] of Object.entries(state.months)) {
        if (!/^\d{4}-\d{2}$/.test(month) || !Number.isSafeInteger(value.reservedChars) || value.reservedChars < 0
          || !Number.isSafeInteger(value.reservedMicros) || value.reservedMicros < 0
          || (value.reservedInstructionUnits !== undefined && (!Number.isSafeInteger(value.reservedInstructionUnits) || value.reservedInstructionUnits < 0))) throw new Error();
      }
      for (const job of Object.values(state.jobs)) {
        if (!job || !Number.isFinite(job.at) || typeof job.key !== 'string'
          || !['synthesizing', 'sending', 'sent', 'send_unknown', 'failed'].includes(job.status)) throw new Error();
      }
    } catch { throw fail('语音额度记录损坏，暂停合成，请管理员检查', 503); }
  }
  const pending = new Map();
  let busy = false;
  function save() {
    const temporary = `${stateFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, stateFile);
  }
  function settings() {
    const config = getSettings();
    if (!config?.enabled) throw fail('云端短语音已关闭', 403);
    return config;
  }
  function prune() {
    const cutoff = now() - 7 * 86400_000;
    for (const [id, job] of Object.entries(state.jobs)) if (job.at < cutoff) delete state.jobs[id];
    const files = fs.readdirSync(cacheDir).filter(name => /^[a-f0-9]{64}\.wav$/.test(name))
      .map(name => ({ name, modified: fs.statSync(path.join(cacheDir, name)).mtimeMs })).sort((a, b) => b.modified - a.modified);
    for (let i = 0; i < files.length; i++) if (i >= 256 || files[i].modified < cutoff) fs.unlinkSync(path.join(cacheDir, files[i].name));
  }
  async function perform({ key, sourceMessageId, text, delivery: requestedDelivery, authorize, audit }) {
    const config = settings();
    const source = authorize(sourceMessageId);
    if (!source) throw fail('需要本会话5分钟内的明确语音请求；群聊须真实@，请读取最近消息取得来源消息ID', 403);
    const id = digest(`${key}\n${source.sourceId}`);
    const existing = state.jobs[id];
    if (existing) {
      if (existing.status === 'sent') return { ...existing.result, duplicate: true };
      throw fail('该条语音请求已处理或曾中断，本次不重发；如仍需要，请发送一条新的语音请求', 409);
    }
    if (busy) throw fail('正在处理另一条语音，请稍后使用新消息请求', 429);
    const spoken = String(text ?? '').trim();
    const chars = Array.from(spoken).length;
    if (!chars || chars > config.maxChars) throw fail(`短语音请控制在${config.maxChars}字以内，长回复改发文字`);
    if (/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(spoken)) throw fail('语音只接受普通短文本');
    const delivery = normalizeDelivery(requestedDelivery);
    audit(spoken);
    audit(delivery);
    const styleUnits = instructionUnits(delivery);
    const credentials = getCredentials();
    if (!credentials.apiKey || !credentials.workspaceId || !config.voiceId) throw fail('云端语音配置未就绪', 503);
    prune();
    const timestamp = now();
    const recent = Object.values(state.jobs).filter(job => job.key === key && timestamp - job.at < 3600_000);
    if (recent.filter(job => timestamp - job.at < 60_000).length >= config.maxPerMinute || recent.length >= config.maxPerHour) {
      throw fail(`语音请求频率超限（本会话${config.maxPerMinute}条/分钟、${config.maxPerHour}条/小时）`, 429);
    }
    const cacheHash = digest(JSON.stringify({ key, model: config.model, voiceId: config.voiceId, rate: config.rate, instruction: delivery, text: spoken }));
    const file = path.join(cacheDir, `${cacheHash}.wav`);
    const cached = fs.existsSync(file);
    const month = monthInShanghai(timestamp);
    const unitMicros = Math.ceil(config.pricePer10kYuan * 100);
    // 将语气指令也计入保守费用预留，实际账单以云端为准。
    const reserveMicros = cached ? 0 : (chars + styleUnits) * unitMicros;
    const current = state.months[month] ?? { reservedChars: 0, reservedMicros: 0 };
    if (current.reservedMicros + reserveMicros > Math.floor(config.monthlyBudgetYuan * 1e6)) throw fail('本月语音合成预算已用完，改用文字回复', 429);
    busy = true;
    state.months[month] = { reservedChars: current.reservedChars + (cached ? 0 : chars), reservedMicros: current.reservedMicros + reserveMicros,
      reservedInstructionUnits: (current.reservedInstructionUnits ?? 0) + (cached ? 0 : styleUnits) };
    const job = { key, sourceId: source.sourceId, at: timestamp, status: 'synthesizing', chars, delivery, instructionUnits: styleUnits, reservedMicros: reserveMicros, cached };
    state.jobs[id] = job;
    try {
      // 先落盘预留费用：网络中断时不盲目退费，重启后也不能绕过预算。
      save();
      if (!cached) {
        const result = await synthesize({ ...credentials, model: config.model, voiceId: config.voiceId, text: spoken, instruction: delivery, rate: config.rate });
        if (!Buffer.isBuffer(result.audio) || result.audio.length < 44 || result.audio.length > 3 * 1024 * 1024) throw fail('云端短语音返回的音频不完整', 502);
        fs.writeFileSync(file, result.audio, { mode: 0o640 });
      }
      // systemd UMask=0077 会收紧创建模式，写入后明确允许共享组读取音频。
      fs.chmodSync(file, 0o640);
      const info = await inspect(file, { maxSeconds: config.maxSeconds, maxBytes: 3 * 1024 * 1024 });
      if (!info.ok || !Number.isFinite(info.duration) || info.duration <= 0 || info.duration > config.maxSeconds) {
        try { fs.unlinkSync(file); } catch {}
        throw fail('合成音频超过30秒或未通过检查，请缩短文字后使用新消息请求', 422);
      }
      if (!settings().enabled || !authorize(sourceMessageId)) throw fail('语音请求已过期或权限已变化，改用文字回复', 403);
      audit(spoken);
      audit(delivery);
      job.status = 'sending';
      save();
      const result = await send(key, file, spoken);
      job.status = 'sent';
      job.result = { ok: true, key, sent: true, messageId: result.messageId, verified: result.verified === true,
        seconds: info.duration, characters: chars, delivery, instructionUnits: styleUnits, cached, estimatedSynthesisYuan: reserveMicros / 1e6 };
      save();
      log(`[tts] ${key} sent chars=${chars} cached=${cached} seconds=${info.duration.toFixed(2)}`);
      return job.result;
    } catch (error) {
      // 发送可能已经到达 QQ，任何不确定状态都不自动重试。
      const sent = job.status === 'sent';
      job.status = sent ? 'sent' : job.status === 'sending' ? 'send_unknown' : 'failed';
      try { save(); } catch {}
      if (sent) throw fail('语音已发送，但记账写入失败，请勿重复发送；请管理员检查存储', 503);
      if (job.status === 'send_unknown') throw fail('语音发送状态未确认，本次不会自动重发，请改用文字回复', 502);
      throw error.statusCode ? error : fail(error.publicSafe ? error.message : '云端合成或音频检查失败，请改用文字回复', 502);
    } finally { busy = false; }
  }
  return {
    async say(args) {
      const source = args.authorize(args.sourceMessageId);
      if (!source) throw fail('需要本会话5分钟内明确的语音请求；群聊须真实@并提供来源消息ID', 403);
      const identity = digest(`${args.key}\n${source.sourceId}`);
      if (pending.has(identity)) return pending.get(identity);
      const promise = perform(args);
      pending.set(identity, promise);
      try { return await promise; } finally { pending.delete(identity); }
    },
    requestStatus(key, sourceId) {
      return state.jobs[digest(`${key}\n${sourceId}`)]?.status ?? null;
    },
    usage() {
      const month = monthInShanghai(now());
      const value = state.months[month] ?? { reservedChars: 0, reservedMicros: 0 };
      return { month, reservedChars: value.reservedChars, reservedInstructionUnits: value.reservedInstructionUnits ?? 0, estimatedReservedYuan: value.reservedMicros / 1e6 };
    }
  };
}
