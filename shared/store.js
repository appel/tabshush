'use strict';

/**
 * Storage of snoozed tabs and settings (browser.storage.local).
 *
 * A snooze: { id, url, title, favIconUrl, wakeAt (ms, or null for "on next
 * open"), createdAt, error? }. Only the background script writes snoozes, one
 * change at a time; pages ask it through messages. Pages write settings.
 */

const SNOOZES_KEY = 'snoozes';
const SETTINGS_KEY = 'settings';
const BACKUP_FORMAT = 'tabshush-backup';
const BACKUP_VERSION = 1;
const MAX_SNOOZES = 5000;
const MAX_ICON_LENGTH = 8192;
const DEVICE_KEY = 'device';            // this device: { id, name }
const DEVICES_KEY = 'devices';          // bookmark mode: all devices [{ id, name, me }], kept by the background script
const LAST_TARGETS_KEY = 'lastTargets'; // device ids last chosen under "Wake on" in the popup

async function getSnoozes()
{
	const { [SNOOZES_KEY]: snoozes } = await browser.storage.local.get(SNOOZES_KEY);
	return Array.isArray(snoozes) ? snoozes : [];
}

async function setSnoozes(list)
{
	await browser.storage.local.set({ [SNOOZES_KEY]: list });
}

// Also applies the time format, so every page that loads the settings shows times the same way.
async function getSettings()
{
	const { [SETTINGS_KEY]: settings } = await browser.storage.local.get(SETTINGS_KEY);
	const result = withDefaults(cleanSettings(settings));
	setTimeFormat(result.timeFormat);
	return result;
}

async function setSettings(settings)
{
	await browser.storage.local.set({ [SETTINGS_KEY]: cleanSettings(settings) });
}

/**
 * This installation's identity for "Sync between devices": a random id
 * (created once) and a name, by default after the operating system.
 */
async function thisDevice()
{
	const { [DEVICE_KEY]: device } = await browser.storage.local.get(DEVICE_KEY);
	if (device && device.id && device.name)
	{
		return device;
	}
	const { os } = await browser.runtime.getPlatformInfo();
	const name = { win: 'Windows PC', mac: 'Mac', linux: 'Linux PC', android: 'Android' }[os] || 'This device';
	const created = { id: crypto.randomUUID(), name };
	await browser.storage.local.set({ [DEVICE_KEY]: created });
	return created;
}

// Extensions may only (re)open web pages; about:, file: and the like cannot be snoozed.
function canSnooze(url)
{
	return /^(https?|ftp):/i.test(url || '');
}

// Keep small icons only, and only from sources an extension page may show.
function safeIcon(url)
{
	return typeof url === 'string' && url.length <= MAX_ICON_LENGTH && /^(https:|data:image\/)/.test(url) ? url : '';
}

function cleanSettings(raw)
{
	const clean = {};
	if (!raw || typeof raw !== 'object')
	{
		return clean;
	}
	const isClock = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
	const isDay = value => Number.isInteger(value) && value >= 0 && value <= 6;
	if (isClock(raw.morning))
	{
		clean.morning = raw.morning;
	}
	if (isClock(raw.evening))
	{
		clean.evening = raw.evening;
	}
	if (Number.isInteger(raw.laterHours) && raw.laterHours >= 1 && raw.laterHours <= 12)
	{
		clean.laterHours = raw.laterHours;
	}
	if (raw.weekendDay === 6 || raw.weekendDay === 0)
	{
		clean.weekendDay = raw.weekendDay;
	}
	if (isDay(raw.weekStartDay))
	{
		clean.weekStartDay = raw.weekStartDay;
	}
	if (typeof raw.notify === 'boolean')
	{
		clean.notify = raw.notify;
	}
	if (typeof raw.showBadge === 'boolean')
	{
		clean.showBadge = raw.showBadge;
	}
	if (typeof raw.syncBookmarks === 'boolean')
	{
		clean.syncBookmarks = raw.syncBookmarks;
	}
	if (['auto', '12', '24'].includes(raw.timeFormat))
	{
		clean.timeFormat = raw.timeFormat;
	}
	if (['auto', 'on', 'off'].includes(raw.reduceMotion))
	{
		clean.reduceMotion = raw.reduceMotion;
	}
	return clean;
}

/**
 * Converts the storage of the SnoozeTabs extension (bwinton/SnoozeTabs), as
 * copied from its debug console, to TabShush snoozes. SnoozeTabs keeps one
 * entry per snoozed tab: { time (ms, or "next" for next browser launch),
 * title, url, icon, ... }, next to a few settings that are skipped here.
 * Accepts its storage object (entries keyed by id) or a plain list of entries.
 * The same checks as for a backup apply. Returns { snoozes, settings, skipped }.
 */
function convertSnoozeTabs(raw)
{
	if (!raw || typeof raw !== 'object')
	{
		throw new Error('This is not SnoozeTabs data.');
	}
	const entries = (Array.isArray(raw) ? raw : Object.values(raw)).filter(item => item && typeof item === 'object' && 'url' in item && 'time' in item);
	if (!entries.length)
	{
		throw new Error('No snoozed tabs found in this SnoozeTabs data.');
	}
	return validateBackup({
		format: BACKUP_FORMAT,
		version: BACKUP_VERSION,
		snoozes: entries.map(item => ({
			url: item.url,
			title: item.title,
			favIconUrl: item.icon,
			wakeAt: item.time === 'next' ? null : item.time,
		})),
	});
}

/**
 * Checks an imported backup as untrusted input: known fields only, types and
 * lengths checked, web URLs only (no javascript: or privileged pages).
 * Returns { snoozes, settings, skipped } or throws with a readable message.
 */
function validateBackup(raw)
{
	if (!raw || typeof raw !== 'object' || raw.format !== BACKUP_FORMAT)
	{
		throw new Error('This file is not a TabShush backup.');
	}
	if (raw.version !== BACKUP_VERSION)
	{
		throw new Error(`Unsupported backup version "${String(raw.version).slice(0, 20)}".`);
	}
	const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
	const snoozes = [];
	let skipped = 0;
	for (const item of Array.isArray(raw.snoozes) ? raw.snoozes.slice(0, MAX_SNOOZES) : [])
	{
		const url = item && typeof item === 'object' ? text(item.url, 8192) : '';
		const wakeAt = item?.wakeAt === null ? null : Number(item?.wakeAt);
		if (!canSnooze(url) || (wakeAt !== null && !Number.isFinite(wakeAt)))
		{
			skipped++;
			continue;
		}
		snoozes.push({
			id: crypto.randomUUID(),
			url,
			title: text(item.title, 1024) || url,
			favIconUrl: safeIcon(item.favIconUrl),
			wakeAt,
			createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
		});
	}
	return { snoozes, settings: cleanSettings(raw.settings), skipped };
}
