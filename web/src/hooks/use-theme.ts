import { useSyncExternalStore } from "react";

export type ThemeChoice = "light" | "dark" | "system";
const KEY = "wtm-theme";
const listeners = new Set<() => void>();
const media = window.matchMedia("(prefers-color-scheme: dark)");

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* storage unavailable */
  }
  return "system";
}

let choice = read();

function resolved(): "light" | "dark" {
  return choice === "system" ? (media.matches ? "dark" : "light") : choice;
}

function apply() {
  document.documentElement.classList.toggle("dark", resolved() === "dark");
  listeners.forEach((l) => l());
}

media.addEventListener("change", apply);
apply();

export function setTheme(next: ThemeChoice) {
  choice = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* ignore */
  }
  apply();
}

let snapshot = `${choice}|${resolved()}`;
function getSnapshot() {
  const s = `${choice}|${resolved()}`;
  if (s !== snapshot) snapshot = s;
  return snapshot;
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useTheme(): {
  choice: ThemeChoice;
  theme: "light" | "dark";
  setTheme: (t: ThemeChoice) => void;
} {
  const [c, r] = useSyncExternalStore(subscribe, getSnapshot).split("|");
  return { choice: c as ThemeChoice, theme: r as "light" | "dark", setTheme };
}
