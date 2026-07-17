import { useStore } from '../state/store';

/**
 * Drag-and-drop / file picker path: FileReader -> parse, ALL in-browser.
 * The file never leaves the machine — this is the privacy pitch (§8).
 */
export async function loadFromFile(file: File): Promise<void> {
  const bytes = await file.arrayBuffer();
  await useStore.getState().loadBytes(bytes);
}
