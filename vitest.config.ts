import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Default env is node (fast, no jsdom overhead). Files that need DOM
    // declare `// @vitest-environment jsdom` in a top-of-file header.
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'src/**/*.spec.ts',
      // Extension tests live alongside the JS they cover (extension/ is
      // outside src/ because it's a Chrome MV3 bundle, not Electron code).
      'extension/**/*.test.js',
      'extension/**/*.test.ts',
    ],
  },
})
