import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { findVoiceRequest } from '../src/tts-access.mjs';
import { createTtsService } from '../src/tts-service.mjs';
import { synthesizeCosyVoice } from '../src/cosyvoice-client.mjs';
import { DEFAULT_DELIVERY, normalizeDelivery, instructionUnits } from '../src/tts-delivery.mjs';
const twoCharacterBudget = (2 + instructionUnits(DEFAULT_DELIVERY)) * 0.8 / 10000;

function fixture(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bigfish-tts-test-'));
  let currentTime = Date.parse('2026-10-26T08:00:00Z');
  const settings = { enabled: true, model: 'cosyvoice-v3.5-flash', voiceId: 'fixture-voice', rate: 1,
    maxChars: 100, maxSeconds: 30, maxPerMinute: 2, maxPerHour: 10, pricePer10kYuan: 0.8, monthlyBudgetYuan: 30 };
  const calls = { synthesize: 0, send: 0 };
  const options = { stateFile: path.join(directory, 'ledger.json'), cacheDir: path.join(directory, 'cache'),
    getSettings: () => settings, getCredentials: () => ({ apiKey: 'fixture-key', workspaceId: 'fixture-workspace' }),
    now: () => currentTime,
    synthesize: async () => { calls.synthesize++; return { audio: Buffer.alloc(100) }; },
    inspect: async () => ({ ok: true, duration: 5 }),
    send: async () => { calls.send++; return { messageId: 123, verified: true }; }, ...overrides };
  const args = { key: 'group:123', sourceMessageId: 'one', text: '你好',
    authorize: ref => ({ sourceId: ref, userId: '456' }), audit: () => {} };
  return { directory, options, settings, calls, args, service: createTtsService(options), advance: delta => { currentTime += delta; } };
}

test('源消息鉴权：群友真实@可用，私聊限主人，拒绝伪造/过期/否定请求', () => {
  const now = Date.now();
  const message = { messageId: '55', seq: 8, userId: '456', time: now, atSelf: true, plain: '用语音回复我一句你好' };
  const call = (patch = {}, key = 'group:123') => findVoiceRequest({ key, ownerQQ: '111', sourceMessageId: '55', messages: [{ ...message, ...patch }], now });
  assert.equal(call().userId, '456');
  assert.equal(call({ atSelf: false }), null);
  assert.equal(call({ isSelf: true }), null);
  assert.equal(call({ time: now - 301000 }), null);
  assert.equal(call({ time: now + 1 }), null);
  assert.equal(call({ plain: '不要发语音，文字就好' }), null);
  assert.equal(call({ plain: '今天什么天气' }), null);
  assert.equal(call({}, 'private:456'), null);
  assert.equal(call({ userId: '111' }, 'private:111').userId, '111');
  assert.equal(findVoiceRequest({ key: 'group:123', ownerQQ: '111', sourceMessageId: 'not-present', messages: [message], now }), null);
});

test('拒绝未授权来源、超长文本及审计失败，不调用云模型', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  await assert.rejects(f.service.say({ ...f.args, authorize: () => null }), /来源消息|语音请求/);
  await assert.rejects(f.service.say({ ...f.args, text: '字'.repeat(101) }), /100字/);
  await assert.rejects(f.service.say({ ...f.args, audit: () => { throw Object.assign(new Error('审计拦截'), { statusCode: 403 }); } }), /审计拦截/);
  assert.equal(f.calls.synthesize, 0); assert.equal(f.service.usage().reservedChars, 0);
});

test('并发重试只合成发送一次，重启后仍保持幂等', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const result = await Promise.all([f.service.say(f.args), f.service.say(f.args)]);
  assert.equal(result[0].messageId, 123); assert.equal(result[1].messageId, 123);
  const restarted = createTtsService(f.options);
  assert.equal((await restarted.say(f.args)).duplicate, true);
  assert.equal(f.calls.synthesize, 1); assert.equal(f.calls.send, 1);
});

test('全局预算先预留并持久化，缓存免费且受每会话限流', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  f.settings.monthlyBudgetYuan = twoCharacterBudget;
  await f.service.say(f.args);
  await f.service.say({ ...f.args, sourceMessageId: 'two' });
  assert.equal(f.calls.synthesize, 1); assert.equal(f.calls.send, 2);
  await assert.rejects(f.service.say({ ...f.args, sourceMessageId: 'three' }), /频率超限/);
  f.advance(61000);
  await assert.rejects(f.service.say({ ...f.args, sourceMessageId: 'three', text: '不同文字' }), /预算/);
  assert.equal(createTtsService(f.options).usage().reservedChars, 2);
});

