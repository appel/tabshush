'use strict';

const $ = selector => document.querySelector(selector);

// Creates an element. Text always goes in as text (never HTML); `icon` adds a static icon from ICONS.
function el(tag, attrs = {}, ...children)
{
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs))
	{
		if (value == null || value === false)
		{
			continue;
		}
		if (key === 'class')
		{
			node.className = value;
		}
		else if (key === 'text')
		{
			node.textContent = value;
		}
		else if (key === 'icon')
		{
			node.append(iconNode(value));
		}
		else if (key === 'dataset')
		{
			Object.assign(node.dataset, value);
		}
		else if (key.startsWith('on'))
		{
			node.addEventListener(key.slice(2), value);
		}
		else
		{
			node.setAttribute(key, value === true ? '' : value);
		}
	}
	node.append(...children.filter(child => child != null && child !== false));
	return node;
}

const svg = (body, attrs = 'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"') =>
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" ${attrs}>${body}</svg>`;

// Static markup only, parsed once and cloned per use.
const ICONS = {
	later: svg('<circle cx="8" cy="8" r="6.2"/><path d="M8 4.5V8l2.3 1.6"/>'),
	tomorrow: svg('<path d="M1.5 12.5h13M4.2 12.5a3.8 3.8 0 0 1 7.6 0M8 3.2v1.6M3.4 5.4l1.1 1.1M12.6 5.4l-1.1 1.1M1.8 9.6h1.4M12.8 9.6h1.4"/>'),
	weekend: svg('<path d="M3 6.5h8v3.5a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z"/><path d="M11 7.5h1a1.6 1.6 0 0 1 0 3.2h-1.2M5.2 2.5v1.8M7.6 2.5v1.8"/>'),
	week: svg('<rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.5 1.8v2.4M10.5 1.8v2.4M6 10h4M8.6 8.6 10 10l-1.4 1.4"/>'),
	month: svg('<rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.5 1.8v2.4M10.5 1.8v2.4"/><circle cx="5.5" cy="9.5" r=".4" fill="currentColor"/><circle cx="8" cy="9.5" r=".4" fill="currentColor"/><circle cx="10.5" cy="9.5" r=".4" fill="currentColor"/><circle cx="5.5" cy="11.8" r=".4" fill="currentColor"/><circle cx="8" cy="11.8" r=".4" fill="currentColor"/>'),
	open: svg('<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5v2.8h-2.8"/>'),
	pick: svg('<rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.5 1.8v2.4M10.5 1.8v2.4M8 8.5v3.5M6.2 10.2h3.6"/>'),
	manage: svg('<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.6" cy="4" r=".6" fill="currentColor"/><circle cx="2.6" cy="8" r=".6" fill="currentColor"/><circle cx="2.6" cy="12" r=".6" fill="currentColor"/>'),
	// Bootstrap Icons "keyboard", "gear" and "info-circle" (MIT License).
	shortcuts: svg('<path d="M14 5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM2 4a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><path d="M13 10.25a.25.25 0 0 1 .25-.25h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5a.25.25 0 0 1-.25-.25zm0-2a.25.25 0 0 1 .25-.25h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5a.25.25 0 0 1-.25-.25zm-5 0A.25.25 0 0 1 8.25 8h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5A.25.25 0 0 1 8 8.75zm2 0a.25.25 0 0 1 .25-.25h1.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-1.5a.25.25 0 0 1-.25-.25zm1 2a.25.25 0 0 1 .25-.25h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5a.25.25 0 0 1-.25-.25zm-5-2A.25.25 0 0 1 6.25 8h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5A.25.25 0 0 1 6 8.75zm-2 0A.25.25 0 0 1 4.25 8h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5A.25.25 0 0 1 4 8.75zm-2 0A.25.25 0 0 1 2.25 8h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5A.25.25 0 0 1 2 8.75zm11-2a.25.25 0 0 1 .25-.25h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5a.25.25 0 0 1-.25-.25zm-2 0a.25.25 0 0 1 .25-.25h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5a.25.25 0 0 1-.25-.25zm-2 0A.25.25 0 0 1 9.25 6h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5A.25.25 0 0 1 9 6.75zm-2 0A.25.25 0 0 1 7.25 6h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5A.25.25 0 0 1 7 6.75zm-2 0A.25.25 0 0 1 5.25 6h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5A.25.25 0 0 1 5 6.75zm-3 0A.25.25 0 0 1 2.25 6h1.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-1.5A.25.25 0 0 1 2 6.75zm0 4a.25.25 0 0 1 .25-.25h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5a.25.25 0 0 1-.25-.25zm2 0a.25.25 0 0 1 .25-.25h5.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-5.5a.25.25 0 0 1-.25-.25z"/>', 'fill="currentColor"'),
	settings: svg('<path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492M5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0"/><path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115z"/>', 'fill="currentColor"'),
	about: svg('<path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16"/><path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0"/>', 'fill="currentColor"'),
	back: svg('<path d="M10 3.5 5.5 8l4.5 4.5"/>'),
	prev: svg('<path d="M10 3.5 5.5 8l4.5 4.5"/>'),
	next: svg('<path d="M6 3.5 10.5 8 6 12.5"/>'),
	close: svg('<path d="M4.5 4.5l7 7m0-7l-7 7"/>'),
	wake: svg('<circle cx="8" cy="8.8" r="5.2"/><path d="M8 6v2.8l1.8 1.2M2.2 3.6 4 2M13.8 3.6 12 2"/>'),
	edit: svg('<path d="M10.5 2.8 13.2 5.5 6 12.7l-3.3.6.6-3.3z"/>'),
	search: svg('<circle cx="6.75" cy="6.75" r="4.75"/><path d="M10.25 10.25 14 14"/>', 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"'),
	globe: svg('<circle cx="8" cy="8" r="6.2"/><ellipse cx="8" cy="8" rx="2.6" ry="6.2"/><path d="M1.8 8h12.4"/>'),
};

const iconCache = new Map();

function iconNode(name)
{
	if (!iconCache.has(name))
	{
		iconCache.set(name, new DOMParser().parseFromString(ICONS[name], 'image/svg+xml').documentElement);
	}
	return document.importNode(iconCache.get(name), true);
}

function plural(count, one, many)
{
	return count === 1 ? one : many.replace('#', count);
}
