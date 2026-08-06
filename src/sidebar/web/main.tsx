/** Browser entrypoint: the page shell links the compiled stylesheet before mounting the app. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

/**
 * The theme is class-based (`.dark`), so something has to set the class. cmux's own themes are
 * set to `inherit`, meaning cmux follows macOS — and this page gets the same signal, so following
 * the media query is what keeps the Dock surface matching cmux. The listener means a mid-session
 * appearance switch is picked up without a reload.
 */
function followSystemTheme(): void {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = (dark: boolean): void => {
    document.documentElement.classList.toggle("dark", dark);
    // Native controls and scrollbars need telling too, or they stay light on a dark surface.
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  };
  apply(prefersDark.matches);
  prefersDark.addEventListener("change", (event) => apply(event.matches));
}

followSystemTheme();

const container = document.getElementById("root");
if (!container) throw new Error("sidebar root element is missing");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
