; VibeDev installed as "VibeDev Next" (same appId) while VibeDev Studio still occupied the
; "VibeDev" name. An installation still in a folder of that name moves to the folder of the
; current name: electron-builder runs the previous uninstaller with --updated (user data and
; profile kept) and puts the new files in the new folder; the shortcuts follow the new name.
!define DSH_PREVIOUS_FILENAME "VibeDev Next"

; Requires $PLUGINSDIR\window-frame.dll. Updates $INSTDIR and $InstallerPath.
Function InstallerAdoptPreviousName
  Push $0
  Push $1
  Push $2
  StrLen $0 "\${DSH_PREVIOUS_FILENAME}"
  IntOp $2 0 - $0
  StrCpy $1 $INSTDIR "" $2
  ${If} $1 == "\${DSH_PREVIOUS_FILENAME}"
    ; Its files cannot be replaced while it runs, and the current-name check would not see it.
    System::Call '$PLUGINSDIR\window-frame.dll::InstallerFindProcess(w "$INSTDIR\${DSH_PREVIOUS_FILENAME}.exe") i.R0 ?c'
    ${If} $R0 == 0
      MessageBox MB_OK|MB_ICONINFORMATION "$(INSTALLER_RUNNING)" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
    StrCpy $1 $INSTDIR $2
    StrCpy $INSTDIR "$1\${APP_FILENAME}"
    StrCpy $InstallerPath $INSTDIR
  ${EndIf}
  ; VibeDev Studio (the earlier product) installed into a folder of this same name. The preflight
  ; refuses a non-empty folder anyway; this says why, so the person can uninstall it or pick another folder.
  ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VibeDev-default" InstallLocation
  ${If} $1 != ""
  ${AndIf} $1 == $INSTDIR
  ${AndIf} ${FileExists} "$INSTDIR\*.*"
    MessageBox MB_OK|MB_ICONINFORMATION "$(INSTALLER_LEGACY_STUDIO)" /SD IDOK
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; The earlier VibeDev Studio's uninstall entry is left behind when its folder was deleted by hand;
; with its folder gone it can only confuse the Apps list. Removed only in that case.
Function InstallerForgetOrphanStudio
  Push $0
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VibeDev-default" InstallLocation
  ${If} $0 != ""
  ${AndIfNot} ${FileExists} "$0\*.*"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\VibeDev-default"
  ${EndIf}
  Pop $0
FunctionEnd
