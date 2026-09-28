import { defineConfig } from 'vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => ({
  root: path.resolve(__dirname, 'webview'),
  base: './',  // Use relative paths for VS Code webview
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
  ],
  resolve: {
    alias: [
      { find: '@openchamber/sdk/schemas', replacement: path.resolve(__dirname, '../sdk/src/schemas.ts') },
      { find: '@openchamber/sdk', replacement: path.resolve(__dirname, '../sdk/src/index.ts') },
      { find: '@openchamber/ui', replacement: path.resolve(__dirname, '../ui/src') },
      { find: '@vscode', replacement: path.resolve(__dirname, './webview') },
      { find: '@', replacement: path.resolve(__dirname, '../ui/src') },
    ],
  },
  worker: {
    format: 'es',
    // VS Code webviews cannot load module imports from inside a web worker.
    // Keep the Shiki worker self-contained instead of emitting grammar chunks.
    rolldownOptions: {
      output: {
        codeSplitting: false,
      },
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode === 'production' ? 'production' : 'development'),
    'global': 'globalThis',
    '__OPENCHAMBER_WEBVIEW_BUILD_TIME__': JSON.stringify(new Date().toISOString()),
  },
  envPrefix: ['VITE_'],
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    cors: true,
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
    hmr: {
      host: 'localhost',
      protocol: 'ws',
      port: 5173,
    },
  },
  optimizeDeps: {
    include: ['@opencode/client'],
  },
  build: {
    // Vite 7's default target, kept explicitly across the Vite 8 upgrade so the
    // emitted syntax does not change with the version (Vite 8's default is
    // chrome111/edge111/firefox114/safari16.4/ios16.4).
    target: ['chrome107', 'edge107', 'firefox104', 'safari16'],
    // esbuild minifies JS and CSS as it did under Vite 7. Vite 8's defaults
    // (Oxc for JS, Lightning CSS for CSS) change the output: Lightning CSS merges
    // selectors into :is() (which changes specificity) and polyfills a
    // dependency's light-dark() through CSS color-scheme, which this app mostly
    // sets from JS. Moving to them is a separate, measured change.
    minify: 'esbuild',
    cssMinify: 'esbuild',
    outDir: path.resolve(__dirname, 'dist/webview'),
    emptyOutDir: true,
    rolldownOptions: {
      input: path.resolve(__dirname, 'webview/index.html'),
      external: ['node:child_process', 'node:fs', 'node:path', 'node:url'],
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
}));
