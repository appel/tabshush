'use strict';

/**
 * Date and time picker: a text field ("fri 3pm", "in 2 hours"), a month
 * calendar, a time field with quick times, and Back / Snooze buttons.
 * Used in the popup and in the page's "Change" dialog.
 *
 * createPicker(container, { settings, initial, confirmLabel, cancelLabel, onConfirm(Date), onCancel })
 * Returns { focus() }.
 */

// Weeks start on Monday in the calendar.
const CALENDAR_FIRST_DAY = 1;

function createPicker(container, options)
{
	const settings = withDefaults(options.settings);
	const now = new Date();
	// Starts at the given time, or at the current time rounded up to the next quarter of an hour.
	const nextQuarter = new Date(Math.floor(now.getTime() / 900e3) * 900e3 + 900e3);
	const start = options.initial && options.initial > now ? new Date(options.initial) : nextQuarter;
	const pick = {
		day: new Date(start.getFullYear(), start.getMonth(), start.getDate()),
		clock: { hours: start.getHours(), minutes: start.getMinutes() },
		month: new Date(start.getFullYear(), start.getMonth(), 1),
	};

	const textInput = el('input', { class: 'nova-input picker-text', type: 'text', placeholder: 'e.g. fri 3pm, in 2 hours, oct 21', 'aria-label': 'Type a date and time', autocomplete: 'off', spellcheck: 'false' });
	const hint = el('p', { class: 'picker-hint', 'aria-live': 'polite' });
	const monthLabel = el('span', { class: 'calendar-month' });
	const grid = el('div', { class: 'calendar-grid', role: 'grid', 'aria-label': 'Calendar' });
	// A text field rather than type="time": Firefox's time field always uses its own clock format.
	const timeInput = el('input', { class: 'nova-input picker-time', type: 'text', 'aria-label': 'Time', autocomplete: 'off', spellcheck: 'false', placeholder: uses24Hours() ? '18:00' : '6pm' });
	const quickTimes = el('span', { class: 'picker-quick' });
	const confirmButton = el('button', { class: 'nova-button primary', type: 'button', text: options.confirmLabel || 'Snooze' });

	function renderQuickTimes()
	{
		quickTimes.replaceChildren(...quickClocks(pick.day, settings).map(clock => el('button', {
			class: 'nova-button picker-chip',
			type: 'button',
			text: formatClock(clock),
			onclick: () =>
			{
				pick.clock = clock;
				update();
			},
		})));
	}

	container.replaceChildren(el('div', { class: 'picker' },
		textInput,
		hint,
		el('div', { class: 'calendar' },
			el('div', { class: 'calendar-head' },
				el('button', { class: 'nova-icon-button', type: 'button', icon: 'prev', 'aria-label': 'Previous month', onclick: () => moveMonth(-1) }),
				monthLabel,
				el('button', { class: 'nova-icon-button', type: 'button', icon: 'next', 'aria-label': 'Next month', onclick: () => moveMonth(1) }),
			),
			grid,
		),
		el('div', { class: 'picker-times' }, timeInput, quickTimes),
		el('div', { class: 'picker-footer' },
			el('button', { class: 'nova-button', type: 'button', text: options.cancelLabel || 'Back', onclick: () => options.onCancel?.() }),
			confirmButton,
		),
	));

	function selected()
	{
		return atClock(pick.day, pick.clock);
	}

	function moveMonth(delta)
	{
		pick.month = new Date(pick.month.getFullYear(), pick.month.getMonth() + delta, 1);
		renderCalendar();
	}

	function renderCalendar()
	{
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		monthLabel.textContent = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(pick.month);

		const headers = [];
		for (let i = 0; i < 7; i++)
		{
			const day = addDays(new Date(2024, 0, 7), (CALENDAR_FIRST_DAY + i) % 7); // 2024-01-07 is a Sunday
			headers.push(el('span', { class: 'calendar-weekday', role: 'columnheader', text: new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(day).slice(0, 2) }));
		}

		const first = addDays(pick.month, -((pick.month.getDay() - CALENDAR_FIRST_DAY + 7) % 7));
		const days = [];
		for (let i = 0; i < 42; i++)
		{
			const day = addDays(first, i);
			const isSelected = sameDay(day, pick.day);
			days.push(el('button', {
				class: 'calendar-day' + (day.getMonth() !== pick.month.getMonth() ? ' other-month' : '') + (sameDay(day, today) ? ' today' : '') + (isSelected ? ' selected' : ''),
				type: 'button',
				role: 'gridcell',
				tabindex: isSelected ? '0' : '-1',
				disabled: day < today,
				'aria-selected': String(isSelected),
				'aria-label': new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(day),
				dataset: { date: String(day.getTime()) },
				text: String(day.getDate()),
			}));
		}
		grid.replaceChildren(...headers, ...days);
	}

	// Arrow keys move the selected day; Page Up/Down change the month.
	grid.addEventListener('keydown', e =>
	{
		const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
		let target = null;
		if (e.key in steps)
		{
			target = addDays(pick.day, steps[e.key]);
		}
		else if (e.key === 'PageUp' || e.key === 'PageDown')
		{
			target = addMonths(pick.day, e.key === 'PageUp' ? -1 : 1);
		}
		if (!target)
		{
			return;
		}
		e.preventDefault();
		if (target >= new Date(now.getFullYear(), now.getMonth(), now.getDate()))
		{
			selectDay(target);
			grid.querySelector('.calendar-day.selected')?.focus();
		}
	});

	grid.addEventListener('click', e =>
	{
		const button = e.target.closest('.calendar-day');
		if (button && !button.disabled)
		{
			selectDay(new Date(Number(button.dataset.date)));
		}
	});

	function selectDay(day)
	{
		pick.day = day;
		pick.month = new Date(day.getFullYear(), day.getMonth(), 1);
		update();
	}

	function update(message = null)
	{
		renderCalendar();
		renderQuickTimes();
		// Not while typing in it: the field is only rewritten once the typed time is applied.
		if (document.activeElement !== timeInput)
		{
			timeInput.value = formatClock(pick.clock);
		}
		const when = selected();
		const past = when <= new Date();
		hint.classList.toggle('error', past || !!message);
		hint.textContent = message || (past ? 'That time has already passed.' : `Wakes up ${formatWhen(when.getTime())}`);
		confirmButton.disabled = past || !!message;
	}

	textInput.addEventListener('input', () =>
	{
		const result = parseWhen(textInput.value, settings);
		if (result.when)
		{
			pick.day = new Date(result.when.getFullYear(), result.when.getMonth(), result.when.getDate());
			pick.month = new Date(pick.day.getFullYear(), pick.day.getMonth(), 1);
			pick.clock = { hours: result.when.getHours(), minutes: result.when.getMinutes() };
			update();
		}
		else
		{
			update(textInput.value.trim() ? result.error : null);
		}
	});

	textInput.addEventListener('keydown', e =>
	{
		if (e.key === 'Enter' && !confirmButton.disabled)
		{
			e.preventDefault();
			confirmButton.click();
		}
	});

	// The typed time applies on Enter or when leaving the field.
	function applyTypedTime()
	{
		const clock = parseClockText(timeInput.value);
		if (!clock)
		{
			update(`"${timeInput.value.trim()}" is not a time. Try ${uses24Hours() ? '18:30' : '6:30pm'}.`);
			return false;
		}
		pick.clock = clock;
		timeInput.value = formatClock(clock);
		update();
		return true;
	}

	timeInput.addEventListener('change', applyTypedTime);
	timeInput.addEventListener('keydown', e =>
	{
		if (e.key === 'Enter')
		{
			e.preventDefault();
			applyTypedTime();
		}
	});

	confirmButton.addEventListener('click', () =>
	{
		const when = selected();
		if (when > new Date())
		{
			options.onConfirm(when);
		}
	});

	update();
	return { focus: () => textInput.focus() };
}
