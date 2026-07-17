import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { formatDur, formatTime } from '../lib/timescale';

/**
 * Full-range minimap (event density + current view window) whose drag sets
 * the cursor — plus the single highest-wow feature: the "state at this
 * instant" panel showing exactly what the process was doing at the cursor.
 *
 * Perf (audit M8): the density histogram is O(events) and must NOT rebuild
 * per pointer-move — it is memoized on (model, width); drag updates are
 * rAF-throttled; instant-state derivations are memoized on the cursor.
 * Keyboard (audit A1): the canvas is focusable; arrow keys move the cursor.
 */

const H = 44;

export function Scrubber() {
  const model = useStore((s) => s.model);
  const view = useStore((s) => s.view);
  const cursorMs = useStore((s) => s.cursorMs);
  const setCursor = useStore((s) => s.setCursor);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const dragging = useRef(false);
  const rafPending = useRef<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Audit M8: one pass over all events per (model, width) — not per redraw.
  const histogram = useMemo(() => {
    if (!model) return null;
    const span = model.t1 - model.t0;
    const cols = Math.max(1, Math.floor(width / 2));
    const counts = new Float64Array(cols);
    for (const e of model.incident.events) {
      const c = Math.min(cols - 1, Math.max(0, Math.floor(((e.wallMs - model.t0) / span) * cols)));
      counts[c]!++;
    }
    let max = 1;
    for (let c = 0; c < cols; c++) if (counts[c]! > max) max = counts[c]!;
    return { counts, cols, max };
  }, [model, width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !model || !histogram) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(H * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, H);

    const span = model.t1 - model.t0;
    ctx.fillStyle = '#39435c';
    for (let c = 0; c < histogram.cols; c++) {
      const h = (histogram.counts[c]! / histogram.max) * (H - 8);
      ctx.fillRect(c * 2, H - h, 2, h);
    }

    // Trigger markers.
    for (const m of model.markers) {
      if (m.suppressed) continue;
      ctx.fillStyle = '#e5484d';
      ctx.fillRect(((m.t - model.t0) / span) * width, 0, 2, H);
    }

    // Current view window.
    const vx0 = ((view.start - model.t0) / span) * width;
    const vx1 = ((view.end - model.t0) / span) * width;
    ctx.fillStyle = 'rgba(234,238,245,0.09)';
    ctx.fillRect(vx0, 0, vx1 - vx0, H);
    ctx.strokeStyle = 'rgba(234,238,245,0.4)';
    ctx.strokeRect(vx0 + 0.5, 0.5, vx1 - vx0 - 1, H - 1);

    // Cursor.
    if (cursorMs !== null) {
      ctx.fillStyle = '#eaeef5';
      ctx.fillRect(((cursorMs - model.t0) / span) * width, 0, 1.5, H);
    }
  }, [model, view, cursorMs, width, histogram]);

  if (!model) return null;

  const cursorFromEvent = (clientX: number): void => {
    // Audit M8: collapse pointer-move bursts to one store update per frame.
    if (rafPending.current !== null) cancelAnimationFrame(rafPending.current);
    rafPending.current = requestAnimationFrame(() => {
      rafPending.current = null;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      setCursor(model.t0 + frac * (model.t1 - model.t0));
    });
  };

  const stepCursor = (frac: number): void => {
    const range = model.t1 - model.t0;
    const current = cursorMs ?? model.t0;
    setCursor(Math.min(model.t1, Math.max(model.t0, current + frac * range)));
  };

  return (
    <div className="scrubber-row">
      <div ref={wrapRef} className="scrubber-wrap">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          role="slider"
          aria-label="Incident scrubber — arrow keys move the inspection cursor"
          aria-valuemin={model.t0}
          aria-valuemax={model.t1}
          aria-valuenow={cursorMs ?? model.t0}
          aria-valuetext={cursorMs !== null ? formatTime(cursorMs, 1) : 'no cursor'}
          style={{ width: `${width}px`, height: `${H}px`, cursor: 'ew-resize' }}
          onPointerDown={(e) => {
            dragging.current = true;
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            cursorFromEvent(e.clientX);
          }}
          onPointerMove={(e) => {
            if (dragging.current) cursorFromEvent(e.clientX);
          }}
          onPointerUp={() => {
            dragging.current = false;
          }}
          onKeyDown={(e) => {
            // Audit A1: keyboard scrubbing — 1% steps, 10% with Shift.
            if (e.key === 'ArrowLeft') stepCursor(e.shiftKey ? -0.1 : -0.01);
            else if (e.key === 'ArrowRight') stepCursor(e.shiftKey ? 0.1 : 0.01);
            else if (e.key === 'Home') setCursor(model.t0);
            else if (e.key === 'End') setCursor(model.t1);
            else return;
            e.preventDefault();
          }}
        />
      </div>
      <InstantState />
    </div>
  );
}

