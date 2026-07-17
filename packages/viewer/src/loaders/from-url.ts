import { useStore } from '../state/store';

/**
 * `?src=<url>` path: presigned magic links (browser -> the developer's own
 * bucket) and the CLI's local `/__incident-<id>` — same code path (§8).
 *
 * Audit I3: same-origin sources (the CLI's relative path) load immediately;
 * remote URLs are held as `pendingSrc` until the user confirms the host —
 * a crafted link must not fetch-and-display attacker content as if it were
 * the user's own incident without at least naming its origin.
 */
export async function loadFromQueryParam(): Promise<boolean> {
  const src = new URLSearchParams(window.location.search).get('src');
  if (!src) return false;
  if (src.startsWith('/')) {
    await useStore.getState().loadUrl(src);
    return true;
  }
  // Remote sources: http(s) only, no embedded credentials — reject
  // javascript:/data:/file: and user:pass@ forms outright.
  try {
    const u = new URL(src);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      throw new Error('unsupported scheme');
    }
    if (u.username || u.password) {
      throw new Error('credentials in URL');
    }
  } catch {
    useStore.getState().setPendingSrc(null);
    useStore.setState({
      error: 'The ?src= link is not a valid http(s) URL — refusing to load it.'
    });
    return true;
  }
  useStore.getState().setPendingSrc(src);
  return true;
}
