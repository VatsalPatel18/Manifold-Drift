import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Use repo name for GH Pages in production, '/' in dev
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'production' ? '/vatsalpatel18-manifold-drift/' : '/',
}))
