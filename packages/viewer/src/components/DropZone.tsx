import { useCallback, useRef, useState } from 'react';
import { loadFromFile } from '../loaders/from-file';
import { useStore } from '../state/store';

export function DropZone() {
  const error = useStore((s) => s.error);
  const loading = useStore((s) => s.loading);
  const pendingSrc = useStore((s) => s.pendingSrc);
  const confirmPendingSrc = useStore((s) => s.confirmPendingSrc);
  const setPendingSrc = useStore((s) => s.setPendingSrc);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const onFiles = useCallback((files: FileList | null) => {
    const file = files?.[0];
    if (file) void loadFromFile(file);
  }, []);

  const pendingHost = ((): string | null => {
    if (!pendingSrc) return null;
    try {
      return new URL(pendingSrc).host;
    } catch {
      return pendingSrc.slice(0, 60);
    }
  })();

  return (
    <div
      className={`dropzone ${over ? 'over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onFiles(e.dataTransfer.files);
      }}
    >
      <div className="dz-logo">🛩 flightbox</div>
      {pendingHost ? (
        // Audit I3: name the remote origin before fetching anything.
        <>
          <div className="dz-big">Load a remote incident?</div>
          <div className="pad">
            This link loads an incident file from <span className="mono">{pendingHost}</span>.
          </div>
          <div className="dz-actions">
            <button className="primary" onClick={() => void confirmPendingSrc()}>
              load from {pendingHost}
            </button>
            <button className="ghost" onClick={() => setPendingSrc(null)}>
              cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="dz-big">Drop an incident file</div>
          <div className="dim">
            or{' '}
            {/* Audit A2: a real button — keyboard users can open the picker. */}
            <button className="dz-pick" type="button" onClick={() => inputRef.current?.click()}>
              pick a .fbox file
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".fbox,application/gzip"
              style={{ display: 'none' }}
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => onFiles(e.target.files)}
            />
          </div>
        </>
      )}
      {/* Audit A5: announce state changes to screen readers. */}
      <div role="status" aria-live="polite" className="dz-status">
        {loading ? 'parsing…' : ''}
      </div>
      {error && (
        <div role="alert" className="dz-error">
          {error}
        </div>
      )}
      <div className="dz-privacy">
        Processed locally in your browser — the file is never uploaded.
      </div>
    </div>
  );
}
