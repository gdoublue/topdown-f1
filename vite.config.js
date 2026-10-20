import { defineConfig } from "vite";

export default defineConfig({
  // 相对路径：打包产物可直接放到任意子目录/静态托管
  base: "./",
  server: {
    host: true,
    port: 8080,
  },
  preview: {
    port: 8080,
  },
  build: {
    outDir: "dist",
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: "index.html",
        test: "test.html",
        docs: "autopilot-doc.html",
      },
    },
  },
});
