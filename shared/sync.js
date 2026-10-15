'use strict';

/**
 * Bookmark store: keeps snoozed tabs in Other Bookmarks › TabShush, so that
 * Firefox Sync (with Bookmarks ticked) carries them to other devices.
 * Used by the background script only.
 *
 *   TabShush
 *   ├─ Devices
 *   │  └─ Desktop      (https://tabshush.invalid/device/<device id>)
 *   ├─ 2026-10-21 09:00 +02:00 · Desktop, Laptop
 *   │  └─ <snoozed tab bookmark>
 *   └─ On next open · Laptop
 *
 * A time folder's name holds the wake-up time (with its UTC offset, so it is
 * the same moment on every device) and, after " · ", the devices that may
 * wake its tabs. Without device names (or with only unknown ones), any device
 * may. Devices are found by their id in the Devices folder, so they can be
 * renamed. Bookmarks can be edited by hand: moving one to another time folder
 * reschedules it. The .invalid domain never exists, so device bookmarks lead
 * nowhere.
 */

const SYNC_ROOT_TITLE = 'TabShush';
const DEVICES_TITLE = 'Devices';
const NEXT_OPEN_TITLE = 'On next open';
const DEVICE_URL_PREFIX = 'https://tabshush.invalid/device/';
const NAME_SEPARATOR = ' · ';
const SYNC_ROOT_KEY = 'syncRootId';

/* Folder names */

function pad2(n)
{
	return String(n).padStart(2, '0');
}

