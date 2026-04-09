import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/anonym-vote/',
  define: {
    // Required for @polkadot packages in browser
    global: 'globalThis',
  },
});
