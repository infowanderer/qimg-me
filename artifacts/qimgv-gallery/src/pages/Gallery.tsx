import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, ChevronRight, Copy, Folder, FolderOpen, HardDrive, Image as ImageIcon, Link2Off, MoveRight, RefreshCw, Tag, X } from 'lucide-react';
import { getGetMediaEntriesQueryKey, useApplyTags, useGetMediaEntries, useTransferFiles } from '@workspace/api-client-react';
import type { MediaEntry, TagOperationInput } from '@workspace/api-client-react';
import MediaCard from '../components/MediaCard';
import TagDialog from '../components/TagDialog';
import TransferDialog from '../components/TransferDialog';
import Viewer from '../components/Viewer';

type Action = 'tags' | 'copy' | 'move' | null;
type Feedback = { kind:'success'|'error'|'neutral'; text:string; details?:string[] };

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as {message?:string; error?:string; data?:{error?:string}; response?:{data?:{error?:string}}};
    return e.data?.error || e.response?.data?.error || e.error || e.message || 'The server could not complete this request.';
  }
  return 'The server could not complete this request.';
}

export default function Gallery() {
  const queryClient = useQueryClient();
  const [path, setPath] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [action, setAction] = useState<Action>(null);
  const [tagFiles, setTagFiles] = useState<MediaEntry[] | null>(null);
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [actionError, setActionError] = useState('');
  const params = path ? {path} : undefined;
  const {data, isLoading, isFetching, isError, error, refetch} = useGetMediaEntries(params, {query:{queryKey:getGetMediaEntriesQueryKey(params), retry:1}});
  const applyTags = useApplyTags();
  const transferFiles = useTransferFiles();
  const entries = data?.entries || [];
  const files = useMemo(() => entries.filter(e => e.kind === 'image' || e.kind === 'video' || e.kind === 'other'), [data]);
  const folders = entries.filter(e => e.kind === 'directory');
  const links = entries.filter(e => e.kind === 'symlink');
  const previewFiles = files.filter(e => (e.kind === 'image' || e.kind === 'video') && !!e.contentUrl);
  const selectedFiles = files.filter(e => selected.includes(e.path));
  const viewerIndex = previewFiles.findIndex(e => e.path === viewerPath);
  const viewerEntry = viewerIndex >= 0 ? previewFiles[viewerIndex] : null;
  const busy = applyTags.isPending || transferFiles.isPending;

  useEffect(() => { setSelected([]); setFeedback(null); setViewerPath(null); }, [path]);
  function enter(next: string) { setPath(next); window.scrollTo({top:0,behavior:'smooth'}); }
  function toggle(entry: MediaEntry) {
    if (selected.includes(entry.path)) { setSelected(prev => prev.filter(p => p !== entry.path)); return; }
    if (selected.length >= 250) { setFeedback({kind:'error', text:'Select up to 250 files per operation.'}); return; }
    setSelected(prev => [...prev, entry.path]);
  }
  function start(next: Exclude<Action,null>, explicit?: MediaEntry[]) {
    const targets = explicit || selectedFiles;
    if (!targets.length) { setFeedback({kind:'neutral',text:'Select one or more files first. Folders and links cannot be tagged or transferred.'}); return; }
    setActionError('');
    setTagFiles(next === 'tags' ? targets : null);
    setAction(next);
  }
  function closeAction() { if (busy) return; setAction(null); setTagFiles(null); setActionError(''); setFeedback({kind:'neutral',text:'Cancelled. No files were changed.'}); }
  async function invalidateDirectory() { await queryClient.invalidateQueries({queryKey:getGetMediaEntriesQueryKey()}); }
  function submitTags(input: TagOperationInput) {
    setActionError('');
    applyTags.mutate({data:input}, {
      onSuccess: result => {
        setFeedback({kind:'success',text:`${result.changedCount} ${result.changedCount === 1 ? 'file' : 'files'} renamed${result.unchangedCount ? ` · ${result.unchangedCount} unchanged` : ''}.`});
        setSelected([]);setAction(null);setTagFiles(null);setViewerPath(null);
        void invalidateDirectory();
      },
      onError: err => setActionError(errorMessage(err))
    });
  }
  function submitTransfer(destinationDirectory: string) {
    setActionError('');
    transferFiles.mutate({data:{operation:action === 'move' ? 'move' : 'copy',paths:selectedFiles.map(f => f.path),destinationDirectory}}, {
      onSuccess: result => {
        const failed = result.results.filter(item => item.status === 'failed').map(item => `${item.sourcePath}: ${item.error || 'Could not transfer. The destination name may already exist.'}`);
        setFeedback({kind:failed.length ? 'error' : 'success',text:`${result.successCount} ${result.successCount === 1 ? 'file' : 'files'} ${action === 'move' ? 'moved' : 'copied'}${result.failureCount ? ` · ${result.failureCount} failed` : ''}.`,details:failed});
        setSelected([]);setAction(null);setViewerPath(null);
        void invalidateDirectory();
      },
      onError: err => setActionError(errorMessage(err))
    });
  }
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.closest('input,textarea,[contenteditable="true"]') || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'Escape') {
        if (action && !busy) closeAction();
        else if (viewerPath) setViewerPath(null);
        else if (selected.length) {setSelected([]);setFeedback({kind:'neutral',text:'Selection cleared.'});}
        return;
      }
      if (action) return;
      if (viewerPath) {
        if (e.key === 'ArrowLeft' && viewerIndex > 0) setViewerPath(previewFiles[viewerIndex-1].path);
        if (e.key === 'ArrowRight' && viewerIndex < previewFiles.length-1) setViewerPath(previewFiles[viewerIndex+1].path);
        return;
      }
      if (e.key.toLowerCase() === 't') start('tags');
      if (e.key.toLowerCase() === 'c') start('copy');
      if (e.key.toLowerCase() === 'm') start('move');
    }
    window.addEventListener('keydown',onKey);
    return () => window.removeEventListener('keydown',onKey);
  });

  const crumbs = (data?.currentPath ?? path).split('/').filter(Boolean);
  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><ImageIcon size={20} strokeWidth={2.2}/></span><span>qimgv<span style={{fontWeight:400,opacity:.55}}> / gallery</span></span></div>
      <div className="topbar-end"><span><span className="live-dot"/>Your media, at home</span><span className="topbar-rule"/><span className="mono">BROWSER COMPANION</span></div>
    </header>
    <main className="workspace">
      <div className="eyebrow">The collection / {path ? 'Exploring' : 'Home'}</div>
      <div className="heading-row">
        <div><h1 className="page-title">{path ? <>{crumbs[crumbs.length - 1]}<em>.</em></> : <>Your <em>library.</em></>}</h1><p className="subcopy">Browse, find, and keep your filenames in order.</p></div>
        {data && <div className="counter" data-testid="text-directory-count"><strong>{data.totalMedia}</strong> media <span style={{opacity:.35}}> / </span><strong>{data.totalEntries}</strong> items</div>}
      </div>
      <div className="rule"/>
      <nav className="breadcrumbs" aria-label="Folder path">
        <button className={`crumb ${!path ? 'active' : ''}`} onClick={() => enter('')} data-testid="button-folder-root"><HardDrive size={15} style={{display:'inline',verticalAlign:'-3px',marginRight:7}}/>Media root</button>
        {crumbs.map((part,i) => <span key={i} style={{display:'contents'}}><ChevronRight size={14} className="crumb-sep"/><button className={`crumb ${i===crumbs.length-1 ? 'active' : ''}`} onClick={() => enter(crumbs.slice(0,i+1).join('/'))} data-testid={`button-breadcrumb-${i}`}>{part}</button></span>)}
      </nav>
      <div className="toolbar">
        <div className="toolbar-left">
          {path && <button className="btn" onClick={() => enter(data?.parentPath ?? path.split('/').slice(0,-1).join('/'))} data-testid="button-folder-up"><ArrowLeft size={16}/> Up one level</button>}
          <button className="btn btn-quiet" onClick={() => void refetch()} disabled={isFetching} data-testid="button-refresh"><RefreshCw size={16} className={isFetching ? 'animate-spin' : ''}/>{isFetching ? 'Refreshing' : 'Refresh'}</button>
        </div>
        <div className="toolbar-right">
          <button className="btn btn-quiet" onClick={() => {
            if (selected.length === files.length && files.length) setSelected([]);
            else {setSelected(files.slice(0,250).map(f => f.path)); if(files.length>250) setFeedback({kind:'neutral',text:'Selected the first 250 files. Operations are limited to 250 at a time.'});}
          }} disabled={!files.length} data-testid="button-select-all">{selected.length === files.length && files.length ? 'Clear selection' : 'Select all files'}</button>
          <button className="btn" onClick={() => start('tags')} data-testid="button-toolbar-tag"><Tag size={16}/> Tag <span className="keycap">T</span></button>
          <button className="btn" onClick={() => start('copy')} data-testid="button-toolbar-copy"><Copy size={16}/> Copy <span className="keycap">C</span></button>
          <button className="btn" onClick={() => start('move')} data-testid="button-toolbar-move"><MoveRight size={16}/> Move <span className="keycap">M</span></button>
        </div>
      </div>
      {feedback && <div className={`notice ${feedback.kind === 'neutral' ? '' : feedback.kind}`} role="status" data-testid="status-operation"><div style={{display:'flex',justifyContent:'space-between',gap:15,alignItems:'start'}}><span>{feedback.text}</span><button onClick={() => setFeedback(null)} aria-label="Dismiss message" data-testid="button-dismiss-feedback" style={{border:0,background:'transparent',color:'inherit',padding:0}}><X size={16}/></button></div>{!!feedback.details?.length && <ul className="notice-list">{feedback.details.map((detail,i) => <li key={i}>{detail}</li>)}</ul>}</div>}
      {isLoading ? <><div className="section-label">Opening collection</div><div className="gallery-grid">{Array.from({length:8},(_,i) => <div key={i}><div className="skeleton skeleton-card"/><div className="skeleton" style={{height:12,width:'65%',marginTop:14,borderRadius:4}}/></div>)}</div></> :
        isError ? <div className="state-panel" role="alert"><div className="state-icon"><Link2Off size={29}/></div><h2>Can't open this folder.</h2><p data-testid="status-directory-error">{errorMessage(error)} Check that the server is running and its media root is configured and accessible, then try again.</p><button className="btn btn-primary" onClick={() => void refetch()} data-testid="button-retry-directory"><RefreshCw size={16}/> Try again</button></div> :
        <>
          {(folders.length > 0 || links.length > 0) && <section aria-label="Folders"><h2 className="section-label">Folders & links <span>{folders.length + links.length}</span></h2><div className="folder-grid">
            {folders.map(folder => <button className="folder-card" onClick={() => enter(folder.path)} key={folder.path} data-testid={`button-folder-${folder.path}`}><span className="folder-icon"><Folder size={23} strokeWidth={1.6}/></span><span style={{minWidth:0}}><div className="folder-name">{folder.name}</div><div className="folder-meta">OPEN FOLDER</div></span><ArrowRight size={16} className="folder-arrow"/></button>)}
            {links.map(link => <div className="folder-card" key={link.path} title="Links cannot be opened, tagged, or transferred" data-testid={`card-symlink-${link.path}`}><span className="folder-icon"><Link2Off size={22} strokeWidth={1.6}/></span><span style={{minWidth:0}}><div className="folder-name">{link.name}</div><div className="folder-meta">LINK · UNAVAILABLE</div></span></div>)}
          </div></section>}
          {files.length > 0 ? <section aria-label="Files"><h2 className="section-label">Files <span>{files.length}</span></h2><div className="gallery-grid">{files.map(entry => <MediaCard key={entry.path} entry={entry} selected={selected.includes(entry.path)} onToggle={() => toggle(entry)} onOpen={() => setViewerPath(entry.path)}/>)}</div></section> :
            !folders.length && !links.length ? <div className="state-panel"><div className="state-icon"><FolderOpen size={30}/></div><h2>{path ? 'Nothing in this folder yet.' : 'A quiet collection, for now.'}</h2><p data-testid="status-empty-library">{path ? 'This folder has no files or subfolders. Go back to continue browsing.' : 'Your media root is connected, but there are no files here yet. Add media to the configured root on your server, then refresh this page.'}</p>{path ? <button className="btn" onClick={() => enter(data?.parentPath ?? '')} data-testid="button-empty-go-back"><ArrowLeft size={16}/> Go to parent</button> : <button className="btn" onClick={() => void refetch()} data-testid="button-empty-refresh"><RefreshCw size={16}/> Refresh library</button>}</div> :
              <div className="notice">No files at this level. Open a folder to keep exploring. Folders and links cannot be tagged or transferred.</div>}
        </>}
      {selected.length > 0 && <div className="selection-bar" role="region" aria-label="Selected file actions">
        <div><div className="selection-copy"><Check size={16} style={{display:'inline',verticalAlign:'-3px',marginRight:7}}/>{selected.length} {selected.length === 1 ? 'file' : 'files'} selected</div><div className="selection-note">Only files can be tagged, copied, or moved</div></div>
        <div className="selection-actions"><button className="btn btn-primary" onClick={() => start('tags')} data-testid="button-selection-tag"><Tag size={16}/> Tag</button><button className="btn" onClick={() => start('copy')} data-testid="button-selection-copy"><Copy size={16}/> Copy</button><button className="btn" onClick={() => start('move')} data-testid="button-selection-move"><MoveRight size={16}/> Move</button><button className="icon-btn" onClick={() => {setSelected([]);setFeedback({kind:'neutral',text:'Selection cleared.'});}} aria-label="Clear selection" data-testid="button-clear-selection"><X size={17}/></button></div>
      </div>}
    </main>
    {viewerEntry && <Viewer entry={viewerEntry} index={viewerIndex} count={previewFiles.length} onClose={() => setViewerPath(null)} onNavigate={direction => setViewerPath(previewFiles[viewerIndex+direction].path)} selected={selected.includes(viewerEntry.path)} onSelect={() => toggle(viewerEntry)} onTags={() => start('tags',[viewerEntry])}/>}
    {action === 'tags' && tagFiles && <TagDialog files={tagFiles} busy={busy} error={actionError} onClose={closeAction} onSubmit={submitTags}/>}
    {(action === 'copy' || action === 'move') && <TransferDialog operation={action} files={selectedFiles} sourcePath={data?.currentPath ?? path} busy={busy} error={actionError} onClose={closeAction} onSubmit={submitTransfer}/>}
  </div>;
}