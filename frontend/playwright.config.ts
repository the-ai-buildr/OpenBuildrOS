import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests against a running stack (the UI plus an AgentOS backend wired to
 * the fake OpenRouter). Start it with `make e2e` or point E2E_BASE_URL at one.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
    httpCredentials: process.env.UI_PASSWORD
      ? { username: process.env.UI_USERNAME || 'admin', password: process.env.UI_PASSWORD }
      : undefined,
  },
})
