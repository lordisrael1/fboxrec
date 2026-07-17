import { useStore } from '../state/store';
import { formatTime } from '../lib/timescale';

/** Clickable trigger chips — jump the cursor and view to a firing. */
export function TriggerMarkerBar() {
  const model = useStore((s) => s.model);
  const setCursor = useStore((s) => s.setCursor);
  const setView = useStore((s) => s.setView);
  const setSelected = useStore((s) => s.setSelected);
  if (!model || model.markers.length === 0) return null;

  const fired = model.markers.filter((m) => !m.suppressed);
  const suppressed = model.markers.length - fired.length;

  return (
    <div className="trigger-bar">
      {fired.map((m, i) => (
        <button
          key={i}
          className="trigger-chip"
          title={m.reason}
          onClick={() => {
            setCursor(m.t);
            const span = (model.t1 - model.t0) * 0.2;
            setView({ start: m.t - span * 0.7, end: m.t + span * 0.3 });
            setSelected({ kind: 'marker', marker: m });
          }}
        >
          ▼ {m.triggerType} <span className="dim">{formatTime(m.t, 1)}</span>
        </button>
      ))}
      {suppressed > 0 && (
        <span className="dim small">+{suppressed} suppressed by cooldown (one storm = one file)</span>
      )}
    </div>
  );
}
