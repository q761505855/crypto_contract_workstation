import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    env: { VITE_GITHUB_TOKEN: '' },
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    exclude: [
      ...configDefaults.exclude,
      'e2e/**',
      '.worktrees/**',
      'worktrees/**',
    ],
  },
})
