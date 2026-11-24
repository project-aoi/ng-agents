import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initLocale } from "./i18n";

initLocale();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
