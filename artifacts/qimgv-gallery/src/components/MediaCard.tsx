import { Check, File, Film, Image as ImageIcon } from 'lucide-react';
import type { MediaEntry } from '@workspace/api-client-react';

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export default function MediaCard({ entry, selected, onToggle, onOpen }: {
  entry: MediaEntry; selected: boolean; onToggle: () => void; onOpen: () => void;
}) {
  const previewable = (entry.kind === 'image' || entry.kind === 'video') && !!entry.contentUrl;
  return <article className={`media-card ${selected ? 'selected' : ''}`} data-testid={`card-media-${entry.path}`}>
    <button type="button" className="media-image" onClick={previewable ? onOpen : onToggle} aria-label={previewable ? `Preview ${entry.name}` : `Select ${entry.name}`} data-testid={`button-open-media-${entry.path}`}>
      {entry.kind === 'image' && entry.contentUrl ? <img src={entry.contentUrl} alt={entry.name} loading="lazy" /> :
        entry.kind === 'video' && entry.contentUrl ? <video src={entry.contentUrl} preload="metadata" muted playsInline /> :
          entry.kind === 'video' ? <Film size={38} strokeWidth={1.25} /> :
            entry.kind === 'image' ? <ImageIcon size={38} strokeWidth={1.25} /> : <File size={38} strokeWidth={1.25} />}
      <span className="media-kind">{entry.kind === 'other' ? 'File' : entry.kind}</span>
    </button>
    <button className="select-check" type="button" onClick={onToggle} aria-label={`${selected ? 'Deselect' : 'Select'} ${entry.name}`} aria-pressed={selected} data-testid={`button-select-media-${entry.path}`}>
      {selected && <Check size={18} strokeWidth={2.5} />}
    </button>
    <div className="media-info">
      <div className="media-name" title={entry.name} data-testid={`text-media-name-${entry.path}`}>{entry.name}</div>
      <div className="media-details"><span>{formatSize(entry.size)}</span><span>·</span><span>{new Date(entry.modifiedAt).toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' })}</span></div>
      {entry.tags.length > 0 && <div className="tag-preview">{entry.tags.slice(0,3).map((tag, i) => <span className="tag-pill" key={`${tag}-${i}`}>{tag}</span>)}{entry.tags.length > 3 && <span className="tag-pill">+{entry.tags.length - 3}</span>}</div>}
    </div>
  </article>;
}