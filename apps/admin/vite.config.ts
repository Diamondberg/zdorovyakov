import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('.',import.meta.url)),base:'/admin/',build:{outDir:'../../dist/admin',emptyOutDir:false}});
