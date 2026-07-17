import { useEffect } from 'react';
import { useStore } from './state/store';
import { loadFromQueryParam } from './loaders/from-url';
import { loadFromFile } from './loaders/from-file';
import { DropZone } from './components/DropZone';
import { Timeline } from './components/Timeline';
import { VitalsGraph } from './components/VitalsGraph';
import { Scrubber } from './components/Scrubber';
import { LogRail } from './components/LogRail';
import { DetailPanel } from './components/DetailPanel';
import { TriggerMarkerBar } from './components/TriggerMarker';
import { formatDur } from './lib/timescale';

/**
 * Three load paths, one parser (§8):
 *   1. drag-and-drop / file picker (in-browser, never uploaded)
 *   2. ?src=<presigned url>        (magic links)
 *   3. ?src=/__incident-<id>       (CLI-injected, localhost)
 */
export function App() {
  const model = useStore((s) => s.model);
  const error = useStore((s) => s.error);
  const reset = useStore((s) => s.reset);
  const selected = useStore((s) => s.selected);

  useEffect(() => {
    void loadFromQueryParam();
  }, []);

  // Drag-drop works anywhere, even with an incident open.
  useEffect(() => {
    const onDrop = (e: DragEvent): void => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (file) void loadFromFile(file);
    };
    const onDragOver = (e: DragEvent): void => e.preventDefault();
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragover', onDragOver);
    return () => {
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragover', onDragOver);
    };
  }, []);

  if (!model) return <DropZone />;

  const meta = model.incident.meta;
  return (
    <div className="app">
      <header className="header">
        <span className="brand">🛩 flightbox</span>
        <span className="mono">{meta.service}</span>
        <span className="chip chip-trigger" title={meta.trigger.reason}>
          {meta.trigger.type}
          {meta.trigger.reason ? ` — ${meta.trigger.reason.slice(0, 60)}` : ''}
        </span>
        <span className="dim">
          {meta.eventCount.toLocaleString()} events · {formatDur(meta.windowMs)} window ·{' '}
          {new Date(meta.capturedAt).toLocaleString()}
        </span>
        {error && (
          <span role="alert" className="dz-error">
            {error}
          </span>
        )}
        <button className="ghost" onClick={reset}>
          open another
        </button>
      </header>
      {/* Audit A1/A5: announce keyboard selections to screen readers. */}
      <div className="sr-only" role="status" aria-live="polite">
        {selected?.kind === 'span' &&
          `Selected span: ${selected.span.label}, ${selected.span.kind}`}
        {selected?.kind === 'log' && `Selected log line: ${selected.log.msg.slice(0, 80)}`}
        {selected?.kind === 'marker' && `Selected trigger: ${selected.marker.triggerType}`}
      </div>
      <TriggerMarkerBar />
      <Timeline />
      <VitalsGraph />
      <Scrubber />
      <div className="bottom-row">
        <LogRail />
        <DetailPanel />
      </div>
    </div>
  );
}
