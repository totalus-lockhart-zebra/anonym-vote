import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  // `vite-plugin-wasm` teaches Vite how to handle the
  // `import * as wasm from './x.wasm'` pattern emitted by wasm-pack's
  // `--target bundler` output (which is what `ring-sig-wasm` uses).
  // Without it, Vite throws "ESM integration proposal for Wasm is not
  // supported currently" the moment anything reachable imports from
  // `ring-sig-wasm`.
  plugins: [react(), wasm()],
  base: '/',
  define: {
    // Required for @polkadot packages in browser
    global: 'globalThis',
  },
});
