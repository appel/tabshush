'use strict';

/**
 * TabShush background: snoozes tabs, wakes them, keeps the wake-up alarm,
 * badge and tab context menu up to date.
 *
 * Two stores, chosen in Settings:
 * - local (default): the snooze list in storage.local, this device only;
 * - bookmarks ("Sync between devices"): Other Bookmarks › TabShush, see
 *   shared/sync.js. The list in storage.local is then a copy that the pages
 *   read, rebuilt whenever the bookmarks change (also by Firefox Sync).
 *
 * All changes go through `serial`, one at a time, so a wake-up and a snooze
 * (or two wake-ups) never overwrite each other. Alarms are not relied on to
 * survive a restart: on startup and after every change the next wake-up is
 * scheduled again from the store.
 *
 * Waking a tab that may wake on several devices: the device that is in use
 * opens it at once; an idle device waits GRACE_MS first, and right after
 * Firefox starts, STARTUP_DELAY_MS, so that a removal made by another device
 * can arrive through Sync first. Before opening, the bookmark is read again.
 */

const WAKE_ALARM = 'tabshush-wake';
const PAGE_URL = browser.runtime.getURL('snoozed.html');
const MENU_ROOT = 'snooze';
// Woken tabs first show this stand-in (bell icon, original title); it opens the real page when selected.
const WAKE_URL = browser.runtime.getURL('wake.html');
const GRACE_MS = 15 * 60000;
const STARTUP_DELAY_MS = 2 * 60000;
const IDLE_SECONDS = 300;
const MAX_FAVICONS = 2000;

let queue = Promise.resolve();

function serial(task)
{
	const result = queue.then(task);
	queue = result.catch(console.error);
	return result;
}

/* Store */

async function syncEnabled()
{
	if (!(await getSettings()).syncBookmarks || !browser.bookmarks)
	{
		return false;
	}
	return browser.permissions.contains({ permissions: ['bookmarks'] });
}

// The full list (all devices in bookmark mode), with this device's local extras (favicons, errors).
async function storeList()
{
	if (!await syncEnabled())
	{
		return getSnoozes();
	}
	const [{ items }, { favicons = {}, failedIds = [] }] = await Promise.all([
		readSyncStore(),
		browser.storage.local.get(['favicons', 'failedIds']),
	]);
	return items.map(item => ({
		...item,
		favIconUrl: favicons[item.url] || '',
		error: failedIds.includes(item.id) ? 'Could not be opened' : undefined,
	}));
}

async function storeAdd(records)
{
	if (!await syncEnabled())
	{
		await setSnoozes([...await getSnoozes(), ...records]);
		return;
	}
	await rememberFavicons(records);
	await syncAdd(records);
	await refreshCache();
}

async function storeRemove(ids)
{
	if (!await syncEnabled())
	{
		await setSnoozes((await getSnoozes()).filter(item => !ids.includes(item.id)));
		return;
	}
	await syncRemove(ids);
	await refreshCache();
}

async function storeUpdate(id, wakeAt, targets)
{
	if (!await syncEnabled())
	{
		await setSnoozes((await getSnoozes()).map(item => item.id === id ? { ...item, wakeAt, error: undefined } : item));
		return;
	}
	const { failedIds = [] } = await browser.storage.local.get('failedIds');
	await browser.storage.local.set({ failedIds: failedIds.filter(failed => failed !== id) });
	await syncUpdate(id, wakeAt, targets);
	await refreshCache();
}

async function storeMarkFailed(ids)
{
	if (!await syncEnabled())
	{
		await setSnoozes((await getSnoozes()).map(item => ids.includes(item.id) ? { ...item, error: 'Could not be opened' } : item));
		return;
	}
	const { failedIds = [] } = await browser.storage.local.get('failedIds');
	await browser.storage.local.set({ failedIds: [...new Set([...failedIds, ...ids])] });
}

