import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initToken } from "./api";
import { App } from "./App";

// Before anything reads location.hash for routing: `#token=…` is consumed and removed here.
initToken();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
