'use strict';

/**
 * Popup: snooze the current tab (or all selected tabs of this window) with a
 * preset, a picked date and time, or open the manage / settings page.
 * The snoozing itself is done by the background script, so it completes
 * even though the popup closes along with the tab.
 */

const PAGE_URL = browser.runtime.getURL('snoozed.html');

let targetTabs = [];
let settings = DEFAULT_SETTINGS;
let wakeOnDevices = null;   // device ids ticked under "Wake on", or null when there is nothing to choose

async function init()
{
	settings = await getSettings();
	targetTabs = await browser.tabs.query({ currentWindow: true, highlighted: true });
	const snoozable = targetTabs.filter(tab => canSnooze(tab.url));

	const title = $('#target-title');
	const detail = $('#target-detail');
	if (!snoozable.length)
	{
		title.textContent = 'Snooze tab';
		detail.textContent = 'Firefox pages like this one cannot be reopened by an extension, so they cannot be snoozed.';
		detail.classList.add('warning');
	}
	else
	{
		title.textContent = plural(snoozable.length, 'Snooze tab', 'Snooze # tabs');
		detail.textContent = snoozable.length === 1 ? snoozable[0].title : `${snoozable[0].title} and ${plural(snoozable.length - 1, '1 other', '# others')}`;
		if (snoozable.length < targetTabs.length)
		{
			detail.textContent += ` (${plural(targetTabs.length - snoozable.length, '1 tab', '# tabs')} cannot be snoozed)`;
		}
	}

	await renderWakeOn();
	const disabled = !snoozable.length;
	$('#presets').replaceChildren(...snoozePresets(settings).map((preset, i) => el('button', {
		class: 'nova-menu-item',
		type: 'button',
		disabled,
		title: `Shortcut: ${i + 1}`,
		onclick: () => snooze(preset.when),
	}, iconNode(preset.id), el('span', { text: preset.label }), el('span', { class: 'detail', text: preset.detail }))));

	await renderComingUp();
	const count = (await getSnoozes()).length;
	$('#pick').replaceChildren(iconNode('pick'), el('span', { text: 'Pick a Date and Time…' }));
	$('#pick').disabled = disabled;
	$('#manage').replaceChildren(iconNode('manage'), el('span', { text: 'Manage Snoozed Tabs' }), ...(count ? [el('span', { class: 'detail count', text: String(count) })] : []));
	$('#settings').replaceChildren(iconNode('settings'), el('span', { text: 'Settings' }));
	$('#pick-back').append(iconNode('back'));

	$('#pick').addEventListener('click', showPicker);
	$('#pick-back').addEventListener('click', showMain);
	$('#manage').addEventListener('click', () => openPage(''));
	$('#settings').addEventListener('click', () => openPage('#settings'));
	document.addEventListener('keydown', onKeyDown);
	$('#presets .nova-menu-item:not([disabled])')?.focus();
}

/**
 * "Coming up": the snoozed tab that wakes next (by time; "on next open" tabs
 * only when there is nothing timed), with a button to cancel that snooze.
 */
async function renderComingUp()
{
	// With several devices: the next tab that may wake on this one.
	const { [DEVICES_KEY]: devices = [] } = await browser.storage.local.get(DEVICES_KEY);
	const me = devices.find(device => device.me);
	const snoozes = (await getSnoozes()).filter(item => !item.error && (!me || !item.targets || item.targets.includes(me.id)));
	const next = snoozes.filter(item => item.wakeAt != null).sort((a, b) => a.wakeAt - b.wakeAt)[0] || snoozes[0];
	$('#coming-up').hidden = !next;
	$('#coming-up-separator').hidden = !next;
	if (!next)
	{
		return;
	}
	const favicon = next.favIconUrl
		? el('img', { class: 'favicon', src: next.favIconUrl, alt: '', referrerpolicy: 'no-referrer' })
		: el('span', { class: 'favicon', icon: 'globe' });
	$('#coming-up-row').replaceChildren(
		favicon,
		el('span', { class: 'coming-up-title', title: `${next.title}\n${next.url}`, text: next.title }),
		el('span', { class: 'coming-up-when', text: formatWhen(next.wakeAt) }),
		el('button', {
			class: 'nova-icon-button',
			type: 'button',
			icon: 'close',
			title: 'Cancel this snooze',
			'aria-label': `Cancel snooze: ${next.title}`,
			onclick: async () =>
			{
				await browser.runtime.sendMessage({ type: 'delete', ids: [next.id] });
				await renderComingUp();
				const count = (await getSnoozes()).length;
				$('#manage .count')?.remove();
				if (count)
				{
					$('#manage').append(el('span', { class: 'detail count', text: String(count) }));
				}
			},
		}),
	);
}

