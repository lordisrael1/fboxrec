import { create } from 'zustand';
import { parseIncident, type Incident } from '@flightbox/format';
import { buildModel, type Model, type Span, type LogLine, type Marker } from '../lib/layout';
import { clampView, type View } from '../lib/timescale';

export type Selection =
  | { kind: 'span'; span: Span }
  | { kind: 'log'; log: LogLine }
  | { kind: 'marker'; marker: Marker };

interface ViewerState {
  incident: Incident | null;
  model: Model | null;
  error: string | null;
  loading: boolean;
  /** Audit I3: a remote ?src= URL awaiting the user's confirmation. */
  pendingSrc: string | null;
  view: View;
  cursorMs: number | null;
  selected: Selection | null;

  loadBytes(input: Uint8Array | ArrayBuffer | string): Promise<void>;
  loadUrl(url: string): Promise<void>;
  setPendingSrc(url: string | null): void;
  confirmPendingSrc(): Promise<void>;
  reset(): void;
  setView(view: View): void;
  setCursor(t: number | null): void;
  setSelected(sel: Selection | null): void;
}

export const useStore = create<ViewerState>()((set, get) => ({
  incident: null,
  model: null,
  error: null,
  loading: false,
  pendingSrc: null,
  view: { start: 0, end: 1 },
  cursorMs: null,
  selected: null,

  async loadBytes(input) {
    set({ loading: true, error: null });
    try {
      const incident = await parseIncident(input);
      const model = buildModel(incident);
      set({
        incident,
        model,
        loading: false,
        view: { start: model.t0, end: model.t1 },
        cursorMs: model.markers.find((m) => !m.suppressed)?.t ?? null,
        selected: null
      });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async loadUrl(url) {
    set({ loading: true, error: null });
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
      await get().loadBytes(await res.arrayBuffer());
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  setPendingSrc(pendingSrc) {
    set({ pendingSrc });
  },

  async confirmPendingSrc() {
    const src = get().pendingSrc;
    if (!src) return;
    set({ pendingSrc: null });
    await get().loadUrl(src);
  },

  reset() {
    set({
      incident: null,
      model: null,
      error: null,
      loading: false,
      pendingSrc: null,
      view: { start: 0, end: 1 },
      cursorMs: null,
      selected: null
    });
  },

  setView(view) {
    const model = get().model;
    set({ view: model ? clampView(view, { t0: model.t0, t1: model.t1 }) : view });
  },

  setCursor(cursorMs) {
    set({ cursorMs });
  },

  setSelected(selected) {
    set({ selected });
  }
}));
