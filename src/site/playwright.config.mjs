// Playwright configuration for the Douze build: the same specs as the Astro site (src/frontend/tests/e2e), served
// by StaticHost from its wwwroot, which `douze -s src/site -o src/statichost/StaticHost/wwwroot` fills (this is what
// production serves: Markdown negotiation, canonical redirects, 404, headers). Run from src/frontend so that
// @playwright/test resolves: `pnpm --dir src/frontend exec playwright test --config ../site/playwright.config.mjs`.
import { defineConfig } from '@playwright/test';
import base from '../frontend/playwright.config.mjs';

const e2ePort = Number(process.env.PLAYWRIGHT_TEST_PORT || '4322');

export default defineConfig({
  ...base,
  testDir: '../frontend/tests/e2e',
  webServer: {
    command: `dotnet run -c Release --project ../statichost/StaticHost --urls http://127.0.0.1:${e2ePort}`,
    env: { ...process.env, ASPNETCORE_ENVIRONMENT: 'Production', DOTNET_NOLOGO: '1' },
    url: `http://127.0.0.1:${e2ePort}/`,
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
