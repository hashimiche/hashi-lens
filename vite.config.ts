import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
    plugins: [react()],
    server: {
        host: process.env.VITE_BIND_HOST || '0.0.0.0',
        port: Number(process.env.VITE_PORT) || 9000,
        hmr: {
            host: process.env.VITE_HOSTNAME || 'hal.localhost',
        },
        proxy: {
            '/api': {
                target: `http://localhost:${process.env.API_PORT || 9001}`,
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api/, '')
            }
        }
    },
    build: {
        outDir: 'dist/client',
        emptyOutDir: false
    }
})
