import { ProtocolError, type TabInfo } from '../shared/protocol';
import type { BrowserApi } from './chrome';
import type { Handlers } from './dispatch';

type TabHandlers = Pick<
  Handlers,
  'tabs.list' | 'tabs.activate' | 'tabs.open' | 'tabs.close' | 'tabs.history'
>;

export type ResolvedTab = chrome.tabs.Tab & { id: number };

export function toTabInfo(tab: chrome.tabs.Tab): TabInfo | null {
  if (tab.id === undefined || tab.id < 0) return null;
  return {
    id: tab.id,
    window_id: tab.windowId,
    index: tab.index,
    active: tab.active,
    audible: tab.audible ?? false,
    title: tab.title ?? '',
    url: tab.url ?? tab.pendingUrl ?? '',
  };
}

export async function getTab(api: BrowserApi, tabId: number): Promise<ResolvedTab> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await api.tabs.get(tabId);
  } catch {
    throw new ProtocolError('not_found', `no tab with id ${tabId}`);
  }
  return { ...tab, id: tabId };
}

// The tab a page operation acts on: the one named, or the active tab of the last focused
// window.
export async function resolveTab(api: BrowserApi, tabId?: number): Promise<ResolvedTab> {
  if (tabId !== undefined) return getTab(api, tabId);
  const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined) throw new ProtocolError('not_found', 'no active tab');
  return { ...tab, id: tab.id };
}

async function lastFocusedNormalWindow(api: BrowserApi): Promise<chrome.windows.Window | null> {
  try {
    const win = await api.windows.getLastFocused({ windowTypes: ['normal'] });
    return win.type === undefined || win.type === 'normal' ? win : null;
  } catch {
    return null;
  }
}

export function openableUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProtocolError('refused', 'only absolute http and https URLs can be opened');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProtocolError(
      'refused',
      `only http and https URLs can be opened, not ${url.protocol}`,
    );
  }
  return url.href;
}

async function openInNewWindow(api: BrowserApi, url: string): Promise<{ tab_id: number }> {
  const created = await api.windows.create({ url, focused: true, type: 'normal' });
  const tabId = created?.tabs?.[0]?.id;
  if (tabId === undefined) throw new ProtocolError('internal', 'the new window has no tab');
  return { tab_id: tabId };
}

export function createTabHandlers(api: BrowserApi): TabHandlers {
  return {
    'tabs.list': async () => {
      const [windows, lastFocused] = await Promise.all([
        api.windows.getAll({ populate: true, windowTypes: ['normal'] }),
        lastFocusedNormalWindow(api),
      ]);
      const focusedId = windows.find((win) => win.focused)?.id ?? lastFocused?.id;
      const ordered = [
        ...windows.filter((win) => win.id === focusedId),
        ...windows.filter((win) => win.id !== focusedId),
      ];
      const tabs = ordered.flatMap((win) =>
        [...(win.tabs ?? [])]
          .sort((a, b) => a.index - b.index)
          .map(toTabInfo)
          .filter((tab) => tab !== null),
      );
      return { tabs };
    },

    'tabs.activate': async ({ tab_id }) => {
      const tab = await getTab(api, tab_id);
      await api.tabs.update(tab_id, { active: true });
      await api.windows.update(tab.windowId, { focused: true });
      return {};
    },

    'tabs.open': async ({ url, where }) => {
      const href = openableUrl(url);
      const win = await lastFocusedNormalWindow(api);
      if (win?.id === undefined) return openInNewWindow(api, href);
      if (where === 'current') {
        const [active] = await api.tabs.query({ active: true, windowId: win.id });
        if (active?.id !== undefined) {
          await api.tabs.update(active.id, { url: href });
          return { tab_id: active.id };
        }
      }
      const tab = await api.tabs.create({ windowId: win.id, url: href, active: true });
      if (tab.id === undefined) throw new ProtocolError('internal', 'the new tab has no id');
      return { tab_id: tab.id };
    },

    'tabs.close': async ({ tab_id }) => {
      await getTab(api, tab_id);
      await api.tabs.remove(tab_id);
      return {};
    },

    'tabs.history': async ({ tab_id, direction }) => {
      await getTab(api, tab_id);
      try {
        await (direction === 'back' ? api.tabs.goBack(tab_id) : api.tabs.goForward(tab_id));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (/next page in history/i.test(reason)) {
          throw new ProtocolError(
            'not_found',
            `tab ${tab_id} has no page to go ${direction} to (Chrome: ${reason})`,
          );
        }
        throw new ProtocolError('internal', `tab ${tab_id} could not go ${direction}: ${reason}`);
      }
      return {};
    },
  };
}
