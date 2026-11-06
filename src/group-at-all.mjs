import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const positive=x=>/^[1-9]\d*$/.test(String(x??''))&&Number.isSafeInteger(Number(x));
const msgId=x=>/^-?[1-9]\d*$/.test(String(x??''))&&Number.isSafeInteger(Number(x));

// A deliberately narrow command grammar: questions, notes and quoted text are not actions.
export function parseGroupAtAll(event,{ownerQQ,groups=[]}={},now=Date.now()){
  if(event.message_type!=='group'||!positive(event.group_id)||!Array.isArray(event.message))return {handled:false};
  const text=event.message.filter(s=>s.type==='text').map(s=>s.data?.text||'').join(' ').normalize('NFKC').trim();
  const command=/^(?:(?:请|麻烦|帮我|给我|帮忙)\s*)*(?:艾特|@)\s*(?:一下\s*)?(?:全体成员|全体|所有人|大家)(?:\s*(?:一下|吧))?[。!！\s]*$/;
  if(!command.test(text))return {handled:false};
  const mentions=event.message.filter(s=>s.type==='at').map(s=>String(s.data?.qq||''));
  if(!positive(event.self_id)||!mentions.includes(String(event.self_id)))return {handled:false};
  if(event.message.some(s=>!['text','at'].includes(s.type))||mentions.some(x=>x!==String(event.self_id)))return {handled:true,silent:true};
  if(!groups.map(String).includes(String(event.group_id)))return {handled:true,reply:'该群未开放艾特全体功能。'};
  if(!positive(ownerQQ)||String(event.user_id)!==String(ownerQQ))return {handled:true,reply:'仅主人可下达艾特全体指令。'};
  const at=Number(event.time)*1000;
  if(!msgId(event.message_id)||!Number.isFinite(at)||now-at>300000||at-now>60000)return {handled:true,reply:'指令编号或时间无效，请发送新指令。'};
  return {handled:true,group:String(event.group_id),actor:String(event.user_id),self:String(event.self_id),messageId:String(event.message_id),expiresAt:at+300000};
}

export class GroupAtAllService{
  constructor({file,getMember,getQuota,send,allowed=()=>true,timeoutMs=12000,now=Date.now}){
    if(file!==':memory:'){
      fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.chmodSync(path.dirname(file),0o700);
    }
    this.db=new DatabaseSync(file);this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS actions(group_id TEXT,message_id TEXT,actor TEXT,state TEXT,created INTEGER,updated INTEGER,receipt TEXT,PRIMARY KEY(group_id,message_id));`);
    if(file!==':memory:')fs.chmodSync(file,0o600);
    // Never resume a process interrupted during checking or an ambiguous external write.
    this.db.prepare("UPDATE actions SET state=CASE WHEN state='sending' THEN 'uncertain' ELSE 'interrupted' END,updated=? WHERE state IN ('checking','sending')").run(now());
    Object.assign(this,{getMember,getQuota,send,allowed,timeoutMs,now});this.chains=new Map();
  }
  close(){this.db.close();}
  async deadline(job){let timer;try{return await Promise.race([job,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),this.timeoutMs);})]);}finally{clearTimeout(timer);}}
  mark(c,state,receipt=null){this.db.prepare('UPDATE actions SET state=?,updated=?,receipt=? WHERE group_id=? AND message_id=?').run(state,this.now(),receipt,c.group,c.messageId);}
  async execute(event,config){
    const c=parseGroupAtAll(event,config,this.now());if(!c.handled||c.silent||c.reply)return c;
    // Serialize checks and dispatch per group, including independent messages racing for quota.
    const previous=this.chains.get(c.group)||Promise.resolve();
    const work=previous.catch(()=>{}).then(()=>this.perform(c));const tail=work.catch(()=>{});
    this.chains.set(c.group,tail);try{return await work;}finally{if(this.chains.get(c.group)===tail)this.chains.delete(c.group);}
  }
  async perform(c){
    const prior=this.db.prepare('SELECT state FROM actions WHERE group_id=? AND message_id=?').get(c.group,c.messageId);
    if(prior)return {handled:true,duplicate:true,state:prior.state};
    this.db.prepare('INSERT INTO actions VALUES(?,?,?,?,?,?,NULL)').run(c.group,c.messageId,c.actor,'checking',this.now(),this.now());
    let sending=false;
    try{
      if(!this.allowed(c)||this.now()>c.expiresAt)throw Error('权限或指令状态已变化，未执行。');
      const member=await this.deadline(this.getMember(c.group,c.self));
      if(String(member?.user_id)!==c.self||(member.group_id!=null&&String(member.group_id)!==c.group))throw Error('机器人群成员身份未核实，未执行。');
      if(!['owner','admin'].includes(member.role))throw Error('大肥鱼需要本群群主或管理员权限，未执行。');
      const q=await this.deadline(this.getQuota(c.group));
      const counts=[q?.remain_at_all_count_for_group,q?.remain_at_all_count_for_uin];
      if(q?.can_at_all!==true||counts.some(n=>!Number.isSafeInteger(n)||n<=0))throw Error('本群或账号的艾特全体权限/剩余次数不足，未执行。');
      if(!this.allowed(c)||this.now()>c.expiresAt)throw Error('权限或指令状态已变化，未执行。');
      this.mark(c,'sending');sending=true;
      // Persist before external dispatch; a timeout or missing receipt is never retried.
      const controller=new AbortController();
      let result;try{result=await this.deadline(this.send(c,controller.signal));}finally{controller.abort();}
      if(!msgId(result?.message_id))throw Error('receipt_missing');
      this.mark(c,'success',String(result.message_id));return {handled:true,state:'success'};
    }catch(error){
      this.mark(c,sending?'uncertain':'rejected');
      return {handled:true,state:sending?'uncertain':'rejected',reply:sending?'艾特全体发送结果未确认，请查看群消息；不会自动重试。':
        error.message.endsWith('未执行。')?error.message:'艾特全体权限或余量核验失败，未执行。'};
    }
  }
}
