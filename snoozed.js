'use strict';

/**
 * Full page: the list of snoozed tabs (wake now, change time, delete) and the
 * settings (snooze times, notification, backup). Opened from the popup, or
 * with #pick=<tab ids> from the tab context menu to pick a time for those tabs.
 * Changes to the list are made by the background script; this page re-renders
 * when storage changes.
 */

let settings = DEFAULT_SETTINGS;
let devices = [];   // bookmark mode with several devices: [{ id, name, me }]
let toastTimer = null;

/* Navigation */

function showSection()
{
	const hash = location.hash.slice(1);
	const section = ['settings', 'shortcuts', 'about'].includes(hash) ? hash : 'snoozed';
	if (section === 'shortcuts')
	{
		renderShortcuts().catch(showError);
	}
	for (const node of document.querySelectorAll('.section'))
	{
		node.hidden = node.id !== section;
	}
	for (const link of document.querySelectorAll('.nav-item'))
	{
		if (link.dataset.section === section)
		{
			link.setAttribute('aria-current', 'page');
		}
		else
		{
			link.removeAttribute('aria-current');
		}
	}
	if (hash.startsWith('pick='))
	{
		const tabIds = hash.slice(5).split(',').map(Number).filter(Number.isInteger);
		history.replaceState(null, '', '#snoozed');
		pickForTabs(tabIds);
	}
}

/* Snoozed list */

async function renderList()
{
	const snoozes = await getSnoozes();
	$('#nav-count').textContent = snoozes.length ? String(snoozes.length) : '';
	const query = $('#search').value.trim().toLowerCase();
	const shown = query ? snoozes.filter(item => `${item.title} ${item.url}`.toLowerCase().includes(query)) : snoozes;

	const groups = new Map();
	const add = (key, item) => (groups.get(key) || groups.set(key, []).get(key)).push(item);
	const now = new Date();
	const sorted = [...shown].sort((a, b) => (a.wakeAt ?? Infinity) - (b.wakeAt ?? Infinity));
	for (const item of sorted)
	{
		if (item.error)
		{
			add('Could not be opened', item);
		}
		else if (item.wakeAt == null)
		{
			add('On next open', item);
		}
		else
		{
			const date = new Date(item.wakeAt);
			add(sameDay(date, now) ? 'Today' : sameDay(date, addDays(now, 1)) ? 'Tomorrow' : formatDay(date, true), item);
		}
	}
	// Problems first, then by time; "On next open" last.
	const order = [...groups.keys()].sort((a, b) => (a === 'Could not be opened' ? -1 : b === 'Could not be opened' ? 1 : 0) || (a === 'On next open') - (b === 'On next open'));

	$('#list').replaceChildren(...order.map(key => el('section', { class: 'day-group', 'aria-label': key },
		el('h3', { text: key }),
		el('div', { class: 'nova-card' }, ...groups.get(key).map(renderRow)),
	)));
	$('#empty').hidden = shown.length > 0;
	$('#empty').textContent = query ? 'No snoozed tabs match your search.' : 'No snoozed tabs. Snooze a tab with the TabShush button in the toolbar, or by right-clicking a tab.';
}

