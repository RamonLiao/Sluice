import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Providers } from "./providers.js";
import App from "./App.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>,
);