// Bookmarks cannot carry favicons; keep them on this device, by address.
async function rememberFavicons(records)
{
	const { favicons = {} } = await browser.storage.local.get('favicons');
	for (const record of records)
	{
		if (record.favIconUrl)
		{
			delete favicons[record.url];
			favicons[record.url] = record.favIconUrl;
		}
	}
	const urls = Object.keys(favicons);
	urls.slice(0, Math.max(0, urls.length - MAX_FAVICONS)).forEach(url => delete favicons[url]);
	await browser.storage.local.set({ favicons });
}

// Bookmark mode: copies the bookmarks to the list the pages read, plus the device list.
async function refreshCache()
{
	if (!await syncEnabled())
	{
		await browser.storage.local.set({ [DEVICES_KEY]: [] });
		return;
	}
	const device = await thisDevice();
	const { devices } = await readSyncStore();
	await setSnoozes(await storeList());
	await browser.storage.local.set({ [DEVICES_KEY]: [...devices.values()].map(({ id, name }) => ({ id, name, me: id === device.id })) });
}

/* Devices */

// The targets for a new snooze: the devices last chosen in the popup, else this device.
async function defaultTargets()
{
	if (!await syncEnabled())
	{
		return null;
	}
	const device = await thisDevice();
	const { [LAST_TARGETS_KEY]: last = [], [DEVICES_KEY]: devices = [] } = await browser.storage.local.get([LAST_TARGETS_KEY, DEVICES_KEY]);
	const known = last.filter(id => devices.some(item => item.id === id));
	return known.length ? known : [device.id];
}

/* Snoozing */

async function snoozeTabs(tabIds, wakeAt, targets = undefined)
{
	return serial(async () =>
	{
		const tabs = (await Promise.all(tabIds.map(id => browser.tabs.get(id).catch(() => null)))).filter(Boolean);
		const snoozable = tabs.filter(tab => canSnooze(tab.url) && !tab.incognito);
		if (!snoozable.length)
		{
			return { snoozed: 0, skipped: tabs.length };
		}

		const chosenTargets = targets === undefined ? await defaultTargets() : targets;
		const now = Date.now();
		const records = snoozable.map(tab => ({
			id: crypto.randomUUID(),
			url: tab.url,
			title: tab.title || tab.url,
			favIconUrl: safeIcon(tab.favIconUrl),
			wakeAt: wakeAt == null ? null : wakeAt,
			targets: chosenTargets,
			createdAt: now,
		}));
		// Saved before the tabs close: if closing fails, the tabs are still open and still snoozed.
		await storeAdd(records);
		await keepAWindowOpen(snoozable);
		await browser.tabs.remove(snoozable.map(tab => tab.id));
		await schedule();
		return { snoozed: records.length, skipped: tabs.length - snoozable.length };
	});
}

// Closing every tab of the last window would quit Firefox; open a new tab first in that case.
async function keepAWindowOpen(closing)
{
	const windows = await browser.windows.getAll({ windowTypes: ['normal'], populate: true });
	const closingIds = new Set(closing.map(tab => tab.id));
	const remaining = windows.reduce((sum, win) => sum + win.tabs.filter(tab => !closingIds.has(tab.id)).length, 0);
	if (!remaining && windows.length)
	{
		await browser.tabs.create({ windowId: closing[0].windowId });
	}
}

/* Waking */

// Whether this device may wake the snooze, and whether other devices may too.
function targetInfo(item, deviceId, deviceIds)
{
	if (!item.targets)
	{
		return { mine: true, shared: deviceIds.size > 1 };
	}
	const mine = item.targets.includes(deviceId);
	return { mine, shared: mine && item.targets.some(id => id !== deviceId && deviceIds.has(id)) };
}

// When Firefox last started (unknown after an install or reload mid-session).
async function startedAt()
{
	const { startedAt: time = 0 } = await browser.storage.session.get('startedAt');
	return time;
}

// "On next open" snoozes made before this start wake now; ones made since wait for the next start.
function wakesOnThisOpen(item, started)
{
	return item.wakeAt == null && started > 0 && (item.createdAt || 0) < started;
}

/**
 * Opens the snoozes that are due on this device (and, after a start, the
 * "on next open" ones) next to the active tab of the current window,
 * as a TabShush stand-in page (bell icon, original title) that turns into the
 * real page when the tab is first selected. Snoozes
 * are removed only once their tab exists; one that cannot be opened is kept
 * and marked. With `ids`, those snoozes are opened right away ("Wake now").
 */