function renderRow(item)
{
	let host = item.url;
	try
	{
		host = new URL(item.url).host;
	}
	catch (err)
	{
		// Keep the full address.
	}
	const favicon = item.favIconUrl
		? el('img', { class: 'favicon', src: item.favIconUrl, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' })
		: el('span', { class: 'favicon', icon: 'globe' });
	return el('div', { class: 'snooze-row' },
		favicon,
		el('div', { class: 'snooze-text' },
			el('a', { class: 'snooze-title', href: item.url, target: '_blank', rel: 'noopener noreferrer', title: `${item.title}\n${item.url}`, text: item.title }),
			el('div', { class: 'snooze-host' }, host, devices.length > 1 ? el('span', { class: 'snooze-devices', text: ` · ${deviceNames(item.targets)}` }) : null),
		),
		el('span', { class: 'snooze-when' + (item.error ? ' error' : ''), text: item.error ? item.error : item.wakeAt == null ? 'On next open' : formatTime(new Date(item.wakeAt)) }),
		el('button', { class: 'nova-icon-button', type: 'button', icon: 'wake', title: 'Wake now', 'aria-label': `Wake now: ${item.title}`, onclick: () => wakeNow(item) }),
		el('button', { class: 'nova-icon-button', type: 'button', icon: 'edit', title: 'Change time', 'aria-label': `Change time: ${item.title}`, onclick: () => changeTime(item) }),
		el('button', { class: 'nova-icon-button', type: 'button', icon: 'close', title: 'Delete', 'aria-label': `Delete: ${item.title}`, onclick: () => remove(item) }),
	);
}

function deviceNames(targets)
{
	if (!targets)
	{
		return 'Any device';
	}
	return targets.map(id => devices.find(device => device.id === id)?.name).filter(Boolean).join(', ') || 'Any device';
}

async function wakeNow(item)
{
	await browser.runtime.sendMessage({ type: 'wake', ids: [item.id] });
	showToast(`Woke up “${item.title}”`);
}

function changeTime(item)
{
	openPicker('Change wake-up time', item.wakeAt ? new Date(item.wakeAt) : null, 'Save', async (when, targets) =>
	{
		await browser.runtime.sendMessage({ type: 'update', id: item.id, wakeAt: when.getTime(), targets: targets || item.targets });
		showToast(`Wakes up ${formatWhen(when.getTime())}`);
	}, item.targets);
}

async function remove(item)
{
	await browser.runtime.sendMessage({ type: 'delete', ids: [item.id] });
	showToast('Snoozed tab deleted', false, 'Undo', () => browser.runtime.sendMessage({ type: 'add', snoozes: [item] }));
}

// From the tab context menu: pick a time for these tabs.
function pickForTabs(tabIds)
{
	if (!tabIds.length)
	{
		return;
	}
	openPicker(plural(tabIds.length, 'Snooze tab until', 'Snooze # tabs until'), null, 'Snooze', async (when, targets) =>
	{
		const message = { type: 'snooze', tabIds, wakeAt: when.getTime() };
		if (targets)
		{
			message.targets = targets;
		}
		const result = await browser.runtime.sendMessage(message);
		showToast(result?.snoozed ? `${plural(result.snoozed, '1 tab', '# tabs')} snoozed until ${formatWhen(when.getTime())}` : 'These tabs cannot be snoozed', !result?.snoozed);
	});
}

/**
 * The picker in a dialog. With several devices, "Wake on" checkboxes are
 * shown too; onConfirm(when, targets) gets the ticked device ids, or null
 * when there is nothing to choose. `targets` preselects devices (default:
 * the ones last chosen, else this device).
 */
async function openPicker(title, initial, confirmLabel, onConfirm, targets = undefined)
{
	const dialog = $('#picker-dialog');
	$('#picker-title').textContent = title;

	const choose = devices.length > 1;
	$('#picker-devices').hidden = !choose;
	if (choose)
	{
		const { [LAST_TARGETS_KEY]: last = [] } = await browser.storage.local.get(LAST_TARGETS_KEY);
		const me = devices.find(device => device.me);
		const preset = (targets === undefined ? last : targets || devices.map(device => device.id)).filter(id => devices.some(device => device.id === id));
		const ticked = preset.length ? preset : [me ? me.id : devices[0].id];
		$('#picker-device-list').replaceChildren(...devices.map(device => el('label', {},
			el('input', {
				type: 'checkbox',
				value: device.id,
				checked: ticked.includes(device.id),
				onchange: e =>
				{
					if (!$('#picker-device-list input:checked'))
					{
						e.target.checked = true;   // at least one device has to wake the tab
					}
				},
			}),
			el('span', { text: device.me ? `${device.name} (this device)` : device.name }),
		)));
	}

	const picker = createPicker($('#picker'), {
		settings,
		initial,
		confirmLabel,
		cancelLabel: 'Cancel',
		onConfirm: when =>
		{
			const chosen = choose ? [...document.querySelectorAll('#picker-device-list input:checked')].map(input => input.value) : null;
			dialog.close();
			onConfirm(when, chosen).catch(showError);
		},
		onCancel: () => dialog.close(),
	});
	dialog.showModal();
	picker.focus();
}

/* Settings */

function fillSettings()
{
	$('#morning').value = settings.morning;
	$('#evening').value = settings.evening;
	$('#later-hours').replaceChildren(...[1, 2, 3, 4, 5, 6].map(hours => el('option', { value: String(hours), text: `In ${plural(hours, '1 hour', '# hours')}`, selected: hours === settings.laterHours })));
	const weekday = day => new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(new Date(2024, 0, 7 + day));
	$('#weekend-day').replaceChildren(...[6, 0].map(day => el('option', { value: String(day), text: weekday(day), selected: day === settings.weekendDay })));
	$('#week-start').replaceChildren(...[1, 2, 3, 4, 5, 6, 0].map(day => el('option', { value: String(day), text: weekday(day), selected: day === settings.weekStartDay })));
	$('#notify').checked = settings.notify;
	$('#time-format').value = settings.timeFormat;
	$('#reduce-motion').value = settings.reduceMotion;
	// "Automatic" shows what it currently means.
	$('#time-format option[value="auto"]').textContent = `Automatic (${LOCALE_USES_24_HOURS ? '18:00' : '6pm'})`;
	$('#sync-bookmarks').checked = settings.syncBookmarks;
	$('#show-badge').checked = settings.showBadge;
}

async function saveSettings(changes)
{
	settings = { ...await getSettings(), ...changes };
	await setSettings(settings);
}

function bindSettings()
{
	for (const [id, key] of [['morning', 'morning'], ['evening', 'evening']])
	{
		$(`#${id}`).addEventListener('change', e => e.target.value && saveSettings({ [key]: e.target.value }));
	}
	$('#later-hours').addEventListener('change', e => saveSettings({ laterHours: Number(e.target.value) }));
	$('#weekend-day').addEventListener('change', e => saveSettings({ weekendDay: Number(e.target.value) }));
	$('#week-start').addEventListener('change', e => saveSettings({ weekStartDay: Number(e.target.value) }));

	$('#show-badge').addEventListener('change', e => saveSettings({ showBadge: e.target.checked }));
	$('#reduce-motion').addEventListener('change', e => saveSettings({ reduceMotion: e.target.value }));
	$('#time-format').addEventListener('change', async e =>
	{
		await saveSettings({ timeFormat: e.target.value });
		setTimeFormat(e.target.value);
		await renderList();
	});

	// Like notifications, the permission is requested directly in the click.
	$('#sync-bookmarks').addEventListener('change', e =>
	{
		const enabled = e.target.checked;
		const permission = enabled ? browser.permissions.request({ permissions: ['bookmarks'] }) : Promise.resolve(true);
		permission.then(async granted =>
		{
			if (!granted)
			{
				$('#sync-bookmarks').checked = false;
				return;
			}
			await browser.runtime.sendMessage({ type: 'set-sync', enabled });
			settings = await getSettings();
			showToast(enabled ? 'Snoozed tabs are now kept in Other Bookmarks › TabShush' : 'Snoozed tabs are now kept on this device only');
			await renderSync();
		}).catch(showError);
	});
	$('#device-name').addEventListener('change', e =>
	{
		browser.runtime.sendMessage({ type: 'rename-device', name: e.target.value })
			.then(name =>
			{
				e.target.value = name;
				showToast(`This device is now called "${name}"`);
			})
			.catch(err =>
			{
				showError(err);
				renderSync();
			});
	});

	// The permission request must happen directly in the click, before anything is awaited.
	$('#notify').addEventListener('change', e =>
	{
		const enabled = e.target.checked;
		const request = enabled ? browser.permissions.request({ permissions: ['notifications'] }) : browser.permissions.remove({ permissions: ['notifications'] });
		request.then(granted =>
		{
			const on = enabled && granted;
			$('#notify').checked = on;
			return saveSettings({ notify: on });
		}).catch(showError);
	});

	$('#export').addEventListener('click', () => exportBackup().catch(showError));
	$('#import').addEventListener('click', () =>
	{
		$('#import-file').value = '';
		$('#import-file').click();
	});
	$('#import-file').addEventListener('change', e => e.target.files[0] && importBackup(e.target.files[0]).catch(showError));
	$('#import-snoozetabs').addEventListener('click', () => importFromSnoozeTabs().catch(showError));
	$('#copy-command').addEventListener('click', () =>
	{
		navigator.clipboard.writeText($('#snoozetabs-command').textContent)
			.then(() => showToast('Copied'), showError);
	});
}

/**
 * Sync card: device name and the devices found in the bookmarks. Removing a
 * device you no longer use stops it from being offered under "Wake on".
 */
async function renderSync()
{
	const stored = await browser.storage.local.get(DEVICES_KEY);
	devices = settings.syncBookmarks ? stored[DEVICES_KEY] || [] : [];
	$('#sync-details').hidden = !settings.syncBookmarks;
	if (!settings.syncBookmarks)
	{
		return;
	}
	const device = await thisDevice();
	if (document.activeElement !== $('#device-name'))
	{
		$('#device-name').value = device.name;
	}
	$('#device-list').replaceChildren(...[...devices].sort((a, b) => (b.me - a.me) || a.name.localeCompare(b.name)).map(item => el('li', {},
		el('span', { class: item.me ? 'me' : null, text: item.me ? `${item.name} (this device)` : item.name }),
		item.me ? null : el('button', {
			class: 'nova-icon-button',
			type: 'button',
			icon: 'close',
			title: 'Remove this device',
			'aria-label': `Remove device: ${item.name}`,
			onclick: () => browser.runtime.sendMessage({ type: 'remove-device', id: item.id }).catch(showError),
		}),
	)));
}

/* Backup */

async function exportBackup()
{
	const snoozes = await getSnoozes();
	const data = {
		format: BACKUP_FORMAT,
		version: BACKUP_VERSION,
		created: new Date().toISOString(),
		settings,
		snoozes: snoozes.map(({ url, title, favIconUrl, wakeAt, createdAt }) => ({ url, title, favIconUrl, wakeAt, createdAt })),
	};
	const now = new Date();
	const pad = n => String(n).padStart(2, '0');
	const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, '\t')], { type: 'application/json' }));
	const link = el('a', { href: url, download: `tabshush-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json` });
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 60000);
	showToast(`Exported ${plural(snoozes.length, '1 snoozed tab', '# snoozed tabs')}`);
}

