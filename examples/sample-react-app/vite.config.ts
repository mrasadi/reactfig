import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // fixed port so ReactFig MCP's `generate_design_ir` tool has a stable
    // url to navigate Playwright to — see README.md
    port: 5173,
  },
});
