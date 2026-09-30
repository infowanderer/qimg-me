import { useState } from 'react';
import { ArrowLeft, Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { MediaEntry, TagOperationInput } from '@workspace/api-client-react';

export default function TagDialog({ files, busy, error, onClose, onSubmit }: {
  files: MediaEntry[]; busy: boolean; error: string; onClose: () => void; onSubmit: (data: TagOperationInput) => void;
}) {
  const [mode, setMode] = useState<'add'|'edit'|'remove'>('add');
  const [text, setText] = useState('');
  const [oldTag, setOldTag] = useState('');
  const [validation, setValidation] = useState('');
  const single = files.length === 1 ? files[0] : null;
  const lines = text.split('\n').map(t => t.trim()).filter(Boolean);
  function submit() {
    setValidation('');
    if (mode === 'add') {
      if (!lines.length) { setValidation('Enter at least one tag.'); return; }
      if (lines.length > 50) { setValidation('Use no more than 50 tags at once.'); return; }
      onSubmit({operation:'add', paths:files.map(f => f.path), tags:lines});
    } else if (mode === 'edit') {
      if (!text.trim()) { setValidation('Enter a replacement tag.'); return; }
      onSubmit({operation:'edit', paths:[single!.path], oldTag, newTag:text.trim()});
    } else onSubmit({operation:'remove', paths:[single!.path], oldTag});
  }
  return <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <div className="dialog" role="dialog" aria-modal="true" aria-label="Manage tags">
      <div className="dialog-head">
        <div><div className="eyebrow">Filename organization</div><h2 className="dialog-title">{mode === 'add' ? 'Add tags' : mode === 'edit' ? 'Edit tag' : 'Remove tag'}</h2></div>
        <button className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close tag dialog" data-testid="button-close-tags"><X size={19}/></button>
      </div>
      {mode !== 'add' && <button className="btn btn-quiet" onClick={() => {setMode('add');setText('');setValidation('');}} data-testid="button-back-tags"><ArrowLeft size={15}/> All tags</button>}
      <p className="dialog-text" style={{marginTop:mode === 'add' ? 0 : 15}}>
        {mode === 'add' ? <>Add tags to <strong>{files.length === 1 ? files[0].name : `${files.length} selected files`}</strong>. Tags are stored in the filename; the server will validate and normalize them.</> :
          mode === 'edit' ? <>Replace <strong>{oldTag}</strong> on <strong>{single?.name}</strong>. This changes the filename.</> :
            <>Remove <strong>{oldTag}</strong> from <strong>{single?.name}</strong>? This changes the filename and cannot be undone here.</>}
      </p>
      <p className="field-hint">Pause other apps editing these files before changing their names.</p>
      {mode !== 'remove' && <>
        <label className="form-label" htmlFor="tag-input">{mode === 'add' ? 'Tags, one per line' : 'New tag'}</label>
        {mode === 'add' ? <textarea id="tag-input" className="field" value={text} onChange={e => setText(e.target.value)} placeholder={'favorite\nsummer trip\nfamily'} autoFocus data-testid="input-tags"/> :
          <input id="tag-input" className="field" value={text} onChange={e => setText(e.target.value)} autoFocus data-testid="input-edit-tag"/>}
        <p className="field-hint">{mode === 'add' ? 'Order is preserved. Existing tags will not be duplicated. Up to 50 tags per request.' : 'The server checks whether this tag is valid before renaming.'}</p>
      </>}
      {single && mode === 'add' && <div style={{marginTop:24}}>
        <div className="section-label">Existing tags</div>
        {single.tags.length ? single.tags.map((tag,i) => <div className="tag-row" key={`${tag}-${i}`}>
          <span className="tag-row-name">{tag}</span>
          <span className="tag-row-actions">
            <button className="icon-btn" aria-label={`Edit ${tag}`} title={`Edit ${tag}`} onClick={() => {setOldTag(tag);setText(tag);setMode('edit');setValidation('');}} data-testid={`button-edit-tag-${i}`}><Pencil size={16}/></button>
            <button className="icon-btn" aria-label={`Remove ${tag}`} title={`Remove ${tag}`} onClick={() => {setOldTag(tag);setMode('remove');setValidation('');}} data-testid={`button-remove-tag-${i}`}><Trash2 size={16}/></button>
          </span>
        </div>) : <p className="field-hint">No tags on this file yet.</p>}
      </div>}
      {(validation || error) && <p className="notice error" role="alert" data-testid="status-tag-validation">{validation || error}</p>}
      <div className="dialog-footer">
        <button className="btn btn-quiet" onClick={onClose} disabled={busy} data-testid="button-cancel-tags">Cancel</button>
        <button className={`btn ${mode === 'remove' ? 'btn-danger' : 'btn-primary'}`} onClick={submit} disabled={busy} data-testid="button-save-tags">
          {mode === 'add' ? <Plus size={16}/> : mode === 'edit' ? <Check size={16}/> : <Trash2 size={16}/>}
          {busy ? 'Saving…' : mode === 'add' ? 'Add tags' : mode === 'edit' ? 'Save change' : 'Confirm removal'}
        </button>
      </div>
    </div>
  </div>;
}