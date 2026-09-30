import { useRef } from 'react';
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Tag, X } from 'lucide-react';
import type { MediaEntry } from '@workspace/api-client-react';

export default function Viewer({ entry, index, count, onClose, onNavigate, onTags, onSelect, selected }: {
  entry: MediaEntry; index: number; count: number; onClose: () => void; onNavigate: (direction: number) => void; onTags: () => void; onSelect: () => void; selected: boolean;
}) {
  const touchStart = useRef<{x:number;y:number}|null>(null);
  return <div className="overlay viewer-overlay" role="dialog" aria-modal="true" aria-label={`Preview ${entry.name}`}>
    <div className="viewer">
      <header className="viewer-top">
        <button className="icon-btn" onClick={onClose} aria-label="Close preview" data-testid="button-close-preview"><X size={21}/></button>
        <div style={{minWidth:0, flex:1, textAlign:'center'}}>
          <div className="viewer-name" data-testid="text-preview-name">{entry.name}</div>
          <div className="viewer-sub">{index + 1} / {count} · {entry.kind.toUpperCase()}</div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Back to gallery" data-testid="button-back-gallery"><ArrowLeft size={20}/></button>
      </header>
      <div className="viewer-stage">
        <button className="viewer-nav" onClick={() => onNavigate(-1)} disabled={index === 0} aria-label="Previous media" data-testid="button-previous-media"><ChevronLeft size={24}/></button>
        <div className="viewer-content" onTouchStart={e => {touchStart.current = {x:e.touches[0].clientX,y:e.touches[0].clientY};}} onTouchEnd={e => {
          if (!touchStart.current || entry.kind === 'video') return;
          const dx = e.changedTouches[0].clientX - touchStart.current.x;
          const dy = e.changedTouches[0].clientY - touchStart.current.y;
          if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 1.4) {
            if (dx < 0 && index < count - 1) onNavigate(1);
            if (dx > 0 && index > 0) onNavigate(-1);
          }
          touchStart.current = null;
        }}>
          {entry.kind === 'video' ? <video key={entry.path} src={entry.contentUrl || undefined} controls autoPlay playsInline data-testid="video-preview" /> :
            <img key={entry.path} src={entry.contentUrl || undefined} alt={entry.name} data-testid="img-preview" />}
        </div>
        <button className="viewer-nav" onClick={() => onNavigate(1)} disabled={index === count - 1} aria-label="Next media" data-testid="button-next-media"><ChevronRight size={24}/></button>
      </div>
      <footer className="viewer-bottom">
        <div className="viewer-tags">{entry.tags.length ? entry.tags.map((tag,i) => <span className="tag-pill" key={`${tag}-${i}`}>{tag}</span>) : <span>No tags yet</span>}</div>
        <div style={{display:'flex',gap:8}}>
          <button className="btn btn-quiet" style={{color:'inherit',background:'transparent',borderColor:'#ffffff35'}} onClick={onSelect} data-testid="button-select-preview">{selected ? <Check size={16}/> : null}{selected ? 'Selected' : 'Select'}</button>
          <button className="btn btn-primary" onClick={onTags} data-testid="button-tags-preview"><Tag size={16}/> Tags</button>
        </div>
      </footer>
    </div>
  </div>;
}