async function wakeDue({ ids = null } = {})
{
	return serial(async () =>
	{
		const now = Date.now();
		const list = await storeList();
		const sync = await syncEnabled();
		const device = sync ? await thisDevice() : null;
		const deviceIds = sync ? new Set((await readSyncStore()).devices.keys()) : new Set();
		const started = await startedAt();
		const holdUntil = started ? started + STARTUP_DELAY_MS : 0;
		const active = sync ? (await browser.idle.queryState(IDLE_SECONDS)) === 'active' : true;

		const due = list.filter(item =>
		{
			if (ids)
			{
				return ids.includes(item.id);
			}
			if (item.error)
			{
				return false;
			}
			const { mine, shared } = sync ? targetInfo(item, device.id, deviceIds) : { mine: true, shared: false };
			if (!mine)
			{
				return false;
			}
			if (shared && now < holdUntil)
			{
				return false;
			}
			if (item.wakeAt == null)
			{
				return wakesOnThisOpen(item, started);
			}
			if (item.wakeAt > now + 1000)
			{
				return false;
			}
			// A tab other devices may also wake: the device in use takes it; an idle one waits a while.
			return !shared || active || now >= item.wakeAt + GRACE_MS;
		}).sort((a, b) => (a.wakeAt ?? 0) - (b.wakeAt ?? 0));

		if (due.length)
		{
			// Bookmark mode: read again just before opening; another device may have woken some meanwhile.
			const stillThere = sync ? new Set((await readSyncStore()).items.map(item => item.id)) : null;
			const toOpen = stillThere ? due.filter(item => stillThere.has(item.id)) : due;
			const { opened, failed } = await openTabs(toOpen);
			if (opened.size)
			{
				await storeRemove([...opened.keys()]);
			}
			if (failed.size)
			{
				await storeMarkFailed([...failed]);
			}
			await notifyWoken(toOpen.filter(item => opened.has(item.id)), [...opened.values()]);
		}
		await schedule();
	});
}

async function openTabs(items)
{
	const opened = new Map();
	const failed = new Set();
	let windowId;
	let index;
	const win = await browser.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
	if (win && win.type === 'normal')
	{
		const [active] = await browser.tabs.query({ windowId: win.id, active: true });
		windowId = win.id;
		index = active ? active.index + 1 : undefined;
	}
	else
	{
		windowId = (await browser.windows.create({})).id;
	}

	for (const item of items)
	{
		const position = index == null ? {} : { index };
		try
		{
			const standIn = `${WAKE_URL}?u=${encodeURIComponent(item.url)}&t=${encodeURIComponent(item.title)}`;
			const tab = await browser.tabs.create({ windowId, ...position, url: standIn, active: false });
			opened.set(item.id, tab.id);
		}
		catch (err)
		{
			console.error(item.url, err);
			failed.add(item.id);
			continue;
		}
		if (index != null)
		{
			index++;
		}
	}
	return { opened, failed };
}

async function notifyWoken(items, tabIds)
{
	if (!items.length || !(await getSettings()).notify || !browser.notifications)
	{
		return;
	}
	if (!await browser.permissions.contains({ permissions: ['notifications'] }))
	{
		return;
	}
	await browser.storage.session.set({ lastWoken: tabIds });
	listenToNotificationClicks();
	await browser.notifications.create('tabshush-woke', {
		type: 'basic',
		title: items.length === 1 ? 'A snoozed tab woke up' : `${items.length} snoozed tabs woke up`,
		message: items.slice(0, 3).map(item => item.title).join('\n') + (items.length > 3 ? `\n…and ${items.length - 3} more` : ''),
	});
}

// The notifications API only exists once the optional permission is granted, so listen lazily.
function listenToNotificationClicks()
{
	if (browser.notifications && !browser.notifications.onClicked.hasListener(onNotificationClicked))
	{
		browser.notifications.onClicked.addListener(onNotificationClicked);
	}
}

