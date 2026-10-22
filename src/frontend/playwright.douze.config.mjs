// Playwright configuration for the Douze build: the same specs (tests/e2e), served by StaticHost from its wwwroot,
// which `douze -s src/site -o src/statichost/StaticHost/wwwroot` fills (what production serves: Markdown negotiation,
// canonical redirects, 404, headers). Run: `pnpm exec playwright test --config playwright.douze.config.mjs`.
import { defineConfig } from '@playwright/test';
import base from './playwright.config.mjs';

const e2ePort = Number(process.env.PLAYWRIGHT_TEST_PORT || '4322');

export default defineConfig({
  ...base,
  webServer: {
    command: `dotnet run -c Release --project ../statichost/StaticHost --urls http://127.0.0.1:${e2ePort}`,
    env: { ...process.env, ASPNETCORE_ENVIRONMENT: 'Development', DOTNET_NOLOGO: '1', ConnectionStrings__cache: 'localhost:6379,abortConnect=false' },
    url: `http://127.0.0.1:${e2ePort}/`,
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
