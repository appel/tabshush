'use strict';

/**
 * Snooze times: presets, formatting and the "tue 3pm" text parser.
 *
 * Everything is computed in the local timezone with Date's local setters, so
 * "9am" stays 9am across daylight-saving changes. Snoozes store the resulting
 * absolute time (milliseconds since 1970).
 */

const DEFAULT_SETTINGS = {
	morning: '09:00',   // Tomorrow, This/Next Weekend, Next Week, Next Month, dates without a time
	evening: '18:00',   // Later Today
	laterHours: 3,      // From an hour before the evening time, Later Today becomes "In 3 Hours"
	weekendDay: 6,      // 6 = Saturday, 0 = Sunday
	weekStartDay: 1,    // Next Week: the next one of this weekday (1 = Monday)
	notify: false,      // Notification when tabs wake up (needs the optional permission)
	showBadge: true,    // Number of snoozed tabs on the toolbar button
	syncBookmarks: false, // Keep snoozed tabs in bookmarks, so Firefox Sync carries them to other devices
	timeFormat: 'auto', // 'auto' (from the browser's language), '12' (6pm) or '24' (18:00)
	reduceMotion: 'auto', // 'auto' (follows the system setting), 'on' (no animation) or 'off'
};

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function withDefaults(settings)
{
	return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

function parseClock(value, fallback = '09:00')
{
	const match = /^(\d{1,2}):(\d{2})$/.exec(value || '') || /^(\d{1,2}):(\d{2})$/.exec(fallback);
	return { hours: Math.min(23, Number(match[1])), minutes: Math.min(59, Number(match[2])) };
}

function atClock(date, clock)
{
	const { hours, minutes } = typeof clock === 'string' ? parseClock(clock) : clock;
	const result = new Date(date);
	result.setHours(hours, minutes, 0, 0);
	return result;
}

function addDays(date, days)
{
	const result = new Date(date);
	result.setDate(result.getDate() + days);
	return result;
}

// Same day of the month, one month later; the 31st becomes the last day of a shorter month.
function addMonths(date, months)
{
	const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
	const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
	target.setDate(Math.min(date.getDate(), lastDay));
	return target;
}

function sameDay(a, b)
{
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function nextWeekday(now, weekday)
{
	return addDays(now, (weekday - now.getDay() + 7) % 7 || 7);
}

// The weekend day of this weekend, or of next weekend when it is weekend already.
function weekendDate(now, settings)
{
	const day = now.getDay();
	const inWeekend = day === 6 || day === 0;
	if (!inWeekend)
	{
		return { date: addDays(now, (settings.weekendDay - day + 7) % 7), next: false };
	}
	const nextMonday = addDays(now, (1 - day + 7) % 7 || 7);
	return { date: addDays(nextMonday, (settings.weekendDay - 1 + 7) % 7), next: true };
}

/**
 * The popup presets: [{id, label, when (Date, or null for "on next open"), detail}].
 */
function snoozePresets(rawSettings, now = new Date())
{
	const settings = withDefaults(rawSettings);
	const presets = [];

	const evening = atClock(now, settings.evening);
	if (now.getTime() < evening.getTime() - 3600e3)
	{
		presets.push({ id: 'later', label: 'Later Today', when: evening, detail: formatTime(evening) });
	}
	else
	{
		// Rounded up to the next 5 minutes.
		const when = new Date(Math.ceil((now.getTime() + settings.laterHours * 3600e3) / 300e3) * 300e3);
		presets.push({ id: 'later', label: `In ${settings.laterHours} Hours`, when, detail: sameDay(when, now) ? formatTime(when) : formatDayTime(when, false) });
	}

	const tomorrow = atClock(addDays(now, 1), settings.morning);
	presets.push({ id: 'tomorrow', label: 'Tomorrow', when: tomorrow, detail: formatTime(tomorrow) });

	const weekend = weekendDate(now, settings);
	const weekendWhen = atClock(weekend.date, settings.morning);
	presets.push({ id: 'weekend', label: weekend.next ? 'Next Weekend' : 'This Weekend', when: weekendWhen, detail: formatDayTime(weekendWhen, weekend.next) });

	const week = atClock(nextWeekday(now, settings.weekStartDay), settings.morning);
	presets.push({ id: 'week', label: 'Next Week', when: week, detail: formatDayTime(week, true) });

	const month = atClock(addMonths(now, 1), settings.morning);
	presets.push({ id: 'month', label: 'Next Month', when: month, detail: formatDayTime(month, true) });

	presets.push({ id: 'open', label: 'On Next Open', when: null, detail: '' });
	return presets;
}

/* Formatting: "6pm", "Sat, 9am", "Wed Oct 21, 9am" */

/**
 * Times as "6pm" / "6:30pm" or "18:00", per the Time format setting. Automatic
 * follows the browser's language for websites (en-US: 12-hour, nl or en-GB:
 * 24-hour); extensions cannot read the operating system's clock format.
 * getSettings() applies the setting, so every page uses the same format.
 */
const LOCALE_USES_24_HOURS = ['h23', 'h24'].includes(new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle);
let timeFormatSetting = 'auto';

function setTimeFormat(value)
{
	timeFormatSetting = value === '12' || value === '24' ? value : 'auto';
}

function uses24Hours()
{
	return timeFormatSetting === 'auto' ? LOCALE_USES_24_HOURS : timeFormatSetting === '24';
}

function formatTime(date)
{
	const hours = date.getHours();
	const minutes = date.getMinutes();
	if (uses24Hours())
	{
		return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
	}
	return `${hours % 12 || 12}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}${hours < 12 ? 'am' : 'pm'}`;
}

function formatClock(clock)
{
	return formatTime(atClock(new Date(), clock));
}

// A typed time: "7", "7pm", "7:30 p.m.", "19:30", "1930". Returns { hours, minutes } or null.
function parseClockText(text)
{
	const match = /^(\d{1,2})(?::?(\d{2}))?\s*(am|pm|a|p)?$/i.exec(String(text || '').trim().replace(/\./g, ''));
	if (!match)
	{
		return null;
	}
	let hours = Number(match[1]);
	const minutes = Number(match[2] || 0);
	if (minutes > 59)
	{
		return null;
	}
	if (match[3])
	{
		if (hours < 1 || hours > 12)
		{
			return null;
		}
		hours = (hours % 12) + (match[3][0].toLowerCase() === 'p' ? 12 : 0);
	}
	else if (hours > 23)
	{
		return null;
	}
	return { hours, minutes };
}

/**
 * The three quick times under the calendar. For another day: morning, noon
 * and evening. For today they move along with the clock: the morning time or
 * the next whole hour if that is later, then noon (or 3 hours later), then
 * the evening (or 3 hours later). Times past midnight are left out.
 * At 7:33 with a 7am morning: 8am, 12pm, 6pm; at 11:47: 12pm, 3pm, 6pm; at 2:12pm: 3pm, 6pm, 9pm.
 */
function quickClocks(day, rawSettings, now = new Date())
{
	const settings = withDefaults(rawSettings);
	const toMinutes = clock => clock.hours * 60 + clock.minutes;
	const morning = toMinutes(parseClock(settings.morning));
	const evening = toMinutes(parseClock(settings.evening));
	let times;
	if (!sameDay(day, now))
	{
		times = [...new Set([morning, 12 * 60, evening])].sort((a, b) => a - b);
	}
	else
	{
		const first = Math.max(morning, (now.getHours() + 1) * 60);
		const second = first < 12 * 60 ? 12 * 60 : first + 180;
		const third = second < evening ? evening : second + 180;
		times = [first, second, third].filter(minutes => minutes < 24 * 60);
	}
	return times.map(minutes => ({ hours: Math.floor(minutes / 60), minutes: minutes % 60 }));
}

function formatDay(date, withDate)
{
	const options = withDate ? { weekday: 'short', month: 'short', day: 'numeric' } : { weekday: 'short' };
	if (withDate && date.getFullYear() !== new Date().getFullYear())
	{
		options.year = 'numeric';
	}
	return new Intl.DateTimeFormat(undefined, options).format(date).replace(/,(?=\s\S+\s\d)/, '');
}

function formatDayTime(date, withDate)
{
	return `${formatDay(date, withDate)}, ${formatTime(date)}`;
}

// For lists: "Today, 6pm", "Tomorrow, 9am", "Wed Oct 21, 9am".
function formatWhen(timestamp, now = new Date())
{
	if (timestamp == null)
	{
		return 'On next open';
	}
	const date = new Date(timestamp);
	if (sameDay(date, now))
	{
		return `Today, ${formatTime(date)}`;
	}
	if (sameDay(date, addDays(now, 1)))
	{
		return `Tomorrow, ${formatTime(date)}`;
	}
	return formatDayTime(date, true);
}

/* Text parser */

function matchName(word, names)
{
	if (!word || word.length < 3)
	{
		return -1;
	}
	return names.findIndex(name => name.startsWith(word));
}

/**
 * Understands, among others: "in 2 hours", "in 30 min", "in 3 days", "in 2 weeks",
 * "tomorrow 3pm", "today 18:00", "tonight", "fri", "next monday 9:30", "oct 21",
 * "21 october 2pm", "2026-10-21 15:00", "noon", "this weekend", "next week".
 * A date without a time gets the morning time. Returns {when: Date} or {error}.
 */
function parseWhen(input, rawSettings, now = new Date())
{
	const settings = withDefaults(rawSettings);
	let text = (input || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,]/g, ' ').trim().replace(/\s+/g, ' ');
	if (!text)
	{
		return { error: '' };
	}

	// Relative: "in 2 hours", "in an hour", "in 10m".
	const relative = /^in (\d+|a|an|one) ?(m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|months?)$/.exec(text);
	if (relative)
	{
		const amount = /^\d+$/.test(relative[1]) ? Number(relative[1]) : 1;
		const unit = relative[2][0] === 'm' && relative[2].startsWith('mo') ? 'month' : relative[2][0];
		if (unit === 'month')
		{
			const when = addMonths(now, amount);
			when.setHours(now.getHours(), now.getMinutes(), 0, 0);
			return { when };
		}
		const minutes = { m: 1, h: 60, d: 1440, w: 10080 }[unit] * amount;
		return { when: new Date(Math.ceil((now.getTime() + minutes * 60e3) / 60e3) * 60e3) };
	}

	// Time: "3pm", "3:30 pm", "15:30", "at 15", "noon", "midnight", "morning", "evening".
	let clock = null;
	const timePatterns = [
		[/(?:^|\s)(?:at )?(\d{1,2})(?::(\d{2}))? ?(am|pm|a|p)(?=\s|$)/, m => to24(Number(m[1]), Number(m[2] || 0), m[3][0])],
		[/(?:^|\s)(?:at )?(\d{1,2})[:h](\d{2})(?=\s|$)/, m => ({ hours: Number(m[1]), minutes: Number(m[2]) })],
		[/(?:^|\s)at (\d{1,2})(?=\s|$)/, m => ({ hours: Number(m[1]), minutes: 0 })],
		[/(?:^|\s)(noon|midday)(?=\s|$)/, () => ({ hours: 12, minutes: 0 })],
		[/(?:^|\s)midnight(?=\s|$)/, () => ({ hours: 0, minutes: 0 })],
		[/(?:^|\s)(?:in the )?morning(?=\s|$)/, () => parseClock(settings.morning)],
		[/(?:^|\s)(?:in the )?evening(?=\s|$)/, () => parseClock(settings.evening)],
	];
	for (const [pattern, toClock] of timePatterns)
	{
		const match = pattern.exec(text);
		if (match)
		{
			clock = toClock(match);
			text = (text.slice(0, match.index) + ' ' + text.slice(match.index + match[0].length)).trim();
			break;
		}
	}
	if (clock && (clock.hours > 23 || clock.minutes > 59))
	{
		return { error: 'That time does not exist.' };
	}

	const words = text.split(' ').filter(Boolean);
	let date = null;

	if (!words.length || text === 'today')
	{
		date = now;
	}
	else if (text === 'tonight')
	{
		date = now;
		clock = clock || parseClock(settings.evening);
	}
	else if (text === 'tomorrow' || text === 'tmrw' || text === 'tmr')
	{
		date = addDays(now, 1);
	}
	else if (text === 'this weekend' || text === 'weekend' || text === 'next weekend')
	{
		const weekend = weekendDate(now, settings);
		date = text === 'next weekend' && !weekend.next ? addDays(weekend.date, 7) : weekend.date;
	}
	else if (text === 'next week')
	{
		date = nextWeekday(now, settings.weekStartDay);
	}
	else if (text === 'next month')
	{
		date = addMonths(now, 1);
	}
	else if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(text))
	{
		const [year, month, day] = text.split('-').map(Number);
		date = validDate(year, month - 1, day);
	}
	else
	{
		// Weekday: "fri", "next friday", "this friday".
		const weekdayWords = words[0] === 'next' || words[0] === 'this' || words[0] === 'on' ? words.slice(1) : words;
		const weekday = weekdayWords.length === 1 ? matchName(weekdayWords[0], WEEKDAY_NAMES) : -1;
		if (weekday >= 0)
		{
			let days = (weekday - now.getDay() + 7) % 7;
			// Today's weekday means today only with a time still ahead; otherwise next week.
			if (days === 0 && !(clock && atClock(now, clock) > now))
			{
				days = 7;
			}
			date = addDays(now, days);
		}
		else
		{
			date = parseMonthDay(words, now);
		}
	}

	if (!date)
	{
		return { error: 'Not understood. Try "tomorrow 3pm", "fri", "in 2 hours" or "oct 21".' };
	}
	let when = atClock(date, clock || parseClock(settings.morning));
	// Only a time ("3pm", "midnight") that has passed today means tomorrow.
	if (when <= now && !words.length && clock)
	{
		when = addDays(when, 1);
	}
	if (when <= now)
	{
		return { error: 'That time has already passed.' };
	}
	return { when };
}

