import { expect, test } from '@playwright/test';

test('built StaticHost navigation keeps API styles, search and Markdown actions usable', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/docs/');
  await expect(page.locator('meta[name="git-commit-id"]')).toHaveCount(1);
  await page.goto('/reference/api/typescript/');
  await expect(page.locator('[data-api-search-language="typescript"]')).toBeVisible();
  const index = await page.locator('[data-api-search-index]').textContent();
  expect(index?.length).toBeGreaterThan(0);
  const markdownRequest = page.waitForResponse(response =>
    response.url().endsWith('/reference/api/typescript.md') && response.ok());
  await page.locator('[data-page-action="copy-markdown"]:visible').first().click();
  expect(await (await markdownRequest).text()).toContain('# TypeScript API Reference');
  const link = page.locator('#ts-api-package-list a').first();
  await link.click();
  await expect(page.locator('h1')).toBeVisible();
  await expect.poll(() => page.locator('img').evaluateAll(images => images.every(image =>
    !(image instanceof HTMLImageElement) || !image.src.startsWith(location.origin)
      || image.complete && image.naturalWidth > 0))).toBe(true);
  await page.goto('/reference/api/csharp/');
  await expect(page.locator('[data-api-search-language="csharp"]')).toBeVisible();
  await page.goto('/docs/');
  await expect(page.locator('h1')).toBeVisible();
});
