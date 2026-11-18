import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const { VITE_API_ORIGIN: apiOrigin } = loadEnv(mode, process.cwd(), 'VITE_');
  if (apiOrigin) {
    const url = new URL(apiOrigin);
    if (url.protocol !== 'https:' || url.origin !== apiOrigin.replace(/\/$/, '')) {
      throw new Error('VITE_API_ORIGIN must be an HTTPS origin without a path');
    }
  }
  return {
    base: './',
    server: { proxy: { '/api': 'http://127.0.0.1:8000' } },
  };
});
