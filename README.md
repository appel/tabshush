# TabShush

A Firefox add-on for snoozing your tabs. Not ready for a tab just yet? Give it a little shush: TabShush closes it now and brings it back when you want it.

## Features

- Snooze until later today, tomorrow, this or next weekend, next week, next month, or the next time Firefox opens.
- Or pick any date and time, with a calendar or by typing ("fri 3pm", "in 2 hours", "oct 21").
- Woken tabs open next to the tab you are on, with a ringing bell icon so they don't sneak past you.
- Snooze from the toolbar button, the tab context menu or keyboard shortcuts, for one tab or all selected tabs.
- A full page to manage, search, reschedule and cancel snoozed tabs.
- Optional sync between devices through your bookmarks (needs Firefox Sync with Bookmarks enabled), with a choice of which devices may wake each tab.
- Backup and restore, and import from the SnoozeTabs add-on.
- Light and dark mode, 12 or 24-hour time, reduced motion.

## Permissions

| Permission | Why |
| --- | --- |
| tabs | Read the title and address of the tab you snooze, and reopen it later |
| storage | Keep your snoozed tabs and settings |
| alarms | Wake tabs at the right time |
| menus | The "Snooze until" tab context menu |
| idle | When syncing, let the device you are using wake a tab first |
| bookmarks (optional) | Sync between devices, only when you turn it on |
| notifications (optional) | A notification when a tab wakes, only when you turn it on |

TabShush collects no data. Everything stays in your browser, or in your own bookmarks when sync is on.

## Install

Not on addons.mozilla.org yet. To try it from source, open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on** and pick `manifest.json`.

## Development

Plain JavaScript, HTML and CSS without a build step. With Node.js installed:

```
npx web-ext@8 lint     # check the add-on
npx web-ext@8 run      # start Firefox with the add-on loaded
npx web-ext@8 build    # package it into web-ext-artifacts/
```

## Credits

Icons from [Bootstrap Icons](https://icons.getbootstrap.com), © The Bootstrap Authors, MIT License. TabShush was made with AI.

## License

[MIT](LICENSE)
