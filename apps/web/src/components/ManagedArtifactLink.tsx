import {useState,type ReactNode,type MouseEvent} from 'react';
import {getManagedArtifactContent} from '../services/api';

/** Fetches the exact version through the Owner session instead of opening the JSON API. */
export function ManagedArtifactLink({id,href,children}:{id:string;href:string;children:ReactNode}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function download(event:MouseEvent<HTMLAnchorElement>){
    event.preventDefault();if(busy)return;setBusy(true);setError('');
    try{
      const result=await getManagedArtifactContent(id),bytes=Uint8Array.from(atob(result.contentBase64),value=>value.charCodeAt(0));
      const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'})),link=document.createElement('a');
      link.href=url;link.download=result.file.path.split('/').at(-1)??'artifact';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{setBusy(false);}
  }
  return <span><a href={href} aria-disabled={busy} onClick={event=>void download(event)}>{busy?'正在读取文件…':children}</a>{error&&<span role="alert" className="ml-2 text-xs text-red-300">{error}</span>}</span>;
}
