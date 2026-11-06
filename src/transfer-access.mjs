// Only authenticated gateway events may authorize a transfer; model-supplied names/roles never do.
const id=x=>/^-?[1-9]\d*$/.test(String(x??''));
const windowMs=15*60_000;
const ownText=m=>String(m.text??'').normalize('NFKC');
const cancelled=t=>/^(?:算了|不用了|取消了)[。！!\s]*$|(?:取消|停止|别|不要|不用|不必).{0,8}(?:下载|发送|发图|发文件|发包|发到群|传文件)|别下了|别发了/.test(t);

export function captureTransferSource(event,now=Date.now()){
  if(event.message_type!=='group'||!/^\d+$/.test(String(event.group_id))||!id(event.message_id)||!Array.isArray(event.message))return null;
  const time=Number(event.time)*1000;
  if(!Number.isFinite(time)||now-time>windowMs||time-now>60000)return null;
  const text=event.message.filter(s=>s.type==='text').map(s=>s.data?.text||'').join('').trim();
  if(!text||text.length>2000||event.message.some(s=>['forward','node','json','xml'].includes(s.type)))return null;
  const atSelf=event.message.some(s=>s.type==='at'&&String(s.data?.qq)===String(event.self_id));
  return {messageId:String(event.message_id),userId:String(event.user_id),text,time,atSelf,isSelf:String(event.user_id)===String(event.self_id)};
}
function intent(t){
  if(cancelled(t)||/^(?:备忘|补记|记一下|记住)|举例|例如|假设|测试语句/.test(t))return null;
  const action=/(?:下载|发|传|给|找|来|提供)/.test(t);
  if(!action)return null;
  if(/安装包|客户端|installer|setup|\.(?:exe|msi|apk|deb|dmg|appimage)\b/i.test(t))return {kind:'file',installer:true};
  if(/图片|照片|壁纸|截图|logo|一张.{0,8}图|张图|发图|找.{0,12}图/i.test(t))return {kind:'image',installer:false};
  if(/文件|压缩包|文档|PDF|zip|\.txt\b|\.md\b/i.test(t))return {kind:'file',installer:false};
  return null;
}
export function platformInText(text){
  const s=String(text).normalize('NFKC').toLowerCase();
  const os=/windows|\bwin(?:10|11|7|8|dows)?\b|电脑版.*64|\.exe\b|\.msi\b/.test(s)?'windows':
    /macos|\bmac\b|\.dmg\b/.test(s)?'macos':/安卓|android|\.apk\b/.test(s)?'android':
    /linux|ubuntu|debian|centos|rocky|appimage|\.deb\b|\.rpm\b/.test(s)?'linux':null;
  const arch=/arm64|aarch64|苹果芯片|apple\s*silicon|m[1-5]芯片/.test(s)?'arm64':
    /x86[_-]64|\bx64\b|amd64|64位|64\s*bit|intel芯片/.test(s)?'x64':/\bx86\b|32位|32\s*bit/.test(s)?'x86':null;
  return {os,arch};
}
export function findTransferRequest({key,sourceMessageId,kind,messages=[],now=Date.now()}){
  if(!/^group:[1-9]\d*$/.test(key)||!['file','image'].includes(kind))return null;
  const valid=m=>m&&!m.isSelf&&m.atSelf===true&&/^\d+$/.test(String(m.userId))&&now-m.time<=windowMs&&m.time-now<=60000;
  const index=messages.findLastIndex(m=>String(m.messageId)===String(sourceMessageId)&&valid(m));
  if(index<0)return null;
  const actor=messages[index].userId;
  for(let i=index;i>=0;i--){
    const m=messages[i];if(!valid(m)||m.userId!==actor)continue;
    const info=intent(ownText(m));if(!info)continue;
    if(info.kind!==kind)return null;
    const following=messages.slice(i).filter(x=>valid(x)&&x.userId===actor);
    if(following.some(x=>cancelled(ownText(x))))return null;
    return {sourceId:m.messageId,userId:actor,requestedAt:m.time,installer:info.installer,
      platform:platformInText(following.map(ownText).join('\n'))};
  }
  return null;
}
export function transferCancelled(messages,job){
  return messages.some(m=>!m.isSelf&&m.atSelf&&m.userId===job.actor&&m.time>=job.created-1000&&cancelled(ownText(m)));
}
export function assertInstallerPlatform(source,declared){
  if(!source.installer)return;
  const actual=source.platform,chosen=platformInText(declared);
  if(!actual.os||(actual.os!=='android'&&!actual.arch))throw Object.assign(Error('请先确认用户的系统与架构，例如Windows x64；可艾特补充后再用来源消息ID提交'),{statusCode:400});
  if(chosen.os!==actual.os||(actual.arch&&chosen.arch!==actual.arch))throw Object.assign(Error('安装包平台与用户实际指定的系统/架构不一致'),{statusCode:400});
}
