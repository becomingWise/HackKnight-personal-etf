// The site's one light/dark theme: the helpers, the two inline scripts (run here against a small
// fake page), and the CSS that must agree with them.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEVICE_DARK,
  LAB_DARK_LINK_ID,
  THEME_KEY,
  THEME_TOGGLE_HTML,
  TOGGLE_ID,
  darkSheetMedia,
  nextTheme,
  resolveTheme,
  storedTheme,
  themeHeadScript,
  themeToggleScript,
  toggleLabel,
} from "./theme.mjs";

describe("the theme helpers", () => {
  it("stores the choice under one key", () => {
    expect(THEME_KEY).toBe("prophetf-theme");
  });

  it("accepts only light or dark from storage", () => {
    expect(storedTheme("dark")).toBe("dark");
    expect(storedTheme("light")).toBe("light");
    for (const value of [null, undefined, "", "auto", "DARK", 1, {}]) {
      expect(storedTheme(value)).toBeNull();
    }
  });

  it("follows the device until a choice is saved", () => {
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme(null, false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("nonsense", true)).toBe("dark");
  });

  it("a click switches, and the label says what the click does", () => {
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("light");
    expect(toggleLabel("light")).toBe("Switch to dark mode");
    expect(toggleLabel("dark")).toBe("Switch to light mode");
  });

  it("says when the Lab's dark stylesheet applies", () => {
    expect(darkSheetMedia(null)).toBe(DEVICE_DARK);
    expect(darkSheetMedia("dark")).toBe("all");
    expect(darkSheetMedia("light")).toBe("not all");
  });
});

/** A page with just enough of the DOM for the two scripts. */
function fakePage(
  options: { stored?: string | null; deviceDark?: boolean; storage?: "throws" } = {},
) {
  const attributes = new Map<string, string>();
  const store = new Map<string, string>();
  if (options.stored) store.set(THEME_KEY, options.stored);
  const link = { media: DEVICE_DARK };
  const button = { label: "", setAttribute: (_: string, value: string) => (button.label = value) };
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const document = {
    readyState: "complete",
    documentElement: {
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      getAttribute: (name: string) => attributes.get(name) ?? null,
    },
    getElementById: (id: string) =>
      id === LAB_DARK_LINK_ID ? link : id === TOGGLE_ID ? button : null,
    addEventListener: (type: string, fn: (event: unknown) => void) =>
      (listeners[type] ??= []).push(fn),
  };
  const localStorage = {
    getItem: (key: string) => {
      if (options.storage === "throws") throw new Error("denied");
      return store.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (options.storage === "throws") throw new Error("denied");
      store.set(key, value);
    },
  };
  const window = {
    matchMedia: () => ({ matches: options.deviceDark === true, addEventListener: () => {} }),
  };
  const run = (script: string) =>
    new Function("document", "localStorage", "window", script)(document, localStorage, window);
  const click = () => listeners.click?.forEach((fn) => fn({ target: { closest: () => button } }));
  return { run, click, attributes, store, link, button };
}

describe("the script in <head>", () => {
  it("applies a saved choice and leaves the device's theme otherwise", () => {
    const dark = fakePage({ stored: "dark" });
    dark.run(themeHeadScript());
    expect(dark.attributes.get("data-theme")).toBe("dark");

    const none = fakePage();
    none.run(themeHeadScript());
    expect(none.attributes.has("data-theme")).toBe(false);

    const junk = fakePage({ stored: "purple" });
    junk.run(themeHeadScript());
    expect(junk.attributes.has("data-theme")).toBe(false);
  });

  it("in the Lab it also switches the dark stylesheet", () => {
    const dark = fakePage({ stored: "dark" });
    dark.run(themeHeadScript(LAB_DARK_LINK_ID));
    expect(dark.link.media).toBe("all");

    const light = fakePage({ stored: "light", deviceDark: true });
    light.run(themeHeadScript(LAB_DARK_LINK_ID));
    expect(light.attributes.get("data-theme")).toBe("light");
    expect(light.link.media).toBe("not all");

    const none = fakePage({ deviceDark: true });
    none.run(themeHeadScript(LAB_DARK_LINK_ID));
    expect(none.link.media).toBe(DEVICE_DARK);
  });

  it("does nothing, and does not throw, when storage is blocked", () => {
    const page = fakePage({ storage: "throws", deviceDark: true });
    expect(() => page.run(themeHeadScript(LAB_DARK_LINK_ID))).not.toThrow();
    expect(page.attributes.has("data-theme")).toBe(false);
    expect(page.link.media).toBe(DEVICE_DARK);
  });

  it("is small and cannot close its own script tag", () => {
    for (const script of [
      themeHeadScript(),
      themeHeadScript(LAB_DARK_LINK_ID),
      themeToggleScript(LAB_DARK_LINK_ID),
    ]) {
      expect(script).not.toContain("</");
      expect(script.length).toBeLessThan(1200);
    }
  });
});

