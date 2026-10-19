import { emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api } from '@/infrastructure/api/service-api/ApiClient';

export const DESKTOP_CARD_WINDOW_KIND = 'desktop-card';

export function isDesktopCardWindowLocation(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get('openbitfunWindow') === DESKTOP_CARD_WINDOW_KIND;
}

export function readDesktopCardIdFromLocation(search: string = window.location.search): string | null {
  const cardId = new URLSearchParams(search).get('cardId')?.trim();
  return cardId && /^[A-Za-z0-9_-]{1,64}$/.test(cardId) ? cardId : null;
}

/** Moves the borderless card window with the OS drag loop. */
export async function startDesktopCardWindowDrag(): Promise<void> {
  await getCurrentWindow().startDragging();
}

/** Opens the session that created a card in the main window. */
export async function openDesktopCardSourceSession(sessionId: string): Promise<void> {
  await emit('agent-companion://open-session', { sessionId });
  await api.invoke('show_main_window');
}

export async function showOpenBitFunMainWindow(): Promise<void> {
  await api.invoke('show_main_window');
}
