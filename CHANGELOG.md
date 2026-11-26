# Changelog

## Unreleased

### New

- **Connect a server in one click.** ⚙ → **Connect a server…** (also in the command palette) asks for the address of a server and sets up remote control for it: Kolonka adds a block that sends its variables to that server to `%USERPROFILE%\.ssh\config` (keeping a copy of the old file), trusts the server as with *Always for this host* and opens a tab to it. **Disconnect a server…** undoes it. The same from the command line: `kolonka remote connect ADDRESS` / `kolonka remote disconnect ADDRESS`; `Kolonka.exe --connect=ADDRESS` opens the dialog filled in. A first start offers it next to *New session*.

### Fixed

- **Remote control:** `open` with `host=@same` written as it is (not in base64) is accepted; 0.2.0 ignored it. A tab where you typed `ssh -o SendEnv=…` can open tabs to the same server: the `SendEnv` options are carried over (any other `-o` is still refused). A request Kolonka cannot read now shows a note in the window (once a minute per tab) instead of only a line in the log.

## 0.2.0

0.1.0 doesn't update itself — install 0.2.0 once manually; from 0.2.0 on updates arrive automatically. Your tabs, settings and voice files stay.

### New

- **Remote control over SSH.** A program on a server you reach over ssh (also inside tmux) can open a tab to the same server, set a tab's status, show a notification or rename the tab, by printing an escape sequence (OSC 7711). The `kolonka-remote` script for the server is installed with `kolonka remote install HOST`. Opening tabs is protected by a per-tab token, an allow-list of hosts and a confirmation dialog. Standard `OSC 9` and `OSC 777` notifications are shown too. See *Remote control over SSH* in the README.
- **Automatic updates.** Kolonka checks the latest published release on start and every 6 hours, downloads it in the background and installs it when you quit, or right away with **Restart to update**. `"updates": "notify"` only tells you, `"updates": "off"` turns checks off. **Check for updates** is in the command palette and the ⚙ menu.
- **Releases built by CI.** Installers are built by GitHub Actions from the tagged commit, with `SHA256SUMS.txt` and a build provenance attestation (`gh attestation verify`).
- **Electron 45** (Electron 39 is out of support). The unpacked app is about 20 MB smaller.
- `GET /api/workspaces/:w` returns one workspace; `kolonka run --wait RE …` runs a command and waits for its output in one call.

### Fixed

- **Security:** paths printed by programs in a tab are used as the tab's folder only if they are local, so a network path can no longer leak your Windows credentials. The API token is accepted only in the `Authorization` header. Dictation API keys never reach the window, and DevTools are off in release builds. Problem reports remove more kinds of keys and tokens. The local speech server gets a secret address, and speech downloads are pinned and checked by SHA-256.
- **Claude Code hooks** no longer show errors when `node` is not in `PATH` or after Kolonka is uninstalled. Hooks from 0.1.0 are rewritten on first start. Uninstalling removes the hooks and offers to delete the voice files.
- **Tabs:** restarting a tab no longer breaks it, and it runs the tab's command again. Background tabs open at the right size, output is no longer shown twice, and tabs are not lost on quit, log off or shutdown. A damaged or locked `state.json` is kept instead of being overwritten.
- **Keyboard and voice:** copy and paste work on the Russian and other layouts. IME input is no longer interrupted. A modifier key (`ControlRight`, `AltRight`) works as the dictation key, and the microphone no longer stays on after a quick press.
- **API and CLI:** Kolonka always opens a window, even if the API port is taken. `wait` no longer misses output that arrived before it started. `kolonka.cmd` prints Unicode correctly without `node` on PATH.
- **Settings:** `settings.json` accepts comments and trailing commas. A file that cannot be read is reported in the window instead of being silently ignored. New defaults reach you with updates unless you set the option yourself.
- The speech server no longer crashes Kolonka when it fails to start, and no longer keeps running (with the model in video memory) after Kolonka exits. Speech downloads survive antivirus locks and report a full disk.

### Changed

- CLI options go before the command for `run`, `type` and `new`: `kolonka type --enter hello`, not `kolonka type hello --enter`.
- A `settings.json` that is an untouched copy of the 0.1.0 defaults is replaced once by a short template; the old file is kept as `settings.json.bak-0.1.0`.
- A tab can no longer start in a network (UNC) folder; mapped drives work.
- The installer is not code-signed yet, so Windows SmartScreen may warn about it (**More info → Run anyway**).