async function snooze(when)
{
	const message = { type: 'snooze', tabIds: targetTabs.map(tab => tab.id), wakeAt: when ? when.getTime() : null };
	if (wakeOnDevices)
	{
		message.targets = wakeOnDevices;
	}
	await browser.runtime.sendMessage(message);
	window.close();
}

/**
 * "Wake on": one checkbox per device, shown once snoozed tabs sync between
 * several devices. The tab wakes on whichever ticked device is in use.
 * The choice is remembered for the next snooze (also via the menu and shortcuts).
 */
async function renderWakeOn()
{
	const { [DEVICES_KEY]: devices = [], [LAST_TARGETS_KEY]: last = [] } = await browser.storage.local.get([DEVICES_KEY, LAST_TARGETS_KEY]);
	if (!settings.syncBookmarks || devices.length < 2)
	{
		return;
	}
	const me = devices.find(device => device.me);
	const known = last.filter(id => devices.some(device => device.id === id));
	wakeOnDevices = known.length ? known : [me ? me.id : devices[0].id];

	const sorted = [...devices].sort((a, b) => (b.me - a.me) || a.name.localeCompare(b.name));
	$('#wake-on-list').replaceChildren(...sorted.map(device => el('label', {},
		el('input', {
			type: 'checkbox',
			value: device.id,
			checked: wakeOnDevices.includes(device.id),
			onchange: onWakeOnChange,
		}),
		el('span', { text: device.me ? `${device.name} (this device)` : device.name }),
	)));
	$('#wake-on').hidden = false;
}

function onWakeOnChange(e)
{
	const ticked = [...document.querySelectorAll('#wake-on-list input:checked')].map(input => input.value);
	if (!ticked.length)
	{
		// At least one device has to wake the tab.
		e.target.checked = true;
		return;
	}
	wakeOnDevices = ticked;
	browser.storage.local.set({ [LAST_TARGETS_KEY]: ticked });
}

function showPicker()
{
	$('#main-view').hidden = true;
	$('#pick-view').hidden = false;
	const picker = createPicker($('#picker'), {
		settings,
		onConfirm: when => snooze(when),
		onCancel: showMain,
	});
	picker.focus();
}

function showMain()
{
	$('#pick-view').hidden = true;
	$('#main-view').hidden = false;
	$('#pick').focus();
}

// Opens the page, reusing a tab that already shows it.
async function openPage(hash)
{
	const [existing] = (await browser.tabs.query({})).filter(tab => (tab.url || '').startsWith(PAGE_URL));
	if (existing)
	{
		await browser.tabs.update(existing.id, { active: true, url: PAGE_URL + hash });
		await browser.windows.update(existing.windowId, { focused: true });
	}
	else
	{
		await browser.tabs.create({ url: PAGE_URL + hash });
	}
	window.close();
}

// Up/Down move through the menu; 1-6 pick a preset; Escape in the picker goes back.
function onKeyDown(e)
{
	if (!$('#pick-view').hidden)
	{
		if (e.key === 'Escape' && !e.target.closest('input'))
		{
			e.preventDefault();
			showMain();
		}
		return;
	}
	const items = [...document.querySelectorAll('#main-view .nova-menu-item:not([disabled])')];
	const index = items.indexOf(document.activeElement);
	if (e.key === 'ArrowDown' || e.key === 'ArrowUp')
	{
		e.preventDefault();
		items[(index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
	}
	else if (/^[1-6]$/.test(e.key))
	{
		const preset = document.querySelectorAll('#presets .nova-menu-item')[Number(e.key) - 1];
		if (preset && !preset.disabled)
		{
			preset.click();
		}
	}
}

init().catch(console.error);
