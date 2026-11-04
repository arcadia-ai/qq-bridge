import { createHash } from 'node:crypto';

const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const amount = value => typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) && value.length <= 64;
class BalanceError extends Error {
  constructor(message, statusCode) { super(message); this.statusCode = statusCode; }
}

// 只查询官方固定地址；凭据仅留在服务端，禁止跟随重定向发送给其他地址。
export function createDeepseekBalanceReader({ getApiKey, fetchImpl = fetch, now = Date.now }) {
  let cached = null;
  let pending = null;
  function error(message, statusCode = 502) { return new BalanceError(message, statusCode); }
  async function query(key, identity) {
    try {
      const response = await fetchImpl(BALANCE_URL, {
        method: 'GET', redirect: 'error',
        headers: { accept: 'application/json', authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status)) throw error('DeepSeek余额查询凭据被拒绝，请检查服务器上的API Key', 503);
        if (response.status === 429) throw error('DeepSeek余额查询触发频率限制，请稍后再查', 503);
        throw error('DeepSeek余额接口暂时不可用，请稍后重试');
      }
      const body = await response.json();
      if (typeof body?.is_available !== 'boolean' || !Array.isArray(body.balance_infos)) throw error('DeepSeek余额响应格式异常');
      const balances = body.balance_infos.map(info => {
        if (!['CNY', 'USD'].includes(info?.currency) || !['total_balance', 'granted_balance', 'topped_up_balance'].every(k => amount(info[k]))) {
          throw error('DeepSeek余额金额或币种格式异常');
        }
        return { currency: info.currency, total_balance: info.total_balance, granted_balance: info.granted_balance, topped_up_balance: info.topped_up_balance };
      });
      const data = { source: BALANCE_URL, is_available: body.is_available, balance_infos: balances, queried_at: new Date(now()).toISOString() };
      cached = { identity, at: now(), data };
      return { ...data, cached: false };
    } catch (err) {
      // 不透传网络/JSON原始异常或服务端错误正文，避免Key进入模型上下文。
      if (err instanceof BalanceError) throw err;
      throw error('DeepSeek余额查询失败，请检查网络或稍后重试');
    }
  }
  return {
    async read() {
      const key = getApiKey();
      if (typeof key !== 'string' || !key.trim()) throw error('服务器未配置DeepSeek余额查询凭据', 503);
      const identity = createHash('sha256').update(key).digest('hex');
      if (cached?.identity === identity && now() - cached.at < 30000) return { ...cached.data, cached: true };
      if (pending?.identity === identity) return pending.promise;
      const promise = query(key, identity);
      pending = { identity, promise };
      try { return await promise; } finally { if (pending?.promise === promise) pending = null; }
    }
  };
}
