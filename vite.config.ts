import { defineConfig } from 'vite';

export default defineConfig({
  base: '/middleground/',
  build: {
    target: 'es2020',
    assetsInlineLimit: 8192
  },
  test: {
    environment: 'node'
  }
} as any);
