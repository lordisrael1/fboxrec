import { useStore } from '../state/store';
import { formatDur, formatTime } from '../lib/timescale';

/** Everything about the selected span/log/marker, raw payloads included. */
export function DetailPanel() {
  const selected = useStore((s) => s.selected);

  return (
    <div className="panel detail-panel">
      <div className="panel-title">details</div>
      <div className="detail-scroll">
        {!selected && (
          <div className="dim pad">
            click a span, log line, or trigger marker to inspect it
          </div>
        )}
        {selected?.kind === 'span' && (
          <div className="pad">
            <div className="detail-head mono">{selected.span.label}</div>
            <table className="kv">
              <tbody>
                <Row k="kind" v={selected.span.kind} />
                <Row
                  k="duration"
                  v={
                    selected.span.open
                      ? `${formatDur(selected.span.endMs - selected.span.startMs)} (still in flight at capture)`
                      : formatDur(selected.span.endMs - selected.span.startMs)
                  }
                />
                <Row k="start" v={formatTime(selected.span.startMs, 1)} />
                <Row k="requestId" v={selected.span.requestId} />
                {selected.span.status !== undefined && (
                  <Row k="status" v={String(selected.span.status)} />
                )}
                {selected.span.error && <Row k="error" v={selected.span.error} />}
                {selected.span.aborted && <Row k="aborted" v="true (client gone)" />}
              </tbody>
            </table>
            <div className="dim small">start event</div>
            <pre>{JSON.stringify(selected.span.startEvent.data, null, 2)}</pre>
            {selected.span.endEvent && (
              <>
                <div className="dim small">end event</div>
                <pre>{JSON.stringify(selected.span.endEvent.data, null, 2)}</pre>
              </>
            )}
          </div>
        )}
        {selected?.kind === 'log' && (
          <div className="pad">
            <div className="detail-head mono">console.{selected.log.level}</div>
            <table className="kv">
              <tbody>
                <Row k="time" v={formatTime(selected.log.t, 1)} />
                <Row k="requestId" v={selected.log.requestId} />
              </tbody>
            </table>
            <pre>{selected.log.msg}</pre>
          </div>
        )}
        {selected?.kind === 'marker' && (
          <div className="pad">
            <div className="detail-head mono">
              ▼ trigger: {selected.marker.triggerType}
              {selected.marker.suppressed ? ' (suppressed by cooldown)' : ''}
            </div>
            <table className="kv">
              <tbody>
                <Row k="time" v={formatTime(selected.marker.t, 1)} />
                {selected.marker.reason && <Row k="reason" v={selected.marker.reason} />}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <tr>
      <td className="dim">{k}</td>
      <td className="mono">{v}</td>
    </tr>
  );
}
