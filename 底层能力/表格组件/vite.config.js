import { defineConfig } from 'vite';

export default defineConfig({
  base: '/capabilities/table-kernel/',
  build: { reportCompressedSize: false },
  server: {
    port: 5177,
    strictPort: true,
    host: '127.0.0.1',
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: [
      '@univerjs/presets',
      '@univerjs/preset-sheets-core',
      '@univerjs/preset-sheets-data-validation',
      '@univerjs/preset-sheets-filter',
      '@univerjs/preset-sheets-sort',
      'exceljs',
    ],
  },
});
