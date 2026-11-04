import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const positiveId=x=>/^[1-9]\d*$/.test(String(x)) && Number.isSafeInteger(Number(x));
export const MAX_MUTE_MINUTES=30*24*60;
const UNIT_MINUTES={分钟:1,小时:60,天:1440};
const DURATION_ERROR='禁言时长须为正整数分钟、小时或天，范围1分钟～30天，且只能写一个时长。';

function parseDuration(text,unmute){
  const times=[...text.matchAll(/(?<![A-Za-z\d./⁄∕,])([-+]?\d+(?:\.\d+)?)\s*(?:个\s*)?(分钟|小时|天)/g)];
  // Catch unsupported/mixed durations too, never silently read "1小时30分" as just one hour.
  const tokens=[...text.matchAll(/(?:[-+]?\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万半]+)\s*(?:个\s*)?(分钟|小时|天|秒钟|秒|周|星期|月|日|分|时)(?:半)?/g)];
  if(unmute)return times.length||tokens.length?{error:'解除禁言请不要附带禁言时长。'}:{minutes:0,durationText:''};
  const ambiguous=/\d+(?:\.\d+)?\s*[-~～—–至到]\s*\d+(?:\.\d+)?\s*(?:个\s*)?(分钟|小时|天)|(分钟|小时|天)\s*[-~～—–至到]\s*\d/.test(text)
    || /\d\s*[/⁄∕,:]\s*\d+\s*(?:个\s*)?(分钟|小时|天)|\d[eE][-+]?\d+\s*(分钟|小时|天)/.test(text)
    || /\d\s*(?:个\s*)?(分钟|小时|天)\s*半/.test(text);
  if(ambiguous||times.length!==1||tokens.length!==1)return {error:DURATION_ERROR};
  const amount=Number(times[0][1]),unit=times[0][2],minutes=amount*UNIT_MINUTES[unit];
  if(!Number.isSafeInteger(amount)||amount<1||!Number.isSafeInteger(minutes)||minutes>MAX_MUTE_MINUTES)return {error:DURATION_ERROR};
  return {minutes,durationText:`${amount}${unit}`};
}