function to24(hours, minutes, meridiem)
{
	if (hours < 1 || hours > 12)
	{
		return { hours: 99, minutes };
	}
	return { hours: (hours % 12) + (meridiem === 'p' ? 12 : 0), minutes };
}

function validDate(year, month, day)
{
	const date = new Date(year, month, day);
	return date.getMonth() === ((month % 12) + 12) % 12 && date.getDate() === day ? date : null;
}

// "oct 21", "october 21st 2027", "21 oct", "21st of october". Without a year, the next such date.
function parseMonthDay(words, now)
{
	const cleaned = words.filter(word => word !== 'of').map(word => word.replace(/(st|nd|rd|th)$/, ''));
	let month = -1;
	let day = NaN;
	let year = NaN;
	if (cleaned.length >= 2 && matchName(cleaned[0], MONTH_NAMES) >= 0)
	{
		month = matchName(cleaned[0], MONTH_NAMES);
		day = Number(cleaned[1]);
		year = Number(cleaned[2]);
	}
	else if (cleaned.length >= 2 && matchName(cleaned[1], MONTH_NAMES) >= 0)
	{
		month = matchName(cleaned[1], MONTH_NAMES);
		day = Number(cleaned[0]);
		year = Number(cleaned[2]);
	}
	if (month < 0 || !Number.isInteger(day) || cleaned.length > 3)
	{
		return null;
	}
	if (Number.isInteger(year) && year > 1000)
	{
		return validDate(year, month, day);
	}
	const thisYear = validDate(now.getFullYear(), month, day);
	return thisYear && atClock(thisYear, '23:59') >= now ? thisYear : validDate(now.getFullYear() + 1, month, day);
}
