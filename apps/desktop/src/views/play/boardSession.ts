import { useApp } from "../../state/app";

/**
 * Board games in progress (Oware, Nam-nam, Ayò, Ludo). A game is kept while the studio runs and in
 * the app's settings ("board.*" keys, small and not audited), so leaving the Play view or quitting
 * pauses it instead of losing it. A saved game is only restored under the same rules: `rules` is a
 * hash of the rule graph it was played with.
 */
export interface BoardSession<T> {
  rules: string;
  savedAt: string;
  data: T;
}

const live = new Map<string, BoardSession<unknown>>();
const pending = new Map<string, number>();

/** FNV-1a, as a short base-36 string: stable keys and rule versions, not security. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** The settings key for a project's board game (setting names allow letters, digits, dots, dashes and underscores). */
export function sessionKey(root: string, graphPath: string): string {
  return `board.${hashText(`${root}|${graphPath}`)}`;
}

export function loadSession<T>(key: string, rules: string): BoardSession<T> | null {
  const stored = (live.get(key) ?? useApp.getState().settings[key]) as BoardSession<T> | undefined;
  if (!stored || typeof stored !== "object" || stored.rules !== rules || stored.data === undefined) return null;
  return stored;
}

function persist(key: string): void {
  window.clearTimeout(pending.get(key));
  pending.delete(key);
  const session = live.get(key);
  if (session) void useApp.getState().setSetting(key, session);
}

/** Keep the game now, and in the app's settings shortly after (at once with `now`, for pausing and leaving). */
export function saveSession<T>(key: string, rules: string, data: T, now = false): void {
  live.set(key, { rules, savedAt: new Date().toISOString(), data });
  if (now) return persist(key);
  window.clearTimeout(pending.get(key));
  pending.set(key, window.setTimeout(() => persist(key), 2000));
}

/** Forget a game (a new game was started, or it can no longer be restored). */
export function clearSession(key: string): void {
  window.clearTimeout(pending.get(key));
  pending.delete(key);
  live.delete(key);
  if (useApp.getState().settings[key] !== undefined) void useApp.getState().setSetting(key, null);
}

/** P pauses and resumes, unless the person is typing somewhere. */
export function isPauseKey(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (e.metaKey || e.ctrlKey || e.altKey || (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)))) return false;
  return e.key === "p" || e.key === "P";
}
