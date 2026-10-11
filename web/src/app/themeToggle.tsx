"use client";

// The sun/moon button in the shared header. The theme lives on <html data-theme> (set before
// paint by the inline script in layout.tsx) and in localStorage; this button only switches it.
// The Lab's static page has the same button, driven by themeToggleScript in lib/theme/theme.mjs.
import { useSyncExternalStore } from "react";
import {
  DEVICE_DARK,
  MOON_PATH,
  SUN_PATH,
  THEME_KEY,
  TOGGLE_ID,
  nextTheme,
  resolveTheme,
  toggleLabel,
  type Theme,
} from "@/lib/theme/theme.mjs";

const CHANGED = "prophetf-theme-changed";

function current(): Theme {
  return resolveTheme(
    document.documentElement.getAttribute("data-theme"),
    window.matchMedia?.(DEVICE_DARK).matches ?? false,
  );
}

function subscribe(onChange: () => void) {
  const device = window.matchMedia?.(DEVICE_DARK);
  device?.addEventListener("change", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    device?.removeEventListener("change", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

function Icon({ name, path }: { name: string; path: string }) {
  return (
    <svg
      className={name}
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={path} />
    </svg>
  );
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  // On the server and during hydration the label is the light one; it is corrected right after.
  const theme = useSyncExternalStore<Theme>(subscribe, current, () => "light");

  function toggle() {
    const next = nextTheme(current());
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private mode: the choice holds for this page only.
    }
    window.dispatchEvent(new Event(CHANGED));
  }

  return (
    <button
      id={TOGGLE_ID}
      type="button"
      onClick={toggle}
      aria-label={toggleLabel(theme)}
      className={`theme-toggle grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-blue-soft hover:text-blue ${className}`}
    >
      <Icon name="moon" path={MOON_PATH} />
      <Icon name="sun" path={SUN_PATH} />
    </button>
  );
}
