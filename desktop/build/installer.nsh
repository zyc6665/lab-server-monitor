; P8 Task 6 — NSIS include for electron-builder (nsis.include).
; - Default install dir D:\Tools\ServerMonitor (no D: -> %LOCALAPPDATA%\Programs\ServerMonitor), wizard can change it.
; - Refuse to install/uninstall while the app is running (ask user to quit the tray first).
; - Uninstall asks whether to delete the data directory (default: No). /S always keeps data.
;   Updates (${isUpdated}) never touch data, the pointer or the autostart entry.
; - Removes leftover empty directories under $INSTDIR.

!define SM_REG_KEY "Software\ServerMonitor"
!define SM_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

!macro preInit
  ; Seed the default only when no previous install location is recorded.
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp $0 "" 0 sm_preinit_done
    IfFileExists "D:\*.*" 0 sm_preinit_nod
      WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\Tools\ServerMonitor"
      Goto sm_preinit_done
    sm_preinit_nod:
      WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\ServerMonitor"
  sm_preinit_done:
!macroend

; Returns $R0 = 0 when the app process is running.
!macro SM_IsRunning
  nsExec::ExecToStack `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /NH | "$SYSDIR\find.exe" /I "${APP_EXECUTABLE_FILENAME}"`
  Pop $R0
  Pop $R1
!macroend

!macro customCheckAppRunning
  sm_check_again:
  !insertmacro SM_IsRunning
  StrCmp $R0 "0" 0 sm_check_ok
    IfSilent sm_check_kill
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${PRODUCT_NAME} 正在运行。请先在托盘图标右键选择“退出”，然后点击“重试”。" IDRETRY sm_check_again
    Quit
  sm_check_kill:
    ; Silent mode: cannot prompt; stop the app so files are not locked.
    nsExec::Exec `"$SYSDIR\taskkill.exe" /IM "${APP_EXECUTABLE_FILENAME}" /T`
    Sleep 3000
    nsExec::Exec `"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}" /T`
    Sleep 500
  sm_check_ok:
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ReadRegStr $R2 HKCU "${SM_REG_KEY}" "DataDir"
    ${if} $R2 != ""
    ${andIf} ${FileExists} "$R2\*.*"
      IfSilent sm_keep_data
      MessageBox MB_YESNO|MB_DEFBUTTON2|MB_ICONQUESTION "是否同时删除数据目录？$\r$\n$R2$\r$\n$\r$\n（包含数据库、密钥与日志；默认保留，选“否”可在重装后继续使用）" IDYES sm_delete_data IDNO sm_keep_data
      sm_delete_data:
        RMDir /r "$R2"
      sm_keep_data:
    ${endIf}
    DeleteRegValue HKCU "${SM_REG_KEY}" "DataDir"
    DeleteRegKey /ifempty HKCU "${SM_REG_KEY}"
    DeleteRegValue HKCU "${SM_RUN_KEY}" "${PRODUCT_NAME}"
    DeleteRegValue HKCU "${SM_RUN_KEY}" "electron.app.${PRODUCT_NAME}"
    DeleteRegValue HKCU "${SM_RUN_KEY}" "${APP_FILENAME}"

    ; Leftover empty directories (non-recursive RMDir only removes empty ones).
    RMDir "$INSTDIR\resources\backend\node_modules"
    RMDir "$INSTDIR\resources\backend"
    RMDir "$INSTDIR\resources"
    RMDir "$INSTDIR\locales"
    RMDir "$INSTDIR"
  ${endIf}
!macroend
