import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
 const env = loadEnv(mode, process.cwd(), '')
 const target = env.VITE_PLATFORM_TARGET || 'http://127.0.0.1:8780'
 return {
  base: './',
  build: { rollupOptions: { input: { main: path.resolve(import.meta.dirname, 'index.html'), scheduler: path.resolve(import.meta.dirname, 'scheduler.html') } } },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      '@capability-table': path.resolve(import.meta.dirname, '../底层能力/表格组件/src'),
      '@capability-ui': path.resolve(import.meta.dirname, '../底层能力/交互组件/src/ui'),
    },
    dedupe: ['react', 'react-dom', 'cn', 'radix-ui', 'class-variance-authority', 'lucide-react', 'cmdk', 'recharts', 'motion'],
  },
  server: {
    proxy: {
      '/ai': { target, changeOrigin: true, configure(proxy) { proxy.on('proxyReq', (request, incoming) => { if (incoming.headers.origin === `http://${incoming.headers.host}`) request.setHeader('Origin', new URL(target).origin) }) } },
      '/platform': { target, changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (request, incoming) => {
            // Rewrite only verified same-origin development requests.
            if (incoming.headers.origin === `http://${incoming.headers.host}`) request.setHeader('Origin', new URL(target).origin)
          })
          proxy.on('proxyRes', (response, incoming) => {
            const csp = response.headers['content-security-policy']
            if (typeof csp === 'string') response.headers['content-security-policy'] = csp.replaceAll(new URL(target).origin, `http://${incoming.headers.host}`)
          })
        },
      },
    },
    fs: {
      allow: [path.resolve(import.meta.dirname, '..')],
    },
  },
 }
})
