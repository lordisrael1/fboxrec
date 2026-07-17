import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useStore } from '../state/store';
import type { Span } from '../lib/layout';
import { xOf, tOf, zoomAround, pan, niceTicks, formatDur } from '../lib/timescale';

/**
 * The canvas master component: swimlanes (Swimlane/SpanBar are draw
 * routines, not DOM), LOD clustering per ADR 018 (sub-pixel spans merge
 * into density blocks), trigger markers, cursor, wheel-zoom around the
 * cursor, drag-pan, click hit-testing.
 */

const AXIS_H = 26;
const ROW_H = 24;
const REQ_BAR = { y: 3, h: 11 };
const SUB_BAR = { y: 15, h: 7 };
const CLUSTER_GAP_PX = 0.75;
const CLUSTER_MAX_W_PX = 1.25;

interface HitRect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  span?: Span;
  markerIdx?: number;
  clusterSpans?: Span[];
}

function spanColor(s: Span): string {
  if (s.kind === 'request') {
    if (s.open || s.aborted) return '#f5a524';
    if (s.error || (s.status !== undefined && s.status >= 500)) return '#e5484d';
    if (s.status !== undefined && s.status >= 400) return '#f76b15';
    return '#3e7bfa';
  }
  if (s.kind === 'query') return s.error ? '#e5484d' : '#a857f0';
  if (s.kind === 'poolwait') return '#d6409f';
  return '#12a594'; // client
}

