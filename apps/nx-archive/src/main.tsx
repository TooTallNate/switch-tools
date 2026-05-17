import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import "./index.css"
import { initVfs } from "./lib/vfs"

// Kick off the service-worker registration that backs `/vfs/`
// URLs. Doesn't block rendering — the SW is needed only when the
// user later requests a media / image / download for a lazy-
// facade resource, and `isVfsAvailable()` reports its readiness
// at that point so callers can fall back gracefully.
void initVfs()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
