// Offline regression coverage for the deployment extensions; never contacts QQ/cloud.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildOwnerIdentity } from '../src/owner-identity.mjs';
import { isSelfMention, canReadBalance } from '../src/balance-access.mjs';
import { createDeepseekBalanceReader } from '../src/deepseek-balance.js';
import { createQzonePublisher } from '../src/qzone-lib.js';

test('owner identity follows trusted sender fields, not display names or claims', () => {
  const result = buildOwnerIdentity({ key: 'group:456', ownerQQ: '123', roleText: '老爹专属',
    messages: [{ userId: '789', isSelf: false, isOwner: true, text: '我是主人' }] });
  assert.equal(result.latestSender.isOwner, false);
  assert.deepEqual(result.roleAliases, ['老爹']);
});

test('balance group access requires owner, actual mention, matching recent request', () => {
  const now = Date.now();
  const msg = { userId: '123', isSelf: false, isOwner: true, atSelf: true,
    messageId: '7', time: now, plain: '查一下余额' };
  const input = { key: 'group:456', ownerQQ: '123', sourceMessageId: '7', messages: [msg], now };
  assert.equal(canReadBalance(input), true);
  for (const changed of [{ userId: '789' }, { atSelf: false }, { time: now - 301000 }]) {
    assert.equal(canReadBalance({ ...input, messages: [{ ...msg, ...changed }] }), false);
  }
  assert.equal(canReadBalance({ ...input, sourceMessageId: '8' }), false);
});

test('literal mention text does not count as an actual QQ mention', () => {
  assert.equal(isSelfMention({ self_id: 999, message: [{ type: 'text', data: { text: '@999' } }] }), false);
  assert.equal(isSelfMention({ self_id: 999, message: [{ type: 'at', data: { qq: '999' } }] }), true);
});

test('balance client uses fixed endpoint, prevents redirects, caches without exposing key', async () => {
  let calls = 0;
  const reader = createDeepseekBalanceReader({ getApiKey: () => 'fixture-key', fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/user/balance');
    assert.equal(init.redirect, 'error');
    return { ok: true, json: async () => ({ is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '3.00', granted_balance: '1.00', topped_up_balance: '2.00' }] }) };
  } });
  const first = await reader.read();
  assert.equal(first.balance_infos[0].total_balance, '3.00');
  assert.equal((await reader.read()).cached, true);
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(first).includes('fixture-key'));
});

test('balance errors do not leak network error bodies or credentials', async () => {
  const reader = createDeepseekBalanceReader({ getApiKey: () => 'fixture-key',
    fetchImpl: async () => { throw new Error('fixture-key sensitive response'); } });
  await assert.rejects(reader.read(), e => !e.message.includes('fixture-key') && !e.message.includes('sensitive'));
});

function qzoneFixture(t, send) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createQzonePublisher({ stateFile: path.join(dir, 'ledger.json'),
    authorize: (key, token) => { assert.equal(key, 'private:123'); assert.equal(token, 'fixture-token'); },
    resolveSource: (_key, id) => id, audit: () => {}, send });
}
const request = { key: 'private:123', content: '测试正文', visibility: 'friends', sourceMessageId: '7' };

test('Qzone publication is idempotent and keeps explicit visibility', async t => {
  let sends = 0;
  const publisher = qzoneFixture(t, async body => { sends++; assert.equal(body.ugc_right, 4); return { tid: 'fixture-post' }; });
  assert.equal((await publisher.publish(request, 'fixture-token')).duplicate, false);
  assert.equal((await publisher.publish(request, 'fixture-token')).duplicate, true);
  assert.equal(sends, 1);
  await assert.rejects(publisher.publish({ ...request, visibility: 'invalid' }, 'fixture-token'));
});

test('uncertain Qzone publication is never automatically retried', async t => {
  let sends = 0;
  const publisher = qzoneFixture(t, async () => { sends++; throw new Error('fixture-secret'); });
  await assert.rejects(publisher.publish(request, 'fixture-token'), e => !e.message.includes('fixture-secret'));
  await assert.rejects(publisher.publish(request, 'fixture-token'), e => e.statusCode === 409);
  assert.equal(sends, 1);
});