// Clicking the notification switches to the (first) woken tab.
async function onNotificationClicked(id)
{
	if (id !== 'tabshush-woke')
	{
		return;
	}
	const { lastWoken = [] } = await browser.storage.session.get('lastWoken');
	for (const tabId of lastWoken)
	{
		const tab = await browser.tabs.get(tabId).catch(() => null);
		if (tab)
		{
			await browser.tabs.update(tab.id, { active: true });
			await browser.windows.update(tab.windowId, { focused: true });
			break;
		}
	}
}

/* Schedule and badge */

/**
 * Sets the alarm for the next moment something may need to wake on this
 * device: a wake-up time, the end of a grace period, or the end of the
 * startup hold.
 */
async function schedule()
{
	const list = await storeList();
	const sync = await syncEnabled();
	const now = Date.now();
	const times = [];
	if (sync)
	{
		const device = await thisDevice();
		const deviceIds = new Set((await readSyncStore()).devices.keys());
		const started = await startedAt();
		const holdUntil = started ? started + STARTUP_DELAY_MS : 0;
		for (const item of list.filter(entry => !entry.error))
		{
			const { mine, shared } = targetInfo(item, device.id, deviceIds);
			if (!mine)
			{
				continue;
			}
			if (item.wakeAt != null)
			{
				times.push(item.wakeAt);
				if (shared)
				{
					times.push(item.wakeAt + GRACE_MS);
				}
			}
			if (shared && holdUntil > now && (item.wakeAt == null ? wakesOnThisOpen(item, started) : item.wakeAt <= holdUntil))
			{
				times.push(holdUntil);
			}
		}
	}
	else
	{
		times.push(...list.filter(item => item.wakeAt != null && !item.error).map(item => item.wakeAt));
	}

	const future = times.filter(time => time > now);
	const overdue = times.some(time => time <= now);
	if (future.length || overdue)
	{
		// Overdue entries that are still waiting (an idle device) are picked up by the grace time in `future`.
		browser.alarms.create(WAKE_ALARM, { when: Math.max(future.length ? Math.min(...future) : now + 60000, now + 1000) });
	}
	else
	{
		await browser.alarms.clear(WAKE_ALARM);
	}
	const { showBadge } = await getSettings();
	await browser.action.setBadgeText({ text: showBadge && list.length ? String(list.length) : '' });
	await browser.action.setTitle({ title: list.length ? `TabShush (${list.length} snoozed)` : 'TabShush' });
}

/* Switching stores */

/**
 * Turns "Sync between devices" on or off. On: this device registers itself
 * and its local snoozes move into the bookmarks. Off: snoozes that only this
 * device wakes move back to the local list; snoozes shared with other
 * devices stay in the bookmarks for them.
 */
async function setSync(enabled)
{
	return serial(async () =>
	{
		const settings = await getSettings();
		const device = await thisDevice();
		if (enabled && !settings.syncBookmarks)
		{
			const local = await getSnoozes();
			await setSettings({ ...settings, syncBookmarks: true });
			await registerDevice(device);
			if (local.length)
			{
				await rememberFavicons(local);
				await syncAdd(local.map(item => ({ ...item, targets: [device.id] })));
			}
			listenToBookmarks();
			await refreshCache();
		}
		else if (!enabled && settings.syncBookmarks)
		{
			const { items } = await readSyncStore();
			const { favicons = {} } = await browser.storage.local.get('favicons');
			const onlyMine = items.filter(item => item.targets && item.targets.length === 1 && item.targets[0] === device.id);
			await syncRemove(onlyMine.map(item => item.id));
			await unregisterDevice(device.id);
			await setSettings({ ...settings, syncBookmarks: false });
			await setSnoozes(onlyMine.map(item => ({
				id: crypto.randomUUID(),
				url: item.url,
				title: item.title,
				favIconUrl: favicons[item.url] || '',
				wakeAt: item.wakeAt,
				createdAt: item.createdAt,
			})));
			await browser.storage.local.set({ [DEVICES_KEY]: [], failedIds: [] });
		}
		await schedule();
	});
}

