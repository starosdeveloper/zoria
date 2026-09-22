import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // .env files live at the repository root next to .env.example
  envDir: '../..',
  server: { port: 5173, strictPort: false },
  build: { target: 'es2022', sourcemap: true },
});
