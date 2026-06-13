import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

export default defineConfig({
  site: 'https://voley-gong.github.io',
  base: '/game-dev-interview/',
  integrations: [react()],
});
