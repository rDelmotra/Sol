import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import glsl from 'vite-plugin-glsl';

export default defineConfig({
  plugins: [
    react(),
    glsl(),
  ],
  // wasm-sgp4's JS glue resolves its .wasm binary via `new URL(..., import.meta.url)`.
  // esbuild pre-bundling would inline the glue and break that URL — keep it unbundled
  // so Vite's native asset handling emits/serves the .wasm correctly (dev + build).
  optimizeDeps: {
    exclude: ['wasm-sgp4'],
  },
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
