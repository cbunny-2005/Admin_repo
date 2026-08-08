import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // GitHub Pages serves this repo at /Admin_repo/, not at the domain root, so every
  // asset URL must carry that prefix or the page loads and renders nothing but a
  // blank screen with 404s for the JS. Overridable for other hosts (Vercel, Netlify)
  // where the app IS at the root: BASE_PATH=/ npm run build
  base: process.env.BASE_PATH ?? '/Admin_repo/',
  plugins: [react(), tailwindcss()],
  server: {
    // 5173 is not an arbitrary default: it is the ONLY localhost origin present in
    // the backend's CORS_ORIGINS. Serve on any other port and every request fails
    // preflight with an opaque CORS error instead of anything actionable.
    port: 5173,
    strictPort: true,
  },
})
