import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 5173 is not an arbitrary default: it is the ONLY localhost origin present in
    // the backend's CORS_ORIGINS. Serve on any other port and every request fails
    // preflight with an opaque CORS error instead of anything actionable.
    port: 5173,
    strictPort: true,
  },
})
