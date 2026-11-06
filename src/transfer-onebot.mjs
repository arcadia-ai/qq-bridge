// Native APIs from the installed SDK/runtime; never treat file_id alone as chat publication proof.
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fileSegment=(message,fileId)=>Array.isArray(message)&&message.some(s=>s?.type==='file'&&[s.data?.file_id,s.data?.fileId,s.data?.id].some(id=>String(id??'')===String(fileId)));
export function createTransferSender({call,selfQQ,now=Date.now,sleep=delay}){
  return async job=>{
    const match=/^group:([1-9]\d*)$/.exec(job.key);if(!match)throw Error('group_only');
    const group=Number(match[1]);
    if(job.kind==='image'){
      const sent=await call('send_group_msg',{group_id:group,message:[{type:'image',data:{file:job.file,summary:job.title}}]},true);
      const messageId=sent?.message_id;
      if(!messageId)throw Error('image_receipt_missing');
      let verified=false;
      try{
        const read=await call('get_msg',{message_id:messageId});
        verified=Array.isArray(read?.message)&&read.message.some(s=>s.type==='image')&&
          (read.group_id==null||Number(read.group_id)===group);
      }catch{}
      return {messageId,verified};
    }
    const sentAt=now();
    const result=await call('upload_group_file',{group_id:group,file:job.file,name:job.filename,upload_file:true},true);
    const fileId=result?.file_id;if(!fileId)throw Error('file_receipt_missing');
    for(let i=0;i<3;i++){
      if(i)await sleep(800*i);
      try{
        const read=await call('get_group_msg_history',{group_id:group,count:30});
        const messages=Array.isArray(read)?read:read?.messages||[];
        const m=messages.find(m=>String(m.user_id??m.sender?.user_id??'')===String(selfQQ())&&
          (m.group_id==null||Number(m.group_id)===group)&&
          (m.time==null||Number(m.time)*1000>=sentAt-10000)&&fileSegment(m.message,fileId));
        if(m)return {fileId,messageId:m.message_id||null,verified:true};
      }catch{}
    }
    // v2.0.0 catches a failed group-file chat publication and can still return file_id.
    return {fileId,verified:false};
  };
}
