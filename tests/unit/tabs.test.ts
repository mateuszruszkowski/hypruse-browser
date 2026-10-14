import { createSiteHandlers } from '../../src/background/sites';
import { createTabHandlers, openableUrl, resolveTab } from '../../src/background/tabs';
import { ProtocolError } from '../../src/shared/protocol';
import { FakeBrowser } from '../helpers/fake-browser';

function setup() {
  const browser = new FakeBrowser();
  const back = browser.addWindow();
  const front = browser.addWindow({ focused: true });
  const b1 = browser.addTab(back, 'https://example.org/one', { active: true, title: 'One' });
  const f1 = browser.addTab(front, 'https://www.youtube.com/', { title: 'YouTube' });
  const f2 = browser.addTab(front, 'https://open.spotify.com/', { active: true, title: 'Spotify' });
  return { browser, handlers: createTabHandlers(browser.api()), back, front, b1, f1, f2 };
}

async function expectCode(work: Promise<unknown>, code: string): Promise<void> {
  const error: unknown = await work.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ProtocolError);
  expect((error as ProtocolError).code).toBe(code);
}

describe('tabs.list', () => {
  it('lists every normal window, the focused one first', async () => {
    const { handlers, front, back, f1, f2, b1 } = setup();
    const { tabs } = (await handlers['tabs.list']({})) as { tabs: { id: number }[] };
    expect(tabs.map((tab) => tab.id)).toEqual([f1, f2, b1]);
    expect(tabs[1]).toEqual({
      id: f2,
      window_id: front,
      index: 1,
      active: true,
      audible: false,
      title: 'Spotify',
      url: 'https://open.spotify.com/',
    });
    expect(tabs[2]).toMatchObject({ window_id: back, active: true });
  });

  it('puts the last focused window first when Chrome itself is not focused', async () => {
    const { browser, handlers, b1 } = setup();
    for (const win of browser.windows) win.focused = false;
    browser.lastFocusedId = browser.windows[0]!.id!;
    const { tabs } = (await handlers['tabs.list']({})) as { tabs: { id: number }[] };
    expect(tabs[0]!.id).toBe(b1);
  });

  it('leaves out popup windows', async () => {
    const { browser, handlers } = setup();
    const popup = browser.addWindow({ type: 'popup' });
    browser.addTab(popup, 'https://accounts.example.com/login');
    const { tabs } = (await handlers['tabs.list']({})) as { tabs: unknown[] };
    expect(tabs).toHaveLength(3);
  });
});

describe('tabs.activate', () => {
  it('activates the tab and focuses its window', async () => {
    const { browser, handlers, b1, back } = setup();
    await expect(handlers['tabs.activate']({ tab_id: b1 })).resolves.toEqual({});
    expect(browser.tab(b1).active).toBe(true);
    expect(browser.lastFocusedId).toBe(back);
  });

  it('answers not_found for a tab that does not exist', async () => {
    const { handlers } = setup();
    await expectCode(handlers['tabs.activate']({ tab_id: 9999 }), 'not_found');
  });
});

describe('tabs.open', () => {
  it('opens a new active tab in the last focused normal window', async () => {
    const { browser, handlers, front } = setup();
    const { tab_id } = (await handlers['tabs.open']({
      url: 'https://example.com/',
      where: 'new',
    })) as { tab_id: number };
    expect(browser.tab(tab_id)).toMatchObject({ windowId: front, active: true });
  });

  it('navigates the active tab for where=current', async () => {
    const { browser, handlers, f2 } = setup();
    await expect(
      handlers['tabs.open']({ url: 'https://example.com/x', where: 'current' }),
    ).resolves.toEqual({ tab_id: f2 });
    expect(browser.tab(f2).url).toBe('https://example.com/x');
  });

  it('opens a window when there is none', async () => {
    const browser = new FakeBrowser();
    const handlers = createTabHandlers(browser.api());
    const { tab_id } = (await handlers['tabs.open']({
      url: 'https://example.com/',
      where: 'current',
    })) as { tab_id: number };
    expect(browser.tab(tab_id).url).toBe('https://example.com/');
  });

  it('refuses anything but http and https', async () => {
    const { handlers } = setup();
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'chrome://settings',
      'data:text/html,hi',
      'youtube.com',
    ]) {
      await expectCode(handlers['tabs.open']({ url, where: 'new' }), 'refused');
    }
  });

  it('normalises the URL it opens', () => {
    expect(openableUrl('HTTPS://Example.com')).toBe('https://example.com/');
  });
});

describe('tabs.close and tabs.history', () => {
  it('closes a tab', async () => {
    const { browser, handlers, f1 } = setup();
    await handlers['tabs.close']({ tab_id: f1 });
    expect(browser.tabs.some((tab) => tab.id === f1)).toBe(false);
    await expectCode(handlers['tabs.close']({ tab_id: f1 }), 'not_found');
  });

  it('goes back and forward, and says not_found at either end', async () => {
    const { browser, handlers, f2 } = setup();
    await handlers['tabs.open']({ url: 'https://example.com/next', where: 'current' });
    await handlers['tabs.history']({ tab_id: f2, direction: 'back' });
    expect(browser.tab(f2).url).toBe('https://open.spotify.com/');
    await expectCode(handlers['tabs.history']({ tab_id: f2, direction: 'back' }), 'not_found');
    await handlers['tabs.history']({ tab_id: f2, direction: 'forward' });
    expect(browser.tab(f2).url).toBe('https://example.com/next');
    await expectCode(handlers['tabs.history']({ tab_id: f2, direction: 'forward' }), 'not_found');
  });

  it("passes Chrome's reason through instead of hiding it", async () => {
    const { browser, handlers, f2 } = setup();
    await expect(handlers['tabs.history']({ tab_id: f2, direction: 'back' })).rejects.toThrow(
      'Cannot find a next page in history',
    );
    const api = browser.api();
    api.tabs.goBack = async () => {
      throw new Error('Tabs cannot be edited right now (user may be dragging a tab).');
    };
    const busy = createTabHandlers(api)['tabs.history']({ tab_id: f2, direction: 'back' });
    await expectCode(busy, 'internal');
    await expect(busy).rejects.toThrow('user may be dragging a tab');
  });
});

describe('resolveTab', () => {
  it('defaults to the active tab of the last focused window', async () => {
    const { browser, f2 } = setup();
    await expect(resolveTab(browser.api())).resolves.toMatchObject({ id: f2 });
  });

  it('answers not_found when there is no active tab', async () => {
    await expectCode(resolveTab(new FakeBrowser().api()), 'not_found');
  });
});

describe('sites.top', () => {
  it('returns web top sites with their host', async () => {
    const browser = new FakeBrowser();
    browser.topSites = [
      { url: 'https://www.youtube.com/', title: 'YouTube' },
      { url: 'chrome://newtab/', title: 'New Tab' },
      { url: 'https://open.spotify.com/collection', title: 'Spotify' },
    ];
    const handlers = createSiteHandlers(browser.api());
    await expect(handlers['sites.top']({})).resolves.toEqual({
      sites: [
        { url: 'https://www.youtube.com/', host: 'www.youtube.com', title: 'YouTube' },
        {
          url: 'https://open.spotify.com/collection',
          host: 'open.spotify.com',
          title: 'Spotify',
        },
      ],
    });
  });
});
