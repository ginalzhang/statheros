import { expect, type ElectronApplication, type Page } from '@playwright/test';

/** The preview/toast can load before the panel; window creation order is not an identity. */
export async function panelWindow(app: ElectronApplication): Promise<Page> {
  const panels = () => app.windows().filter(page => !page.isClosed() && new URL(page.url()).searchParams.get('view') === 'panel');
  await expect.poll(() => panels().length).toBe(1);
  const panel = panels()[0]!; await panel.waitForLoadState(); return panel;
}
