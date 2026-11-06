import {transferError} from './transfer-download.mjs';
export function createTransferApi({enabled,tokenOk,sessionAllowed,getService}){
  function access(key,token){
    if(!/^group:[1-9]\d*$/.test(String(key))||!token||!enabled()||!tokenOk(key,token)||!sessionAllowed(key))throw transferError('该会话不可用',403);
    const service=getService();if(!service)throw transferError('文件交付模块未就绪，请联系主人',503);
    return service;
  }
  return {
    submit(body,token){return access(body.key,token).submit(body);},
    status(key,token,jobId){return access(key,token).status(key,jobId);}
  };
}