async function importBackup(file)
{
	if (file.size > 20 * 1024 * 1024)
	{
		throw new Error('This file is too large to be a TabShush backup.');
	}
	let raw;
	try
	{
		raw = JSON.parse(await file.text());
	}
	catch (err)
	{
		throw new Error('This file is not a TabShush backup (it is not valid JSON).');
	}
	await importChecked(validateBackup(raw), 'Import snoozed tabs');
}

async function importFromSnoozeTabs()
{
	const dialog = $('#snoozetabs-dialog');
	$('#snoozetabs-data').value = '';
	dialog.returnValue = '';
	dialog.showModal();
	await new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }));
	const text = $('#snoozetabs-data').value.trim();
	if (dialog.returnValue !== 'ok' || !text)
	{
		return;
	}
	let raw;
	try
	{
		raw = JSON.parse(text);
	}
	catch (err)
	{
		throw new Error('That is not the SnoozeTabs data: copy it again with the line from step 3.');
	}
	await importChecked(convertSnoozeTabs(raw), 'Import from SnoozeTabs');
}

// Shows what will be imported, then adds it (already known tabs are skipped by the background script).
async function importChecked(backup, title)
{
	const due = backup.snoozes.filter(item => item.wakeAt != null && item.wakeAt <= Date.now()).length;
	const hasSettings = Object.keys(backup.settings).length > 0;

	const text = `${plural(backup.snoozes.length, '1 snoozed tab', '# snoozed tabs')} in this backup.`
		+ (due ? ` ${plural(due, '1 of them is', '# of them are')} already due and will open right away.` : '')
		+ (backup.skipped ? ` ${plural(backup.skipped, '1 entry', '# entries')} cannot be used and will be skipped.` : '');
	const answer = await confirmDialog(title, text, 'Import', hasSettings ? 'Also use the settings from the backup' : null);
	if (!answer.ok)
	{
		return;
	}
	if (answer.option)
	{
		// Syncing is switched on this device only, with its own steps; a backup does not change it.
		delete backup.settings.syncBookmarks;
		settings = withDefaults({ ...await getSettings(), ...backup.settings });
		await setSettings(settings);
		fillSettings();
	}
	const result = await browser.runtime.sendMessage({ type: 'add', snoozes: backup.snoozes });
	showToast(`Imported ${plural(result.added, '1 snoozed tab', '# snoozed tabs')}` + (result.duplicates ? ` (${result.duplicates} already in your list)` : ''));
}

