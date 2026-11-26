'use strict';
// Small pieces of window logic without DOM access, shared with the unit tests.
(function (root) {
  // A letter key by its physical position, so shortcuts work on any layout:
  // on the Russian layout Ctrl+C gives e.key 'с', but e.code is still 'KeyC' (keyCode 67).
  function isKey(e, letter) {
    const L = letter.toUpperCase();
    return e.code === 'Key' + L || e.keyCode === L.charCodeAt(0);
  }

  // The key belongs to an IME composition (Chinese, Japanese, Korean input): leave it alone.
  function isComposing(e) { return !!e.isComposing || e.keyCode === 229; }

  // What a key in a terminal does with the clipboard: 'copy-clear' (Ctrl+C with a selection),
  // 'copy' (Ctrl+Shift+C), 'paste' (Ctrl+V, Ctrl+Shift+V) or null.
  function clipboardAction(e, hasSelection) {
    if (e.type !== 'keydown' || !e.ctrlKey || e.altKey) return null; // AltGr is Ctrl+Alt
    if (!e.shiftKey && isKey(e, 'c') && hasSelection) return 'copy-clear';
    if (e.shiftKey && isKey(e, 'c')) return 'copy';
    if (isKey(e, 'v')) return 'paste';
    return null;
  }

  // A size the user picked in the window (font zoom, sidebar width) is remembered together with the
  // settings.json value it was picked over; once settings.json says something else, settings.json wins.
  function storedSize(storage, key, base, dflt) {
    const raw = storage.getItem(key);
    if (raw == null) return null;
    let v = null;
    try { v = JSON.parse(raw); } catch { /* garbage */ }
    if (typeof v === 'number' && v > 0) {
      // saved by an older version without the base: valid only if settings.json does not set the option
      if (base === undefined || base === null || base === dflt) return v;
    } else if (v && typeof v.value === 'number' && v.value > 0 && v.base === (base === undefined ? null : base)) {
      return v.value;
    }
    storage.removeItem(key);
    return null;
  }
  function storeSize(storage, key, value, base) {
    storage.setItem(key, JSON.stringify({ value, base: base === undefined ? null : base }));
  }

  const UiLogic = { isKey, isComposing, clipboardAction, storedSize, storeSize };
  if (typeof module === 'object' && module.exports) module.exports = UiLogic;
  else root.UiLogic = UiLogic;
})(typeof self !== 'undefined' ? self : this);