async function onDeviceRenamed(name)
{
	return serial(async () =>
	{
		const device = await thisDevice();
		const clean = cleanDeviceName(name);
		if (!clean)
		{
			throw new Error('Please enter a name for this device.');
		}
		if (await syncEnabled())
		{
			const { devices } = await readSyncStore();
			if ([...devices.values()].some(other => other.id !== device.id && other.name.toLowerCase() === clean.toLowerCase()))
			{
				throw new Error(`Another device is already called "${clean}".`);
			}
			await renameDevice(device.id, clean);
		}
		await browser.storage.local.set({ [DEVICE_KEY]: { ...device, name: clean } });
		await refreshCache();
		return clean;
	});
}

/* Bookmark changes (including those arriving through Firefox Sync) */

let bookmarkTimer = null;

function onBookmarksChanged()
{
	clearTimeout(bookmarkTimer);
	bookmarkTimer = setTimeout(() => serial(async () =>
	{
		await refreshCache();
		await schedule();
	}), 500);
}

// The bookmarks API only exists once its optional permission is granted, so listen lazily.
function listenToBookmarks()
{
	if (!browser.bookmarks || browser.bookmarks.onCreated.hasListener(onBookmarksChanged))
	{
		return;
	}
	for (const event of ['onCreated', 'onRemoved', 'onChanged', 'onMoved'])
	{
		browser.bookmarks[event].addListener(onBookmarksChanged);
	}
}

/* Messages from the popup and the page */

async function onMessage(message)
{
	switch (message?.type)
	{
		case 'snooze':
			return snoozeTabs(message.tabIds, message.wakeAt, message.targets);
		case 'wake':
			return wakeDue({ ids: message.ids });
		case 'update':
			return serial(async () =>
			{
				await storeUpdate(message.id, message.wakeAt, message.targets);
				await schedule();
			});
		case 'delete':
			return serial(async () =>
			{
				await storeRemove(message.ids);
				await schedule();
			});
		case 'add':
			// Undo of a delete, or an import. Entries already present (same address and time) are skipped.
			return serial(async () =>
			{
				const list = await storeList();
				const known = new Set(list.map(item => `${item.url} ${item.wakeAt}`));
				const fresh = message.snoozes.filter(item => !known.has(`${item.url} ${item.wakeAt}`));
				const targets = await defaultTargets();
				await storeAdd(fresh.map(item => ({ ...item, targets: item.targets || targets })));
				await schedule();
				return { added: fresh.length, duplicates: message.snoozes.length - fresh.length };
			});
		case 'set-sync':
			return setSync(message.enabled);
		case 'rename-device':
			return onDeviceRenamed(message.name);
		case 'remove-device':
			return serial(async () =>
			{
				await unregisterDevice(message.id);
				await refreshCache();
			});
		default:
			return undefined;
	}
}

/* Tab context menu: TabShush ▸ Snooze for 3 hours, Snooze until tomorrow, … */

// "Snooze until tomorrow", "Snooze for 3 hours", "Snooze until next weekend", …
function menuLabel(preset, settings)
{
	switch (preset.id)
	{
		case 'later':
			return preset.label === 'Later Today' ? 'Snooze until later today' : `Snooze for ${settings.laterHours === 1 ? '1 hour' : `${settings.laterHours} hours`}`;
		case 'weekend':
			return preset.label === 'Next Weekend' ? 'Snooze until next weekend' : 'Snooze until this weekend';
		case 'open':
			return 'Snooze until Firefox opens again';
		default:
			return `Snooze until ${preset.label.toLowerCase()}`;
	}
}

async function buildMenus()
{
	const settings = await getSettings();
	await browser.menus.removeAll();
	browser.menus.create({ id: MENU_ROOT, title: 'TabShush', contexts: ['tab'] });
	for (const preset of snoozePresets(settings))
	{
		browser.menus.create({ id: `${MENU_ROOT}:${preset.id}`, parentId: MENU_ROOT, title: menuLabel(preset, settings), contexts: ['tab'] });
	}
	browser.menus.create({ id: `${MENU_ROOT}:pick`, parentId: MENU_ROOT, title: 'Snooze until a date and time…', contexts: ['tab'] });
	browser.menus.create({ id: `${MENU_ROOT}:separator`, parentId: MENU_ROOT, type: 'separator', contexts: ['tab'] });
	browser.menus.create({ id: `${MENU_ROOT}:manage`, parentId: MENU_ROOT, title: 'Manage Snoozed Tabs', contexts: ['tab'] });
}

