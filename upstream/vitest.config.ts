import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The vendored library is not published as the original npm package.
    exclude: ["tests/release/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/auth-cli.ts", "src/index.ts"],
    },
  },
});
