// One light/dark theme for the whole site: the Next pages and the Lab's static page.
// Default: follow the device. A click on the header's sun/moon button switches and saves the
// choice in localStorage; it is applied as data-theme="light|dark" on <html> by a tiny inline
// script in <head>, before the first paint.
// Plain .mjs so that scripts/sync-lab.mjs (Node) and the Next app can both import it.

export const THEME_KEY = "prophetf-theme";
export const DEVICE_DARK = "(prefers-color-scheme: dark)";
export const TOGGLE_ID = "theme-toggle";
/** The Lab's dark stylesheet: a <link> whose `media` says when it applies. */
export const LAB_DARK_LINK_ID = "lab-dark-css";

/** A saved choice, or null for "follow the device" (also for anything unexpected in storage). */
export const storedTheme = (value) => (value === "light" || value === "dark" ? value : null);

/** The theme to show: the saved choice, else the device's. */
export const resolveTheme = (stored, deviceDark) =>
  storedTheme(stored) ?? (deviceDark ? "dark" : "light");

export const nextTheme = (current) => (current === "dark" ? "light" : "dark");

/** The button's accessible name says what a click does. */
export const toggleLabel = (current) => `Switch to ${nextTheme(current)} mode`;

/** When a dark-only stylesheet applies: always, never, or with the device. */
export const darkSheetMedia = (stored) =>
  stored === "dark" ? "all" : stored === "light" ? "not all" : DEVICE_DARK;

/** Sun and moon, 24 x 24, drawn with the current text colour. CSS shows the one that applies. */
export const SUN_PATH =
  "M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66 1.41-1.41M4.93 19.07l1.41-1.41m11.32 0 1.41 1.41M4.93 4.93l1.41 1.41M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z";
export const MOON_PATH = "M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z";

/**
 * The script for <head>: applies a saved choice before anything is painted. With `darkLinkId`
 * it also switches that dark stylesheet on or off (the Lab). Storage that throws (private mode)
 * simply leaves the device's theme.
 */
export function themeHeadScript(darkLinkId = null) {
  return (
    `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});` +
    `if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);` +
    (darkLinkId
      ? `var l=document.getElementById(${JSON.stringify(darkLinkId)});if(l)l.media=t==="dark"?"all":"not all";`
      : "") +
    `}}catch(e){}})();`
  );
}

/**
 * The button's behaviour for a static page (the Lab); the Next pages use themeToggle.tsx, which
 * does the same with the helpers above.
 */
export function themeToggleScript(darkLinkId = null) {
  return (
    `(function(){var K=${JSON.stringify(THEME_KEY)},r=document.documentElement,` +
    `m=window.matchMedia?window.matchMedia(${JSON.stringify(DEVICE_DARK)}):null;` +
    `function cur(){var t=r.getAttribute("data-theme");return t==="light"||t==="dark"?t:(m&&m.matches?"dark":"light")}` +
    `function paint(){var b=document.getElementById(${JSON.stringify(TOGGLE_ID)});` +
    `if(b)b.setAttribute("aria-label","Switch to "+(cur()==="dark"?"light":"dark")+" mode")}` +
    `function set(t){r.setAttribute("data-theme",t);` +
    (darkLinkId
      ? `var l=document.getElementById(${JSON.stringify(darkLinkId)});if(l)l.media=t==="dark"?"all":"not all";`
      : "") +
    `try{localStorage.setItem(K,t)}catch(e){}paint()}` +
    `document.addEventListener("click",function(e){var b=e.target&&e.target.closest&&e.target.closest("#${TOGGLE_ID}");` +
    `if(b)set(cur()==="dark"?"light":"dark")});` +
    `if(m&&m.addEventListener)m.addEventListener("change",paint);` +
    `if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",paint);else paint()})();`
  );
}

const icon = (name, path) =>
  `<svg class="${name}" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;

/** The button as HTML, for the Lab's header. */
export const THEME_TOGGLE_HTML =
  `<button id="${TOGGLE_ID}" class="theme-toggle" type="button" aria-label="${toggleLabel("light")}">` +
  icon("moon", MOON_PATH) +
  icon("sun", SUN_PATH) +
  "</button>";
