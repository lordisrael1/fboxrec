import { Component, type ReactNode } from 'react';

/**
 * Last-resort guard (audit H2): a render throw must never leave a forensic
 * tool as a silent blank page. Shows the error and a way back to the drop
 * zone (a full reload — simplest state reset that cannot itself fail).
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="dropzone" role="alert">
        <div className="dz-logo">🛩 flightbox</div>
        <div className="dz-big">This incident couldn’t be rendered</div>
        <div className="dz-error">{this.state.error.message}</div>
        <div className="dim pad">
          The file may be corrupt or from an incompatible version.{' '}
          <button className="ghost" onClick={() => window.location.assign(window.location.pathname)}>
            open another file
          </button>
        </div>
      </div>
    );
  }
}