test('其他会话无法复用私聊缓存，费用是全局共享', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  f.settings.monthlyBudgetYuan = twoCharacterBudget;
  await f.service.say(f.args);
  await assert.rejects(f.service.say({ ...f.args, key: 'group:789' }), /预算/);
  assert.equal(f.calls.synthesize, 1);
});

test('北京月份切换后使用新月额度，不按服务器UTC月份计账', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  f.settings.monthlyBudgetYuan = twoCharacterBudget;
  await f.service.say(f.args);
  f.advance(Date.parse('2026-10-31T16:00:00Z') - Date.parse('2026-10-26T08:00:00Z'));
  await f.service.say({ ...f.args, sourceMessageId: 'new-month', text: '新月' });
  assert.equal(f.service.usage().month, '2026-11'); assert.equal(f.service.usage().reservedChars, 2);
});

test('云调用失败保留保守费用，不向模型泄露内部错误，不盲目重试', async t => {
  const f = fixture({ synthesize: async () => { throw new Error('fixture-secret /srv/private.json'); } });
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  await assert.rejects(f.service.say(f.args), error => !error.message.includes('fixture-secret') && !error.message.includes('/srv/'));
  assert.equal(f.service.usage().reservedChars, 2);
  await assert.rejects(createTtsService(f.options).say(f.args), /不重发/);
});

test('发送状态未知不能重发，重启仍拒绝重复请求', async t => {
  const f = fixture({ send: async () => { throw new Error('socket ended after request'); } });
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  await assert.rejects(f.service.say(f.args), /发送状态未确认/);
  await assert.rejects(createTtsService(f.options).say(f.args), /不重发/);
});

test('超时长音频不发送，合成期间撤销权限也不发送', async t => {
  const f = fixture({ inspect: async () => ({ ok: true, duration: 31 }) });
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  await assert.rejects(f.service.say(f.args), /超过30秒/); assert.equal(f.calls.send, 0);
  const g = fixture({ synthesize: async () => { g.settings.enabled = false; return { audio: Buffer.alloc(100) }; } });
  t.after(() => fs.rmSync(g.directory, { recursive: true, force: true }));
  await assert.rejects(g.service.say(g.args), /关闭|变化/); assert.equal(g.calls.send, 0);
});

test('损坏的持久化额度记录失败关闭', t => {
  const f = fixture(); t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  fs.writeFileSync(f.options.stateFile, '{bad-json');
  assert.throws(() => createTtsService(f.options), /记录损坏/);
});

test('WebSocket协议完整结束后才返回音频，握手鉴权与任务ID一致', async () => {
  const sent = [];
  class Socket extends EventEmitter {
    constructor(url, options) {
      super(); assert.match(url, /^wss:\/\/fixture-workspace\.cn-beijing\.maas\.aliyuncs\.com\//);
      assert.equal(options.headers.Authorization, 'Bearer fixture-key');
      queueMicrotask(() => this.emit('open'));
    }
    terminate() {}
    send(raw) {
      const message = JSON.parse(raw); sent.push(message);
      if (message.header.action === 'run-task') queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ header: { event: 'task-started', task_id: message.header.task_id } })), false));
      if (message.header.action === 'finish-task') queueMicrotask(() => {
        this.emit('message', Buffer.alloc(100), true);
        this.emit('message', Buffer.from(JSON.stringify({ header: { event: 'task-finished', task_id: message.header.task_id } })), false);
      });
    }
  }
  const result = await synthesizeCosyVoice({ apiKey: 'fixture-key', workspaceId: 'fixture-workspace', model: 'cosyvoice-v3.5-flash', voiceId: 'fixture-voice', text: '你好', WebSocketImpl: Socket });
  assert.equal(result.audio.length, 100);
  assert.deepEqual(sent.map(message => message.header.action), ['run-task', 'continue-task', 'finish-task']);
  assert.equal(new Set(sent.map(message => message.header.task_id)).size, 1);
});

test('WebSocket失败正文不会向模型透露密钥，提前断开不能成功', async () => {
  class Socket extends EventEmitter {
    constructor() { super(); queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ header: { event: 'task-failed', error_message: 'fixture-key' } })), false)); }
    terminate() {}
  }
  await assert.rejects(synthesizeCosyVoice({ apiKey: 'fixture-key', workspaceId: 'fixture-workspace', model: 'cosyvoice-v3.5-flash', voiceId: 'fixture-voice', text: '你好', WebSocketImpl: Socket }), error => !error.message.includes('fixture-key'));
});

