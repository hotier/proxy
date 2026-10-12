// @ts-check
import { defineConfig } from 'astro/config';
import deno from '@deno/astro-adapter';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import staticCompress from './src/integrations/static-compress.ts';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: deno(),
  integrations: [react(), staticCompress()],

  vite: {
    plugins: [tailwindcss()],
  }
});
