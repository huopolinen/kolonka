; Kolonka installer hooks (included by electron-builder).
; If installation fails, offer a pre-filled GitHub issue so the user can report it.

Function .onInstFailed
  ; silent installs (/S, scripted deployment) must not block on a dialog
  IfSilent kolonka_no_report
  MessageBox MB_YESNO|MB_ICONEXCLAMATION "Kolonka could not be installed.$\r$\n$\r$\nWould you like to report this on GitHub? A pre-filled issue will open in your browser." IDNO kolonka_no_report
    ExecShell "open" "https://github.com/huopolinen/kolonka/issues/new?labels=installer&title=Installer%20failed%20(v${VERSION})&body=%23%23%23%20What%20happened%0A%3C!--%20Which%20step%20failed%3F%20Any%20error%20text%3F%20--%3E%0A%0A%23%23%23%20Environment%0A-%20Kolonka%3A%20${VERSION}%0A-%20Windows%20version%3A%20%3C!--%20Win%2BR%20%E2%86%92%20winver%20--%3E%0A-%20Antivirus%3A%20%0A"
  kolonka_no_report:
FunctionEnd

; Runs in the uninstall section, before the app files are removed (electron-builder's uninstaller.nsh
; inserts it ahead of RMDir $INSTDIR). An update also runs the old uninstaller, with --updated;
; nothing here may happen then, or every update would drop the hooks and the speech model.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; 1. Remove the Claude Code status hooks, or Claude Code reports a failing hook on every prompt and
    ;    tool call once Kolonka.exe is gone. Uses the app's own Node runtime; a failure is not fatal.
    IfFileExists "$INSTDIR\resources\bin\kolonka.js" 0 kolonka_hooks_done
      System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1") i'
      nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\bin\kolonka.js" hooks uninstall'
      Pop $0
      DetailPrint "Claude Code hooks removal: $0"
      System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", p 0) i'
    kolonka_hooks_done:

    ; 2. Offer to delete the speech engine and model (0.1-1.6 GB) downloaded on first use.
    ;    The one-click uninstaller always runs this section in silent mode after its own confirmation,
    ;    so ask unless the user passed /S explicitly; with /S keep the files and do not ask.
    IfFileExists "$LOCALAPPDATA\Kolonka\whisper\*.*" 0 kolonka_whisper_done
      ${GetParameters} $R0
      ClearErrors
      ${GetOptions} $R0 "/S" $R1
      IfErrors 0 kolonka_whisper_done
      MessageBox MB_YESNO|MB_ICONQUESTION "Also delete the voice input files (speech engine and model) in$\r$\n$LOCALAPPDATA\Kolonka\whisper?" IDNO kolonka_whisper_done
        ; a whisper-server left running would keep its files locked; stop only ours, by path
        nsExec::Exec `powershell.exe -NoProfile -NonInteractive -Command "Get-Process whisper-server -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like '$LOCALAPPDATA\Kolonka\whisper\*' } | Stop-Process -Force"`
        Pop $0
        RMDir /r "$LOCALAPPDATA\Kolonka\whisper"
        RMDir "$LOCALAPPDATA\Kolonka"
    kolonka_whisper_done:
  ${endIf}
!macroend
