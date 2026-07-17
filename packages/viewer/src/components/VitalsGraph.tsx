import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { xOf } from '../lib/timescale';

/** Event-loop lag line + heap area, synced to the timeline's view window. */

const H = 62;

export function VitalsGraph() {
  const model = useStore((s) => s.model);
  const view = useStore((s) => s.view);
  const cursorMs = useStore((s) => s.cursorMs);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !model) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(H * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, H);
    if (model.vitals.length === 0) {
      ctx.fillStyle = '#5b6474';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText('no vitals in this capture', 8, 20);
      return;
    }

    const maxHeap = Math.max(...model.vitals.map((v) => v.heapUsed), 1);
    const maxLag = Math.max(...model.vitals.map((v) => v.maxLagMs), 10);

    // Heap area (background).
    ctx.beginPath();
    ctx.moveTo(xOf(model.vitals[0]!.t, view, width), H);
    for (const v of model.vitals) {
      ctx.lineTo(xOf(v.t, view, width), H - (v.heapUsed / maxHeap) * (H - 10));
    }
    ctx.lineTo(xOf(model.vitals[model.vitals.length - 1]!.t, view, width), H);
    ctx.closePath();
    ctx.fillStyle = 'rgba(62,123,250,0.18)';
    ctx.fill();

    // Lag line (foreground) — the "is it CPU?" witness.
    ctx.beginPath();
    let started = false;
    for (const v of model.vitals) {
      const x = xOf(v.t, view, width);
      const y = H - (Math.min(v.maxLagMs, maxLag) / maxLag) * (H - 10);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = '#f5a524';
    ctx.lineWidth = 1.25;
    ctx.stroke();

    // Legends.
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = '#f5a524';
    ctx.fillText(`loop lag (max ${maxLag.toFixed(0)}ms)`, 6, 12);
    ctx.fillStyle = '#7da2f7';
    ctx.fillText(`heap (max ${(maxHeap / 1048576).toFixed(0)}MB)`, 150, 12);

    if (cursorMs !== null) {
      ctx.fillStyle = '#eaeef5';
      ctx.fillRect(xOf(cursorMs, view, width), 0, 1, H);
    }
  }, [model, view, cursorMs, width]);

  if (!model) return null;
  return (
    <div ref={wrapRef} className="vitals-wrap">
      <canvas ref={canvasRef} style={{ width: `${width}px`, height: `${H}px` }} />
    </div>
  );
}
