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
    // 5173 is not an arbitrary default: it is the ONLY localhost origin present in
    // the backend's CORS_ORIGINS. Serve on any other port and every request fails
    // preflight with an opaque CORS error instead of anything actionable.
    port: 5173,
    strictPort: true,
  },
})
