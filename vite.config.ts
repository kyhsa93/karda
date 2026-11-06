/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/karda/',
  plugins: [react()],
  build: { assetsDir: 'static', manifest: true },
  test: { testTimeout: 20000 },
});
