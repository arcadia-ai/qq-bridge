import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { normalizeDelivery } from './tts-delivery.mjs';

const cloudError = message => Object.assign(new Error(message), { publicSafe: true });

// 只接收服务端配置；QQ 工具不能指定模型、域名或云端凭据。
export async function synthesizeCosyVoice({ apiKey, workspaceId, model, voiceId, text, instruction, rate = 1, timeoutMs = 45000, WebSocketImpl = WebSocket }) {
  if (!apiKey || !/^[a-zA-Z0-9-]+$/.test(workspaceId ?? '') || !voiceId || model !== 'cosyvoice-v3.5-flash') {
    throw cloudError('云端语音配置未就绪');
  }
  const delivery = instruction === undefined ? undefined : normalizeDelivery(instruction);
  const taskId = randomUUID().replaceAll('-', '');
  const url = `wss://${workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`;
  return new Promise((resolve, reject) => {
    let socket, settled = false, bytes = 0, started = false;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.terminate(); } catch {}
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(cloudError('云端语音合成超时，本次不自动重试')), timeoutMs);
    const send = (action, payload) => socket.send(JSON.stringify({ header: { action, task_id: taskId, streaming: 'duplex' }, payload }));
    try {
      socket = new WebSocketImpl(url, { headers: { Authorization: `Bearer ${apiKey}` }, handshakeTimeout: 10000, maxPayload: 4 * 1024 * 1024, followRedirects: false });
      socket.on('error', () => finish(cloudError('云端语音连接失败，请稍后使用新消息请求')));
      socket.on('unexpected-response', (_request, response) => {
        response.resume();
        finish(cloudError([401, 403].includes(response.statusCode) ? '云端语音凭据或模型权限被拒绝' : '云端语音握手失败'));
      });
      socket.on('close', () => finish(cloudError('云端语音连接提前结束，本次不自动重试')));
      socket.on('open', () => {
        try {
          send('run-task', { task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model,
            parameters: { text_type: 'PlainText', voice: voiceId, format: 'wav', sample_rate: 24000, volume: 50, rate, pitch: 1, enable_ssml: false,
              ...(delivery === undefined ? {} : { instruction: delivery }) }, input: {} });
        } catch { finish(cloudError('云端语音任务启动失败')); }
      });
      socket.on('message', (data, isBinary) => {
        if (settled) return;
        try {
          if (isBinary) {
            bytes += data.length;
            if (bytes > 3 * 1024 * 1024) throw cloudError('合成音频超出短语音体积限制');
            chunks.push(Buffer.from(data));
            return;
          }
          const message = JSON.parse(String(data));
          if (message.header?.task_id && message.header.task_id !== taskId) throw cloudError('云端语音任务编号不匹配');
          const event = message.header?.event;
          if (event === 'task-started' && !started) {
            started = true;
            send('continue-task', { input: { text } });
            send('finish-task', { input: {} });
          } else if (event === 'task-finished') {
            if (!started || bytes < 44) throw cloudError('云端语音没有返回完整音频');
            finish(null, { audio: Buffer.concat(chunks), taskId });
          } else if (event === 'task-failed' || event === 'error') {
            // 不透传云端错误正文，避免凭据或其他原始字段进入模型上下文。
            throw cloudError('云端语音任务失败，请检查服务权限、音色状态或额度');
          }
        } catch (error) { finish(error instanceof SyntaxError ? cloudError('云端语音响应格式异常') : error); }
      });
    } catch { finish(cloudError('云端语音连接初始化失败')); }
  });
}
