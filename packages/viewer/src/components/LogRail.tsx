import { useMemo } from 'react';
import { useStore } from '../state/store';
import { formatTime } from '../lib/timescale';

const MAX_ROWS = 300;

/** Console lines within the current view window; click = jump the cursor. */
export function LogRail() {
  const model = useStore((s) => s.model);
  const view = useStore((s) => s.view);
  const setCursor = useStore((s) => s.setCursor);
  const setSelected = useStore((s) => s.setSelected);

  // Logs are sorted by time (they are recorded in order), so a binary
  // search beats re-filtering every log on every pan/zoom frame.
  const visible = useMemo(() => {
    if (!model) return [];
    const logs = model.logs;
    let lo = 0;
    let hi = logs.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (logs[mid]!.t < view.start) lo = mid + 1;
      else hi = mid;
    }
    const out = [];
    for (let i = lo; i < logs.length && logs[i]!.t <= view.end; i++) out.push(logs[i]!);
    return out;
  }, [model, view.start, view.end]);

  if (!model) return null;
  const shown = visible.slice(0, MAX_ROWS);

  return (
    <div className="panel log-rail">
      <div className="panel-title">
        logs <span className="dim">({visible.length} in view)</span>
      </div>
      <div className="log-scroll">
        {shown.length === 0 && <div className="dim pad">no console output in this window</div>}
        {shown.map((l, i) => (
          // Audit A2: real buttons — keyboard focusable/activatable.
          <button
            key={`${l.seq}-${i}`}
            type="button"
            className={`log-row log-${l.level}`}
            onClick={() => {
              setCursor(l.t);
              setSelected({ kind: 'log', log: l });
            }}
          >
            <span className="mono dim">{formatTime(l.t, 1)}</span>
            <span className={`lvl lvl-${l.level}`}>{l.level}</span>
            <span className="mono">{l.msg}</span>
          </button>
        ))}
        {visible.length > MAX_ROWS && (
          <div className="dim pad">…{visible.length - MAX_ROWS} more (zoom in to narrow)</div>
        )}
      </div>
    </div>
  );
}
