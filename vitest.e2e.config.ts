import { defineConfig } from 'vitest/config'

/**
 * End-to-end tests that require a real Python + CadQuery installation.
 * Each test skips itself when the backend is not detectable on this machine.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.e2e.ts'],
    testTimeout: 300_000,
  },
})