export function Timeline() {
  const model = useStore((s) => s.model);
  const view = useStore((s) => s.view);
  const cursorMs = useStore((s) => s.cursorMs);
  const selected = useStore((s) => s.selected);
  const setView = useStore((s) => s.setView);
  const setCursor = useStore((s) => s.setCursor);
  const setSelected = useStore((s) => s.setSelected);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hitsRef = useRef<HitRect[]>([]);
  const [width, setWidth] = useState(800);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const drag = useRef<{ x: number; view: { start: number; end: number }; moved: boolean } | null>(
    null
  );

  const height = AXIS_H + (model?.laneCount ?? 1) * ROW_H;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // --- drawing ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !model) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const hits: HitRect[] = [];

    // Axis + gridlines.
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = '#8b93a3';
    for (const tick of niceTicks(view, width)) {
      const x = xOf(tick.t, view, width);
      ctx.fillStyle = '#1c2230';
      ctx.fillRect(x, AXIS_H, 1, height - AXIS_H);
      ctx.fillStyle = '#8b93a3';
      ctx.fillText(tick.label, x + 3, 16);
    }
    ctx.strokeStyle = '#232a3a';
    ctx.beginPath();
    ctx.moveTo(0, AXIS_H - 0.5);
    ctx.lineTo(width, AXIS_H - 0.5);
    ctx.stroke();

    // Lane separators.
    for (let l = 1; l <= model.laneCount; l++) {
      ctx.fillStyle = '#141926';
      ctx.fillRect(0, AXIS_H + l * ROW_H - 1, width, 1);
    }

    // Spans with LOD clustering: per lane+depth, consecutive sub-pixel spans
    // merge into one density block (count-labelled) — ADR 018.
    const groups = new Map<string, Span[]>();
    for (const s of model.spans) {
      if (s.endMs < view.start || s.startMs > view.end) continue;
      const key = `${s.lane}:${s.depth}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
    }

    for (const [key, spans] of groups) {
      spans.sort((a, b) => a.startMs - b.startMs);
      const [laneStr, depthStr] = key.split(':');
      const lane = Number(laneStr);
      const bar = depthStr === '0' ? REQ_BAR : SUB_BAR;
      const yTop = AXIS_H + lane * ROW_H + bar.y;

      let cluster: { x0: number; x1: number; spans: Span[] } | null = null;
      const flushCluster = (): void => {
        if (!cluster) return;
        const w = Math.max(cluster.x1 - cluster.x0, 1);
        if (cluster.spans.length === 1) {
          drawSpan(ctx, cluster.spans[0]!, cluster.x0, w, yTop, bar.h, hits, selected);
        } else {
          ctx.fillStyle = 'rgba(139, 147, 163, 0.65)';
          ctx.fillRect(cluster.x0, yTop, w, bar.h);
          if (w > 26) {
            ctx.fillStyle = '#0b0e14';
            ctx.fillText(`×${cluster.spans.length}`, cluster.x0 + 2, yTop + bar.h - 1);
          }
          hits.push({
            x0: cluster.x0,
            x1: cluster.x0 + w,
            y0: yTop,
            y1: yTop + bar.h,
            clusterSpans: cluster.spans
          });
        }
        cluster = null;
      };

      for (const s of spans) {
        const x0 = xOf(s.startMs, view, width);
        const x1 = xOf(s.endMs, view, width);
        const w = x1 - x0;
        if (w < CLUSTER_MAX_W_PX) {
          if (cluster && x0 - cluster.x1 <= CLUSTER_GAP_PX) {
            cluster.x1 = Math.max(cluster.x1, x1);
            cluster.spans.push(s);
          } else {
            flushCluster();
            cluster = { x0, x1: Math.max(x1, x0 + CLUSTER_MAX_W_PX), spans: [s] };
          }
        } else {
          flushCluster();
          drawSpan(ctx, s, x0, w, yTop, bar.h, hits, selected);
        }
      }
      flushCluster();
    }

    // Trigger markers (red = fired, dim = suppressed).
    model.markers.forEach((m, i) => {
      const x = xOf(m.t, view, width);
      if (x < 0 || x > width) return;
      ctx.fillStyle = m.suppressed ? 'rgba(229,72,77,0.35)' : '#e5484d';
      ctx.fillRect(x, 0, m.suppressed ? 1 : 2, height);
      if (!m.suppressed) {
        ctx.beginPath();
        ctx.moveTo(x - 5, 0);
        ctx.lineTo(x + 7, 0);
        ctx.lineTo(x + 1, 9);
        ctx.closePath();
        ctx.fill();
      }
      hits.push({ x0: x - 4, x1: x + 6, y0: 0, y1: AXIS_H, markerIdx: i });
    });

    // Scrubber cursor.
    if (cursorMs !== null) {
      const x = xOf(cursorMs, view, width);
      ctx.fillStyle = '#eaeef5';
      ctx.fillRect(x, 0, 1, height);
    }

    hitsRef.current = hits;
  }, [model, view, cursorMs, selected, width, height]);

  // --- interactions ---
  const bounds = model ? { t0: model.t0, t1: model.t1 } : { t0: 0, t1: 1 };

  // Audit A1: chronological span order for keyboard navigation.
  const sortedSpans = useMemo(
    () => (model ? [...model.spans].sort((a, b) => a.startMs - b.startMs) : []),
    [model]
  );

  const selectSpanAt = useCallback(
    (idx: number): void => {
      const s = sortedSpans[idx];
      if (!s) return;
      setSelected({ kind: 'span', span: s });
      setCursor(s.startMs);
      const v = useStore.getState().view;
      if (s.startMs < v.start || s.startMs > v.end) {
        const spanW = v.end - v.start;
        setView({ start: s.startMs - spanW / 2, end: s.startMs + spanW / 2 });
      }
    },
    [sortedSpans, setSelected, setCursor, setView]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const t = tOf(e.clientX - rect.left, useStore.getState().view, rect.width);
      const factor = e.deltaY > 0 ? 1.25 : 0.8;
      useStore.getState().setView(zoomAround(useStore.getState().view, t, factor, bounds));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [model]); // eslint-disable-line react-hooks/exhaustive-deps

  const hitTest = useCallback((x: number, y: number): HitRect | null => {
    for (const h of hitsRef.current) {
      if (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) return h;
    }
    return null;
  }, []);

  if (!model) return null;

  return (
    <div ref={wrapRef} className="timeline-wrap">
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="application"
        aria-label={`Incident timeline, ${model.spans.length} spans in ${model.laneCount} lanes. Arrow keys pan and step through spans, plus and minus zoom, 0 resets.`}
        style={{ width: `${width}px`, height: `${height}px`, cursor: 'crosshair' }}
        onKeyDown={(e) => {
          // Audit A1: full keyboard operation of the canvas surface.
          const v = useStore.getState().view;
          const spanW = v.end - v.start;
          const currentIdx =
            selected?.kind === 'span' ? sortedSpans.indexOf(selected.span) : -1;
          switch (e.key) {
            case 'ArrowLeft':
              setView(pan(v, -spanW * (e.shiftKey ? 0.5 : 0.1), bounds));
              break;
            case 'ArrowRight':
              setView(pan(v, spanW * (e.shiftKey ? 0.5 : 0.1), bounds));
              break;
            case '+':
            case '=':
              setView(zoomAround(v, v.start + spanW / 2, 0.8, bounds));
              break;
            case '-':
              setView(zoomAround(v, v.start + spanW / 2, 1.25, bounds));
              break;
            case 'ArrowDown':
              selectSpanAt(currentIdx === -1 ? 0 : Math.min(currentIdx + 1, sortedSpans.length - 1));
              break;
            case 'ArrowUp':
              selectSpanAt(currentIdx === -1 ? 0 : Math.max(currentIdx - 1, 0));
              break;
            case '0':
            case 'Home':
              setView({ start: model.t0, end: model.t1 });
              break;
            case 'Escape':
              setSelected(null);
              break;
            default:
              return;
          }
          e.preventDefault();
        }}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, view: { ...view }, moved: false };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const rect = canvasRef.current!.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          if (drag.current) {
            const dx = e.clientX - drag.current.x;
            if (Math.abs(dx) > 3) drag.current.moved = true;
            if (drag.current.moved) {
              const dt = (-dx / rect.width) * (drag.current.view.end - drag.current.view.start);
              setView(pan(drag.current.view, dt, bounds));
            }
            return;
          }
          const hit = hitTest(x, y);
          if (hit?.span) {
            setTooltip({
              x,
              y,
              text: `${hit.span.label} — ${formatDur(hit.span.endMs - hit.span.startMs)}${hit.span.open ? ' (in flight)' : ''}`
            });
          } else if (hit?.clusterSpans) {
            setTooltip({ x, y, text: `${hit.clusterSpans.length} events (zoom in)` });
          } else if (hit?.markerIdx !== undefined) {
            const m = model.markers[hit.markerIdx]!;
            setTooltip({ x, y, text: `▼ ${m.triggerType}${m.suppressed ? ' (suppressed)' : ''}` });
          } else {
            setTooltip(null);
          }
        }}
        onPointerUp={(e) => {
          const wasDrag = drag.current?.moved;
          drag.current = null;
          if (wasDrag) return;
          const rect = canvasRef.current!.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          const hit = hitTest(x, y);
          if (hit?.span) {
            setSelected({ kind: 'span', span: hit.span });
          } else if (hit?.markerIdx !== undefined) {
            setSelected({ kind: 'marker', marker: model.markers[hit.markerIdx]! });
          } else if (hit?.clusterSpans) {
            // Zoom into the cluster.
            const t0 = Math.min(...hit.clusterSpans.map((s) => s.startMs));
            const t1 = Math.max(...hit.clusterSpans.map((s) => s.endMs));
            const padding = Math.max((t1 - t0) * 0.2, 1);
            setView({ start: t0 - padding, end: t1 + padding });
            return;
          } else {
            setSelected(null);
          }
          setCursor(tOf(x, view, rect.width));
        }}
        onPointerLeave={() => setTooltip(null)}
        onDoubleClick={() => setView({ start: model.t0, end: model.t1 })}
      />
      {tooltip && (
        <div
          className="tooltip"
          // Audit L9: clamp so the tooltip never clips at the right edge.
          style={{ left: Math.max(0, Math.min(tooltip.x + 12, width - 230)), top: tooltip.y + 14 }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}

function drawSpan(
  ctx: CanvasRenderingContext2D,
  s: Span,
  x0: number,
  w: number,
  yTop: number,
  h: number,
  hits: HitRect[],
  selected: ReturnType<typeof useStore.getState>['selected']
): void {
  ctx.fillStyle = spanColor(s);
  ctx.fillRect(x0, yTop, w, h);
  if (s.open) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (let hx = x0 + 3; hx < x0 + w; hx += 6) ctx.fillRect(hx, yTop, 2, h);
  }
  // Audit A4: error/5xx must not be color-only — diagonal hatch as a
  // second channel (open spans already get vertical dashes).
  if (s.error || (s.status !== undefined && s.status >= 500)) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, yTop, w, h);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let hx = x0 - h; hx < x0 + w; hx += 5) {
      ctx.moveTo(hx, yTop + h);
      ctx.lineTo(hx + h, yTop);
    }
    ctx.stroke();
    ctx.restore();
  }
  if (selected?.kind === 'span' && selected.span === s) {
    ctx.strokeStyle = '#eaeef5';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0 - 0.5, yTop - 0.5, w + 1, h + 1);
  }
  if (w > 48 && s.depth === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(s.label.slice(0, Math.floor(w / 6)), x0 + 3, yTop + h - 2);
  }
  hits.push({ x0, x1: x0 + w, y0: yTop, y1: yTop + h, span: s });
}
