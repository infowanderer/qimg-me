import { useState } from 'react';
import { ArrowLeft, ArrowRight, Folder, FolderOpen, X } from 'lucide-react';
import { getGetMediaEntriesQueryKey, useGetMediaEntries } from '@workspace/api-client-react';
import type { MediaEntry } from '@workspace/api-client-react';

export default function TransferDialog({ operation, files, sourcePath, busy, error, onClose, onSubmit }: {
  operation:'copy'|'move'; files:MediaEntry[]; sourcePath:string; busy:boolean; error:string; onClose:()=>void; onSubmit:(path:string)=>void;
}) {
  const [path, setPath] = useState('');
  const [confirm, setConfirm] = useState(false);
  const params = path ? {path} : undefined;
  const {data, isLoading, isError, refetch} = useGetMediaEntries(params, {query:{queryKey:getGetMediaEntriesQueryKey(params)}});
  const folders = data?.entries.filter(e => e.kind === 'directory') || [];
  const sameFolder = path === sourcePath;
  return <div className="overlay" onMouseDown={e => {if(e.target === e.currentTarget && !busy) onClose();}}>
    <div className="dialog wide" role="dialog" aria-modal="true" aria-label={`${operation} files`}>
      <div className="dialog-head">
        <div><div className="eyebrow">File operation / {operation}</div><h2 className="dialog-title">{confirm ? `Confirm ${operation}` : 'Choose destination'}</h2></div>
        <button className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close destination picker" data-testid="button-close-destination"><X size={19}/></button>
      </div>
      {confirm ? <>
        <p className="dialog-text">You are about to <strong>{operation}</strong> {files.length} {files.length === 1 ? 'file' : 'files'} into <strong>{path || 'Media root'}</strong>. {operation === 'move' ? 'The original files will be removed from their current folder.' : 'The originals will remain in their current folder.'}</p>
        <div className="notice">Files are never overwritten. If any destination name already exists, the entire batch stops before anything changes. Pause other apps editing these files before moving them.</div>
        {error && <p className="notice error" role="alert" data-testid="status-transfer-error">{error}</p>}
        <div className="dialog-footer"><button className="btn" onClick={() => setConfirm(false)} disabled={busy} data-testid="button-back-destination"><ArrowLeft size={16}/> Back</button><button className="btn btn-primary" onClick={() => onSubmit(path)} disabled={busy} data-testid="button-confirm-transfer">{busy ? 'Working…' : `Confirm ${operation}`}</button></div>
      </> : <>
        <p className="dialog-text">Select a folder inside your media root for {files.length} selected {files.length === 1 ? 'file' : 'files'}. Only folders can be destinations.</p>
        <div className="tree-current"><FolderOpen size={18}/><span data-testid="text-destination-path">{path || 'Media root'}</span></div>
        <div className="tree-list">
          {path && <button className="tree-item" onClick={() => setPath(data?.parentPath ?? path.split('/').slice(0,-1).join('/'))} data-testid="button-destination-parent"><ArrowLeft size={17}/> Parent folder</button>}
          {isLoading ? <div className="skeleton" style={{height:47,borderRadius:9}}/> : isError ? <div className="notice error">Could not load folders. <button className="btn" onClick={() => refetch()} data-testid="button-retry-destinations">Retry</button></div> :
            folders.length ? folders.map(folder => <button className="tree-item" key={folder.path} onClick={() => setPath(folder.path)} data-testid={`button-destination-folder-${folder.path}`}><Folder size={18}/><span>{folder.name}</span><ArrowRight size={15} style={{marginLeft:'auto', flex:'none'}}/></button>) :
              <p className="field-hint" style={{padding:'8px 3px'}}>No subfolders here. You can choose this folder.</p>}
        </div>
        {sameFolder && <p className="field-hint">Choose a different folder. Files already live here, and existing names are never overwritten.</p>}
        <div className="dialog-footer"><button className="btn btn-quiet" onClick={onClose} data-testid="button-cancel-transfer">Cancel</button><button className="btn btn-dark" disabled={sameFolder || isLoading || isError} onClick={() => setConfirm(true)} data-testid="button-use-destination">Use this folder <ArrowRight size={16}/></button></div>
      </>}
    </div>
  </div>;
}