/* Dialog and toast */

async function confirmDialog(title, text, okLabel, optionLabel)
{
	const dialog = $('#confirm-dialog');
	$('#confirm-title').textContent = title;
	$('#confirm-text').textContent = text;
	$('#confirm-ok').textContent = okLabel;
	$('#confirm-option-row').hidden = !optionLabel;
	$('#confirm-option-label').textContent = optionLabel || '';
	$('#confirm-option').checked = false;
	dialog.returnValue = '';
	dialog.showModal();
	await new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }));
	return { ok: dialog.returnValue === 'ok', option: $('#confirm-option').checked };
}

function showToast(message, isError = false, actionLabel = null, action = null)
{
	const toast = $('#toast');
	toast.replaceChildren(el('span', { text: message }), actionLabel ? el('button', {
		class: 'nova-link',
		type: 'button',
		text: actionLabel,
		onclick: () =>
		{
			toast.hidden = true;
			Promise.resolve(action()).catch(showError);
		},
	}) : null);
	toast.classList.toggle('error', isError);
	toast.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => { toast.hidden = true; }, actionLabel ? 6000 : 3000);
}

function showError(err)
{
	console.error(err);
	showToast(err?.message || String(err), true);
}

/* Start */

async function init()
{
	settings = await getSettings();
	for (const link of document.querySelectorAll('.nav-item[data-icon]'))
	{
		link.prepend(iconNode(link.dataset.icon));
	}
	$('#version').textContent = `version ${browser.runtime.getManifest().version}`;
	fillSettings();
	bindSettings();
	bindShortcuts();
	$('#search').addEventListener('input', () => renderList().catch(showError));
	window.addEventListener('hashchange', showSection);
	browser.storage.onChanged.addListener((changes, area) =>
	{
		if (area === 'local' && changes[DEVICES_KEY])
		{
			renderSync().then(renderList).catch(showError);
		}
		else if (area === 'local' && changes[SNOOZES_KEY])
		{
			renderList().catch(showError);
		}
	});
	// Times shown as "Today" / "Tomorrow" go stale at midnight; refresh every minute.
	setInterval(() => renderList().catch(showError), 60000);
	await renderSync();
	await renderList();
	showSection();
}

init().catch(showError);