// No model-supplied identities, nickname matching, CQ text or quoted messages.
export function parseGroupMute(event,{ownerQQ,groups=[]}={}) {
  if(event.message_type!=='group' || !positiveId(event.group_id) || !Array.isArray(event.message)) return {handled:false};
  const text=event.message.filter(s=>s.type==='text').map(s=>s.data?.text||'').join(' ').normalize('NFKC').replace(/−/g,'-').trim();
  // A note containing moderation words remains a note, never an admin action.
  if (/^(?:备忘|补记|(?:请)?(?:帮我)?(?:记住|记下|记一下|记录一下|记个备忘))/.test(text)) return {handled:false};
  if(!/禁/.test(text)) return {handled:false};
  const mentions=[...new Set(event.message.filter(s=>s.type==='at').map(s=>String(s.data?.qq||'')))];
  if(!positiveId(event.self_id) || !mentions.includes(String(event.self_id))) return {handled:false};
  if(!groups.map(String).includes(String(event.group_id))) return {handled:true,error:'该群未开放禁言功能。'};
  if(String(event.user_id)!==String(ownerQQ)) return {handled:true,error:'仅主人可下达禁言或解除禁言指令。'};
  if(event.message.some(s=>!['text','at'].includes(s.type)) || /[“”‘’「」『』"'`]|举例|例如|假设|假如|如果|要是|测试语句/.test(text)) return {handled:true,silent:true};
  const unmute=/解除禁言|取消禁言|解禁/.test(text);
  if(!unmute && !/禁(?:言|一下|他|她|它|个|\s|[-+\d零〇一二两三四五六七八九十百千万半]|$)/.test(text)) return {handled:false};
  const intention=text.replace(/解除禁言|取消禁言|解禁/g,'');
  if(/不要|别|不许|不准|不禁|不再禁|禁止|取消|撤销|勿|不想|不需要|不用|不必|无须|无需|不可以|不该|不应该/.test(intention)
    || /[?？]|能不能|能否|可不可以|行吗|好不好|行不行|可以不|要不要|是否|是不是|会不会|怎么|如何|为什么|[吗么呢]\s*[。！!]*$/.test(text)) return {handled:true,silent:true};
  const targets=mentions.filter(x=>x!==String(event.self_id));
  if(targets.length!==1 || !positiveId(targets[0])) return {handled:true,error:'请真实艾特大肥鱼及唯一一位目标群友。'};
  if(targets[0]===String(ownerQQ)) return {handled:true,error:'不对主人执行禁言操作。'};
  const duration=parseDuration(text,unmute);
  if(duration.error)return {handled:true,error:duration.error};
  const messageId=String(event.message_id??'');
  if(!messageId) return {handled:true,error:'缺少原始消息编号，未执行。'};
  const at=Number(event.time)*1000;
  if(!Number.isFinite(at) || Date.now()-at>300000 || at-Date.now()>60000) return {handled:true,error:'指令时间缺失或已过期，请发送一条新指令。'};
  return {handled:true,group:String(event.group_id),actor:String(event.user_id),self:String(event.self_id),target:targets[0],
    messageId,expiresAt:at+300000,action:unmute?'unmute':'mute',minutes:duration.minutes,durationText:duration.durationText};
}

export class GroupMuteService {
  constructor({file,getMember,ban,allowed=()=>true,timeoutMs=12000}) {
    if(file!==':memory:')fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(file);this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS actions(group_id TEXT,message_id TEXT,actor TEXT,target TEXT,action TEXT,minutes INTEGER,state TEXT,created INTEGER,updated INTEGER,PRIMARY KEY(group_id,message_id));`);
    if(file!==':memory:')fs.chmodSync(file,0o600);
    Object.assign(this,{getMember,ban,allowed,timeoutMs});
  }
  close(){this.db.close();}
  async deadline(job){
    let timer;
    try{return await Promise.race([job,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),this.timeoutMs);})]);}
    finally{clearTimeout(timer);}
  }
  mark(c,state){this.db.prepare('UPDATE actions SET state=?,updated=? WHERE group_id=? AND message_id=?').run(state,Date.now(),c.group,c.messageId);}
  async execute(event,config){
    const c=parseGroupMute(event,config);
    if(!c.handled || c.silent)return c;
    if(c.error)return {...c,reply:c.error};
    const prior=this.db.prepare('SELECT state FROM actions WHERE group_id=? AND message_id=?').get(c.group,c.messageId);
    if(prior)return {handled:true,duplicate:true,state:prior.state};
    this.db.prepare('INSERT INTO actions VALUES(?,?,?,?,?,?,?,?,?)').run(c.group,c.messageId,c.actor,c.target,c.action,c.minutes,'checking',Date.now(),Date.now());
    let sending=false;
    try{
      if(!this.allowed(c))throw Error('当前群或功能开关已不允许此操作。');
      const [bot,target]=await this.deadline(Promise.all([this.getMember(c.group,c.self),this.getMember(c.group,c.target)]));
      if(String(bot?.user_id)!==c.self || String(target?.user_id)!==c.target
        || [bot,target].some(x=>x.group_id!=null && String(x.group_id)!==c.group))throw Error('成员身份核验失败，未执行。');
      if(!['admin','owner'].includes(bot.role))throw Error('大肥鱼在本群没有管理员权限，未执行。');
      if(target.role!=='member')throw Error('目标是群主、管理员或权限未能确认，未执行。');
      if(!this.allowed(c) || Date.now()>c.expiresAt)throw Error('当前群或功能开关已变化，或指令已过期，未执行。');
      this.mark(c,'sending');sending=true;
      // Persist before invoking the remote action. Never retry an ambiguous outcome.
      await this.deadline(this.ban(c.group,c.target,c.minutes*60));
      this.mark(c,'success');
      return {handled:true,state:'success',reply:c.action==='unmute'?`已解除成员 ${c.target} 的禁言。`:`已禁言成员 ${c.target} ${c.durationText}。`};
    }catch(error){
      this.mark(c,sending?'uncertain':'rejected');
      return {handled:true,state:sending?'uncertain':'rejected',reply:sending?'禁言操作结果未确认，请查看群状态；不会自动重试。':
        (/未执行|管理员|开关/.test(error.message)?error.message:'成员权限核验失败，未执行。')};
    }
  }
}
