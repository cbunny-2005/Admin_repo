import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // Vercel serves this at the domain root, so the default is '/'. BASE_PATH exists
  // for hosts that serve from a subpath (GitHub Pages would need '/Admin_repo/'),
  // where the wrong base loads the page and then 404s on its own JS — a blank screen
  // with no error a user could interpret.
  base: process.env.BASE_PATH ?? '/',
  plugins: [react(), tailwindcss()],
  server: {
    // 5174 is not an arbitrary default: it is one of the three localhost origins in
    // the backend's CORS_ORIGINS (5173, 5174, 3000). Serve on any other port and
    // every request fails preflight with an opaque CORS error instead of anything
    // actionable — 5175 was tried and produced exactly that.
    port: 5174,
    strictPort: true,
  },
})
