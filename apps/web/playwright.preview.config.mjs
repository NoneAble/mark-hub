export default {
  build: {
    outDir: process.env.MARKHUB_E2E_WEB_DIST,
  },
  preview: {
    host: "127.0.0.1",
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.MARKHUB_E2E_API_URL,
        changeOrigin: true,
      },
    },
  },
};