test('语气指令按官方汉字双计数限制校验，空值使用自然克制的默认表达', () => {
  assert.equal(normalizeDelivery(), DEFAULT_DELIVERY);
  assert.equal(normalizeDelivery('  开心带笑意，轻快自然。  '), '开心带笑意，轻快自然。');
  assert.equal(instructionUnits('开心happy!'), 10);
  assert.equal(instructionUnits(normalizeDelivery('汉'.repeat(50))), 100);
  for (const value of ['汉'.repeat(51), '<开心>', '开心\n朗读', { mood: 'happy' }]) {
    assert.throws(() => normalizeDelivery(value), error => error.statusCode === 400);
  }
});

test('相同文本不同心情独立合成；相同语气命中缓存且费用包含保守指令预留', async t => {
  const received = [];
  const f = fixture({ synthesize: async args => { received.push(args); return { audio: Buffer.alloc(100) }; } });
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  const happy = '开心带笑意，语调轻快但自然。';
  const sad = '有点委屈又嘴硬，轻声，句尾稍缓。';
  const a = await f.service.say({ ...f.args, delivery: happy });
  const b = await f.service.say({ ...f.args, sourceMessageId: 'two', delivery: sad });
  assert.equal(a.delivery, happy); assert.equal(b.delivery, sad);
  assert.equal(received.length, 2); assert.equal(received[0].instruction, happy);
  assert.equal(received[0].text, f.args.text);
  f.advance(61000);
  const c = await f.service.say({ ...f.args, sourceMessageId: 'three', delivery: happy });
  assert.equal(c.cached, true); assert.equal(c.estimatedSynthesisYuan, 0); assert.equal(received.length, 2);
  const restarted = createTtsService(f.options);
  assert.equal(restarted.usage().reservedChars, 4);
  assert.equal(restarted.usage().reservedInstructionUnits, instructionUnits(happy) + instructionUnits(sad));
  assert.equal((await restarted.say({ ...f.args, delivery: sad })).delivery, happy);
});

test('过长或包含凭据的语气提示在云调用和预算预留之前拦截', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  await assert.rejects(f.service.say({ ...f.args, delivery: '汉'.repeat(51) }), /语气提示/);
  await assert.rejects(f.service.say({ ...f.args, delivery: '轻声朗读 /srv/private', audit: text => {
    if (text.includes('/srv/')) throw Object.assign(new Error('凭据审计拦截'), { statusCode: 403 });
  } }), /审计拦截/);
  assert.equal(f.calls.synthesize, 0); assert.equal(f.service.usage().estimatedReservedYuan, 0);
});

test('服务Umask0077下新合成音频仍允许共享组读取，账本保持私有', async t => {
  const mask = process.umask(0o077);
  const f = fixture();
  t.after(() => { process.umask(mask); fs.rmSync(f.directory, { recursive: true, force: true }); });
  await f.service.say(f.args);
  const audio = fs.readdirSync(f.options.cacheDir).find(name => name.endsWith('.wav'));
  assert.equal(fs.statSync(path.join(f.options.cacheDir, audio)).mode & 0o777, 0o640);
  assert.equal(fs.statSync(f.options.stateFile).mode & 0o777, 0o600);
});

test('WebSocket语气走instruction字段，朗读文字不混入语气描述', async () => {
  const sent = [];
  class Socket extends EventEmitter {
    constructor() { super(); queueMicrotask(() => this.emit('open')); }
    terminate() {}
    send(raw) {
      const message = JSON.parse(raw); sent.push(message);
      if (message.header.action === 'run-task') queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ header: { event: 'task-started', task_id: message.header.task_id } })), false));
      if (message.header.action === 'finish-task') queueMicrotask(() => {
        this.emit('message', Buffer.alloc(100), true);
        this.emit('message', Buffer.from(JSON.stringify({ header: { event: 'task-finished', task_id: message.header.task_id } })), false);
      });
    }
  }
  const instruction = '开心带笑意，轻快自然。';
  await synthesizeCosyVoice({ apiKey: 'fixture-key', workspaceId: 'fixture-workspace', model: 'cosyvoice-v3.5-flash', voiceId: 'fixture-voice', text: '你好呀。', instruction, WebSocketImpl: Socket });
  assert.equal(sent[0].payload.parameters.instruction, instruction);
  assert.deepEqual(sent[1].payload.input, { text: '你好呀。' });
});
