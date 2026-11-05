/**
 * view-settings.ts — the `betterDiagrams.*` view settings, read as the editor
 * uses them. Pure, so both the extension and its unit tests share it: a
 * value someone typed into settings.json that isn't one of the choices falls
 * back to its default rather than reaching the studio.
 */
import { VIEW_DEFAULTS, type ViewSettings } from "./protocol";

/** Every view setting's key, as it sits under `betterDiagrams.`. */
export const VIEW_KEYS = Object.keys(VIEW_DEFAULTS) as Array<keyof ViewSettings>;

const ACCENT = /^#[0-9a-f]{6}$/i;

/** One setting's value, or its default when the value isn't one it can take. */
function settled<K extends keyof ViewSettings>(key: K, value: unknown): ViewSettings[K] {
  const fallback = VIEW_DEFAULTS[key];
  switch (key) {
    case "theme":
      return (value === "auto" || value === "light" || value === "dark" ? value : fallback) as ViewSettings[K];
    case "presentation":
      return (value === "marketing" || value === "technical" ? value : fallback) as ViewSettings[K];
    case "accent":
      return (typeof value === "string" && ACCENT.test(value.trim()) ? value.trim().toLowerCase() : "") as ViewSettings[K];
    default:
      return (typeof value === "boolean" ? value : fallback) as ViewSettings[K];
  }
}

/** The settings as `get` reads them, each one checked. */
export function viewFrom(get: (key: keyof ViewSettings) => unknown): ViewSettings {
  return Object.fromEntries(VIEW_KEYS.map((key) => [key, settled(key, get(key))])) as unknown as ViewSettings;
}

/** Only the keys of `change` that are view settings, each one checked: what the webview may write. */
export function viewChange(change: unknown): Partial<ViewSettings> {
  if (!change || typeof change !== "object") return {};
  const out: Partial<Record<keyof ViewSettings, unknown>> = {};
  for (const key of VIEW_KEYS) {
    if (key in change) out[key] = settled(key, (change as Record<string, unknown>)[key]);
  }
  return out as Partial<ViewSettings>;
}
