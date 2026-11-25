; Kolonka installer hooks (included by electron-builder).
; If installation fails, offer a pre-filled GitHub issue so the user can report it.

Function .onInstFailed
  MessageBox MB_YESNO|MB_ICONEXCLAMATION "Kolonka could not be installed.$\r$\n$\r$\nWould you like to report this on GitHub? A pre-filled issue will open in your browser." IDNO kolonka_no_report
    ExecShell "open" "https://github.com/huopolinen/kolonka/issues/new?labels=installer&title=Installer%20failed%20(v${VERSION})&body=%23%23%23%20What%20happened%0A%3C!--%20Which%20step%20failed%3F%20Any%20error%20text%3F%20--%3E%0A%0A%23%23%23%20Environment%0A-%20Kolonka%3A%20${VERSION}%0A-%20Windows%20version%3A%20%3C!--%20Win%2BR%20%E2%86%92%20winver%20--%3E%0A-%20Antivirus%3A%20%0A"
  kolonka_no_report:
FunctionEnd
