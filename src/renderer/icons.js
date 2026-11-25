'use strict';
// A small set of line icons (stroke = currentColor).
window.ICONS = (() => {
  const s = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  return {
    chevron: s('<path d="M9 6l6 6-6 6"/>'),
    plus: s('<path d="M12 5v14M5 12h14"/>'),
    close: s('<path d="M7 7l10 10M17 7L7 17"/>'),
    more: s('<circle cx="6" cy="12" r="1.2" class="fill"/><circle cx="12" cy="12" r="1.2" class="fill"/><circle cx="18" cy="12" r="1.2" class="fill"/>'),
    folder: s('<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>'),
    terminal: s('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 10l3 2.5L7 15M12.5 15H17"/>'),
    check: s('<path d="M5 12.5l4.2 4.2L19 7"/>'),
    edit: s('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
    restart: s('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/>'),
    trash: s('<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>'),
    copy: s('<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15V6a1 1 0 0 1 1-1h9"/>'),
    open: s('<path d="M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"/>'),
    move: s('<path d="M5 12h14M14 7l5 5-5 5"/>'),
    gear: s('<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>'),
    api: s('<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>'),
    dot: s('<circle cx="12" cy="12" r="4" class="fill"/>'),
    collapse: s('<path d="M7 10l5-5 5 5M7 14l5 5 5-5"/>'),
    search: s('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
    mic: s('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>'),
    bug: s('<rect x="7" y="8" width="10" height="12" rx="5"/><path d="M12 12v6M4 13h3M17 13h3M5 8l2.5 2M19 8l-2.5 2M5 19l2.5-2M19 19l-2.5-2M9.5 8a2.5 2.5 0 0 1 5 0"/>'),
    bolt: s('<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>'),
  };
})();