// "2026-10-21 09:00 +02:00" in local time, with the offset that applies on that date (daylight saving included).
function timeStamp(wakeAt)
{
	const date = new Date(wakeAt);
	const offset = -date.getTimezoneOffset();
	const sign = offset >= 0 ? '+' : '-';
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())} `
		+ `${sign}${pad2(Math.floor(Math.abs(offset) / 60))}:${pad2(Math.abs(offset) % 60)}`;
}

function parseTimeStamp(text)
{
	const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) ([+-])(\d{2}):(\d{2})$/.exec(text.trim());
	if (!match)
	{
		return undefined;
	}
	const [, year, month, day, hours, minutes, sign, offsetHours, offsetMinutes] = match;
	const offset = (sign === '-' ? -1 : 1) * (Number(offsetHours) * 60 + Number(offsetMinutes));
	const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes)) - offset * 60000;
	return Number.isFinite(utc) ? utc : undefined;
}

function folderTitle(wakeAt, names)
{
	const time = wakeAt == null ? NEXT_OPEN_TITLE : timeStamp(wakeAt);
	return names.length ? `${time}${NAME_SEPARATOR}${names.join(', ')}` : time;
}

// Returns { wakeAt (ms or null), names } or null when the folder is not a time folder.
function parseFolderTitle(title)
{
	const [time, devices = ''] = title.split(NAME_SEPARATOR);
	const wakeAt = time.trim() === NEXT_OPEN_TITLE ? null : parseTimeStamp(time);
	if (wakeAt === undefined)
	{
		return null;
	}
	return { wakeAt, names: devices.split(',').map(name => name.trim()).filter(Boolean) };
}

// Device names are used in folder names, so they cannot contain the separators.
function cleanDeviceName(name)
{
	return String(name || '').replace(/[·,]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/* Reading */

async function syncRoots()
{
	const children = await browser.bookmarks.getChildren('unfiled_____');
	return children.filter(node => node.type === 'folder' && node.title === SYNC_ROOT_TITLE);
}

// The folder new snoozes go to: the remembered one, else an existing TabShush folder, else a new one.
async function primaryRoot(create = true)
{
	const { [SYNC_ROOT_KEY]: remembered } = await browser.storage.local.get(SYNC_ROOT_KEY);
	if (remembered)
	{
		const [node] = await browser.bookmarks.get(remembered).catch(() => []);
		if (node && node.type === 'folder')
		{
			return node;
		}
	}
	let [root] = await syncRoots();
	if (!root && create)
	{
		root = await browser.bookmarks.create({ parentId: 'unfiled_____', title: SYNC_ROOT_TITLE });
	}
	if (root)
	{
		await browser.storage.local.set({ [SYNC_ROOT_KEY]: root.id });
	}
	return root || null;
}

/**
 * Everything in the TabShush folder(s). After a first sync there can briefly
 * be two TabShush folders (one per device); both are read.
 * Returns { devices: Map(id -> {id, name, bookmarkId}), items: [snooze] }.
 */
async function readSyncStore()
{
	const roots = await syncRoots();
	const remembered = await primaryRoot(false);
	if (remembered && !roots.some(root => root.id === remembered.id))
	{
		roots.push(remembered);
	}

	const devices = new Map();
	const timeFolders = [];
	for (const root of roots)
	{
		const [tree] = await browser.bookmarks.getSubTree(root.id);
		for (const child of tree.children || [])
		{
			if (child.type !== 'folder')
			{
				continue;
			}
			if (child.title === DEVICES_TITLE)
			{
				for (const node of child.children || [])
				{
					if (node.type === 'bookmark' && (node.url || '').startsWith(DEVICE_URL_PREFIX))
					{
						const id = node.url.slice(DEVICE_URL_PREFIX.length);
						devices.set(id, { id, name: node.title, bookmarkId: node.id });
					}
				}
				continue;
			}
			const parsed = parseFolderTitle(child.title);
			if (parsed)
			{
				timeFolders.push({ folder: child, ...parsed });
			}
		}
	}

	const idByName = new Map([...devices.values()].map(device => [device.name.toLowerCase(), device.id]));
	const items = [];
	for (const { folder, wakeAt, names } of timeFolders)
	{
		const ids = names.map(name => idByName.get(name.toLowerCase())).filter(Boolean);
		for (const node of folder.children || [])
		{
			if (node.type === 'bookmark' && canSnooze(node.url))
			{
				items.push({
					id: node.id,
					url: node.url,
					title: node.title || node.url,
					wakeAt,
					targets: ids.length ? ids : null,
					folderId: folder.id,
					createdAt: node.dateAdded || Date.now(),
				});
			}
		}
	}
	return { devices, items };
}

/* Writing */

function namesFor(targets, devices)
{
	return (targets || []).map(id => devices.get(id)?.name).filter(Boolean);
}

async function timeFolder(root, wakeAt, names)
{
	const title = folderTitle(wakeAt, names);
	const children = await browser.bookmarks.getChildren(root.id);
	return children.find(node => node.type === 'folder' && node.title === title)
		|| browser.bookmarks.create({ parentId: root.id, title });
}

// Adds snoozes ({url, title, wakeAt, targets}) as bookmarks; returns their new bookmark ids in order.
async function syncAdd(records)
{
	const root = await primaryRoot();
	const { devices } = await readSyncStore();
	const ids = [];
	for (const record of records)
	{
		const folder = await timeFolder(root, record.wakeAt, namesFor(record.targets, devices));
		const node = await browser.bookmarks.create({ parentId: folder.id, title: record.title || record.url, url: record.url });
		ids.push(node.id);
	}
	return ids;
}

async function syncRemove(ids)
{
	const folders = new Set();
	for (const id of ids)
	{
		const [node] = await browser.bookmarks.get(id).catch(() => []);
		if (node)
		{
			folders.add(node.parentId);
			await browser.bookmarks.remove(id).catch(console.error);
		}
	}
	await removeEmptyFolders(folders);
}

// Moves a snooze to the folder for its new time and/or devices.
async function syncUpdate(id, wakeAt, targets)
{
	const [node] = await browser.bookmarks.get(id).catch(() => []);
	if (!node)
	{
		return;
	}
	const root = await primaryRoot();
	const { devices } = await readSyncStore();
	const folder = await timeFolder(root, wakeAt, namesFor(targets, devices));
	if (folder.id !== node.parentId)
	{
		await browser.bookmarks.move(id, { parentId: folder.id });
		await removeEmptyFolders(new Set([node.parentId]));
	}
}

async function removeEmptyFolders(folderIds)
{
	for (const id of folderIds)
	{
		const children = await browser.bookmarks.getChildren(id).catch(() => null);
		const [node] = await browser.bookmarks.get(id).catch(() => []);
		if (children && !children.length && node && parseFolderTitle(node.title))
		{
			await browser.bookmarks.remove(id).catch(console.error);
		}
	}
}

/* Devices */

async function devicesFolder(root)
{
	const children = await browser.bookmarks.getChildren(root.id);
	return children.find(node => node.type === 'folder' && node.title === DEVICES_TITLE)
		|| browser.bookmarks.create({ parentId: root.id, title: DEVICES_TITLE, index: 0 });
}

// Adds this device to the Devices folder, or brings its name up to date.
async function registerDevice(device)
{
	const { devices } = await readSyncStore();
	const known = devices.get(device.id);
	if (known)
	{
		if (known.name !== device.name)
		{
			await browser.bookmarks.update(known.bookmarkId, { title: device.name });
		}
		return;
	}
	const folder = await devicesFolder(await primaryRoot());
	await browser.bookmarks.create({ parentId: folder.id, title: device.name, url: DEVICE_URL_PREFIX + device.id });
}

async function unregisterDevice(deviceId)
{
	const { devices } = await readSyncStore();
	const known = devices.get(deviceId);
	if (known)
	{
		await browser.bookmarks.remove(known.bookmarkId).catch(console.error);
	}
}

// Renames a device and the time folders that mention it.
async function renameDevice(deviceId, newName)
{
	const { devices, items } = await readSyncStore();
	const known = devices.get(deviceId);
	if (!known || known.name === newName)
	{
		return;
	}
	const folderIds = new Set(items.filter(item => item.targets?.includes(deviceId)).map(item => item.folderId));
	await browser.bookmarks.update(known.bookmarkId, { title: newName });
	devices.set(deviceId, { ...known, name: newName });
	for (const folderId of folderIds)
	{
		const [folder] = await browser.bookmarks.get(folderId).catch(() => []);
		const parsed = folder && parseFolderTitle(folder.title);
		if (parsed)
		{
			const names = parsed.names.map(name => name.toLowerCase() === known.name.toLowerCase() ? newName : name);
			await browser.bookmarks.update(folderId, { title: folderTitle(parsed.wakeAt, names) });
		}
	}
}
