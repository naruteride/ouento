import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  clearScreen: false,
  resolve: {
    alias: {
      '@framework': fileURLToPath(new URL('./vendor/cubism-framework/src', import.meta.url)),
      '@motionsync': fileURLToPath(new URL('./vendor/motionsync/src', import.meta.url)),
    },
  },
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  build: {
    target: ['es2022', 'chrome105', 'safari15'],
    rollupOptions: {
      input: {
        main: 'index.html',
        companion: 'companion.html',
        speechBubble: 'speech-bubble.html',
      },
    },
  },
});
