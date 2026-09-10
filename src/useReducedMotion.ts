import { useSyncExternalStore } from "react";

const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
const subscribe = (onChange: () => void) => {
  preference.addEventListener("change", onChange);
  return () => preference.removeEventListener("change", onChange);
};

export function useReducedMotion() {
  return useSyncExternalStore(subscribe, () => preference.matches);
}