describe("the button on the Lab's static page", () => {
  it("labels itself from the device, then switches, saves and relabels on each click", () => {
    const page = fakePage({ deviceDark: true });
    page.run(themeToggleScript(LAB_DARK_LINK_ID));
    expect(page.button.label).toBe("Switch to light mode");

    page.click();
    expect(page.attributes.get("data-theme")).toBe("light");
    expect(page.store.get(THEME_KEY)).toBe("light");
    expect(page.link.media).toBe("not all");
    expect(page.button.label).toBe("Switch to dark mode");

    page.click();
    expect(page.attributes.get("data-theme")).toBe("dark");
    expect(page.store.get(THEME_KEY)).toBe("dark");
    expect(page.link.media).toBe("all");
    expect(page.button.label).toBe("Switch to light mode");
  });

  it("still switches when the choice cannot be saved", () => {
    const page = fakePage({ storage: "throws" });
    page.run(themeToggleScript(LAB_DARK_LINK_ID));
    expect(() => page.click()).not.toThrow();
    expect(page.attributes.get("data-theme")).toBe("dark");
    expect(page.link.media).toBe("all");
  });

  it("is a real button with a label and both icons", () => {
    expect(THEME_TOGGLE_HTML).toContain(`<button id="${TOGGLE_ID}"`);
    expect(THEME_TOGGLE_HTML).toContain('type="button"');
    expect(THEME_TOGGLE_HTML).toContain('aria-label="Switch to dark mode"');
    expect(THEME_TOGGLE_HTML).toContain('class="moon"');
    expect(THEME_TOGGLE_HTML).toContain('class="sun"');
  });
});

describe("the CSS agrees with the scripts", () => {
  const css = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const variables = (block: string) =>
    [...block.matchAll(/(--[a-z-]+):\s*([^;]+);/g)].map(([, name, value]) => `${name}:${value}`);

  it("globals.css: dark under data-theme, and under the device only without a choice", () => {
    const text = css("src/app/globals.css");
    const chosen = text.match(/:root\[data-theme="dark"\] \{([^}]+)\}/)?.[1];
    const device = text.match(
      /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme\]\) \{([^}]+)\}/,
    )?.[1];
    expect(chosen).toBeTruthy();
    expect(device).toBeTruthy();
    expect(variables(chosen!).length).toBeGreaterThanOrEqual(13);
    // The two dark blocks must not drift apart.
    expect(variables(device!)).toEqual(variables(chosen!));
    // No dark rule may apply to a visitor who chose light.
    expect(text).not.toMatch(/@media \(prefers-color-scheme: dark\) \{\s*:root \{/);
  });

  it("the Lab's page loads the dark stylesheet, the head script and the button", () => {
    const page = css("public/lab-static/index.html");
    const link = `<link id="${LAB_DARK_LINK_ID}" rel="stylesheet" href="/lab-own/lab-dark.css" media="${DEVICE_DARK}">`;
    expect(page).toContain(`${link}<script>${themeHeadScript(LAB_DARK_LINK_ID)}</script>`);
    // Before <body>: applied before the first paint.
    expect(page.indexOf(link)).toBeLessThan(page.indexOf("<body"));
    expect(page).toContain(THEME_TOGGLE_HTML);
    expect(page).toContain(`<script>${themeToggleScript(LAB_DARK_LINK_ID)}</script>`);
  });

  it("the Lab's dark stylesheet overrides every colour variable of the Lab", () => {
    const text = css("public/lab-own/lab-dark.css");
    const root = text.match(/:root \{([^}]+)\}/)?.[1] ?? "";
    const names = variables(root).map((entry) => entry.split(":")[0]);
    expect(names).toEqual([
      "--bg",
      "--ink",
      "--muted",
      "--blue",
      "--line",
      "--purple",
      "--red",
      "--glass",
      "--shadow",
    ]);
    // Written once: the condition is on the <link>, not in the file.
    expect(text).not.toContain("@media");
    expect(text).not.toContain("data-theme");
  });
});