/** "State at this instant" — what was the process doing at the cursor? */
function InstantState() {
  const model = useStore((s) => s.model);
  const cursorMs = useStore((s) => s.cursorMs);

  // Audit M8: memoized — one single pass over spans per cursor change
  // instead of four separate full filters on every render.
  const snapshot = useMemo(() => {
    if (!model || cursorMs === null) return null;
    const c = cursorMs;
    const inflight = [];
    const activeQueries = [];
    const activeClients = [];
    for (const s of model.spans) {
      if (s.startMs > c || c > s.endMs) continue;
      if (s.kind === 'request') inflight.push(s);
      else if (s.kind === 'query' || s.kind === 'poolwait') activeQueries.push(s);
      else if (s.kind === 'client') activeClients.push(s);
    }
    let vital = null;
    for (const v of model.vitals) {
      if (v.t > c) break;
      vital = v;
    }
    const recentLogs = [];
    for (let i = model.logs.length - 1; i >= 0 && recentLogs.length < 4; i--) {
      if (model.logs[i]!.t <= c) recentLogs.unshift(model.logs[i]!);
    }
    return { inflight, activeQueries, activeClients, vital, recentLogs };
  }, [model, cursorMs]);

  if (!model || cursorMs === null || !snapshot) {
    return <div className="instant-state dim">drag the scrubber to inspect an instant</div>;
  }
  const c = cursorMs;
  const { inflight, activeQueries, activeClients, vital, recentLogs } = snapshot;

  return (
    <div className="instant-state">
      <div className="is-head">
        state at <span className="mono">{formatTime(c, 1)}</span>
      </div>
      <div className="is-grid">
        <div>
          <b>{inflight.length}</b> requests in flight
          {inflight.length > 0 && (
            <ul>
              {inflight.slice(0, 5).map((s, i) => (
                <li key={i} className="mono">
                  {s.label.slice(0, 46)} <span className="dim">{formatDur(c - s.startMs)} in</span>
                </li>
              ))}
              {inflight.length > 5 && <li className="dim">…and {inflight.length - 5} more</li>}
            </ul>
          )}
        </div>
        <div>
          <b>{activeQueries.length}</b> active queries / pool waits,{' '}
          <b>{activeClients.length}</b> outbound calls
          {activeQueries.slice(0, 3).map((s, i) => (
            <div key={i} className="mono dim">
              {s.label.slice(0, 52)}
            </div>
          ))}
        </div>
        <div>
          {vital ? (
            <>
              lag <b>{vital.lagMs.toFixed(1)}ms</b> · heap{' '}
              <b>{(vital.heapUsed / 1048576).toFixed(1)}MB</b> · rss{' '}
              <b>{(vital.rss / 1048576).toFixed(0)}MB</b>
            </>
          ) : (
            <span className="dim">no vitals sample yet</span>
          )}
          {recentLogs.map((l, i) => (
            <div key={i} className={`mono log-${l.level}`}>
              {l.msg.slice(0, 60)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
