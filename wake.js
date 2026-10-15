'use strict';

/**
 * Stand-in for a woken tab, so it shows the TabShush bell as its icon and the
 * page's own title until you look at it. When the tab is selected (or is
 * already visible), it is replaced by the real page; location.replace keeps
 * this stand-in out of the tab's back history.
 *
 * The address comes from the query string (?u=...&t=...). Only web addresses
 * are followed, the same ones TabShush accepts for snoozing.
 *
 * Until then the bell blinks: the tab icon switches between the outline and
 * the filled bell every second, unless motion is reduced (Settings, or the
 * system's reduced-motion setting when that is set to Automatic).
 */

const params = new URLSearchParams(location.search);
const url = params.get('u') || '';
const title = (params.get('t') || url).slice(0, 1024);

document.title = title || 'Snoozed tab';
document.getElementById('title').textContent = title || 'Snoozed tab';
document.getElementById('address').textContent = url;

if (!/^(https?|ftp):/i.test(url))
{
	document.getElementById('status').textContent = 'This address cannot be opened.';
}
else
{
	const open = () =>
	{
		if (document.visibilityState === 'visible')
		{
			location.replace(url);
		}
	};
	document.addEventListener('visibilitychange', open);
	open();
	blinkBell();
}

async function blinkBell()
{
	const { reduceMotion } = await getSettings();
	const reduce = reduceMotion === 'on' || (reduceMotion === 'auto' && matchMedia('(prefers-reduced-motion: reduce)').matches);
	if (reduce)
	{
		return;
	}
	const favicon = document.getElementById('favicon');
	const icons = ['icons/wake-tab.svg', 'icons/wake-tab-filled.svg'];
	let filled = false;
	setInterval(() =>
	{
		filled = !filled;
		favicon.href = icons[Number(filled)];
	}, 1000);
}
