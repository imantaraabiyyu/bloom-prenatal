import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Mirrors the "@/*" -> "./*" alias jsconfig.json already defines for the
// Next.js app itself, so test files can `import ... from "@/lib/..."` the
// same way app code does instead of relative-pathing back out of lib/.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
