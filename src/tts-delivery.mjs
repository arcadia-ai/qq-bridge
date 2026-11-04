export const DEFAULT_DELIVERY = '自然口语，随句意有轻微起伏，日常克制，不用播报腔。';

// 官方 instruction 上限 100 单位：汉字计 2，其他字符计 1。
export const instructionUnits = text => Array.from(text).reduce((sum, char) => sum + (/\p{Script=Han}/u.test(char) ? 2 : 1), 0);

export function normalizeDelivery(value) {
  if (value != null && typeof value !== 'string') throw invalid('语气提示需要简短普通文字');
  const delivery = value?.trim() || DEFAULT_DELIVERY;
  if (Array.from(delivery).length > 50 || instructionUnits(delivery) > 100
    || /[<>\u0000-\u001f\u007f]/.test(delivery)) {
    throw invalid('语气提示过长或格式有误，请用50字以内的普通短句描述情绪和说话方式');
  }
  return delivery;
}

const invalid = message => Object.assign(new Error(message), { statusCode: 400, publicSafe: true });