// The menu acts on all selected tabs when the clicked tab is one of them.
async function menuTabs(tab)
{
	return tab.highlighted ? browser.tabs.query({ windowId: tab.windowId, highlighted: true }) : [tab];
}

// "Later today" and "this weekend" depend on the time of day, so the labels are refreshed when the menu opens.
async function onMenuShown(info, tab)
{
	if (!info.menuIds.includes(MENU_ROOT) || !tab)
	{
		return;
	}
	const settings = await getSettings();
	for (const preset of snoozePresets(settings))
	{
		browser.menus.update(`${MENU_ROOT}:${preset.id}`, { title: menuLabel(preset, settings) });
	}
	browser.menus.refresh();
}

async function onMenuClicked(info, tab)
{
	const [root, id] = String(info.menuItemId).split(':');
	if (root !== MENU_ROOT || !tab)
	{
		return;
	}
	if (id === 'manage')
	{
		await openListPage();
		return;
	}
	await snoozeByPreset(id, (await menuTabs(tab)).map(item => item.id));
}

// A preset id, or "pick" (opens the picker on the page). Uses the devices last chosen in the popup.
async function snoozeByPreset(id, tabIds)
{
	if (id === 'pick')
	{
		await browser.tabs.create({ url: `${PAGE_URL}#pick=${tabIds.join(',')}` });
		return;
	}
	const preset = snoozePresets(await getSettings()).find(item => item.id === id);
	if (preset)
	{
		await snoozeTabs(tabIds, preset.when ? preset.when.getTime() : null);
	}
}

// Opens the snoozed tabs list, reusing a tab that already shows it.
async function openListPage()
{
	const [existing] = (await browser.tabs.query({})).filter(item => (item.url || '').startsWith(PAGE_URL));
	if (existing)
	{
		await browser.tabs.update(existing.id, { active: true });
		await browser.windows.update(existing.windowId, { focused: true });
	}
	else
	{
		await browser.tabs.create({ url: PAGE_URL });
	}
}

/* Keyboard shortcuts (set on the page's Shortcuts section) */

// snooze-<preset>: snooze the current tab, or the selected tabs; snooze-pick and open-list open the page.
async function onCommand(command, tab)
{
	if (command === 'open-list')
	{
		await openListPage();
		return;
	}
	if (!command.startsWith('snooze-'))
	{
		return;
	}
	const current = tab || (await browser.tabs.query({ active: true, currentWindow: true }))[0];
	if (current)
	{
		await snoozeByPreset(command.slice('snooze-'.length), (await menuTabs(current)).map(item => item.id));
	}
}

/* Events */

browser.runtime.onMessage.addListener(onMessage);
browser.commands.onCommand.addListener(onCommand);
browser.alarms.onAlarm.addListener(alarm => alarm.name === WAKE_ALARM && wakeDue());
// Back at the computer: tabs shared with other devices can wake here right away.
browser.idle.setDetectionInterval(IDLE_SECONDS);
browser.idle.onStateChanged.addListener(newState => newState === 'active' && wakeDue());
browser.runtime.onStartup.addListener(async () =>
{
	await browser.storage.session.set({ startedAt: Date.now() });
	buildMenus();
	if (await syncEnabled())
	{
		await registerDevice(await thisDevice()).catch(console.error);
		await serial(refreshCache);
	}
	wakeDue();
});
browser.runtime.onInstalled.addListener(async () =>
{
	buildMenus();
	if (await syncEnabled())
	{
		await serial(refreshCache);
	}
	serial(schedule);
});
browser.menus.onShown.addListener(onMenuShown);
browser.menus.onClicked.addListener(onMenuClicked);
listenToNotificationClicks();
listenToBookmarks();
browser.storage.onChanged.addListener((changes, area) =>
{
	if (area === 'local' && changes[SETTINGS_KEY])
	{
		buildMenus();
		serial(schedule);
	}
});
