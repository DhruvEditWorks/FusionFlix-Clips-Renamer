; ---------------------------------------------------------------------------
; FUSION FLIX - CLIP RENAMER & SORTER
; Placeholder uninstaller ("uninstaller-stub.exe").
;
; Why this file exists
; -------------------
; electron-builder's stock NSIS template always embeds a file at
;   $INSTDIR\Uninstall Fusion Flix Clip Renamer & Sorter.exe
; (the File command inside templates/nsis/include/installer.nsh).  Normally
; that file is the uninstaller that electron-builder pre-buids by *running*
; the installer under wine/Windows.  A Linux build box without a working wine
; cannot do that, so packaging/installer.nsi points that File command here
; instead and the real uninstaller is written on the user's machine at install
; time with NSIS' WriteUninstaller (see the customInstall macro in
; packaging/installer.nsh).
;
; This stub is therefore overwritten during every normal installation and is
; never executed.  It is kept as a safety net: should WriteUninstaller ever
; fail (locked file, no space, ...) the user still gets a working uninstaller
; that removes the program folder, the shortcuts and the registry entries
; instead of a dead file.  It understands /S (silent) like every NSIS exe.
;
; Regenerate after changing this file:  npm run uninstaller-stub
; ---------------------------------------------------------------------------

Unicode true

!define FF_APPNAME "Fusion Flix Clip Renamer & Sorter"

Name "Fusion Flix Clip Renamer & Sorter"
Caption "Uninstall Fusion Flix Clip Renamer & Sorter"
BrandingText "A free to use tool by Fusion Flix (Dhruv Sharma)"

OutFile "uninstaller-stub.exe"
ShowInstDetails nevershow
RequestExecutionLevel user
SetCompressor /SOLID lzma

Icon "${__FILEDIR__}\..\icons\icon.ico"

VIProductVersion "1.0.0.0"
VIAddVersionKey /LANG=1033 "ProductName" "Fusion Flix Clip Renamer & Sorter"
VIAddVersionKey /LANG=1033 "FileDescription" "Fusion Flix Clip Renamer & Sorter - remove this program"
VIAddVersionKey /LANG=1033 "CompanyName" "Fusion Flix (Dhruv Sharma)"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright (c) 2026 Fusion Flix (Dhruv Sharma)"

; Walk the "Apps & features" keys and drop the one that carries this program's
; display name - that way no GUID has to be hard coded in here.
!macro ffDropUninstallKey ROOT
  StrCpy $0 0
  StrCpy $3 0
  ffScan_${ROOT}:
    EnumRegKey $1 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" ffScanDone_${ROOT}
    StrCpy $2 ""
    ReadRegStr $2 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    StrCmp $2 "${FF_APPNAME}" 0 ffNext_${ROOT}
      DeleteRegKey ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1"
      Goto ffScan_${ROOT}
    ffNext_${ROOT}:
    IntOp $0 $0 + 1
    IntOp $3 $3 + 1
    IntCmp $3 400 ffScanDone_${ROOT} ffScan_${ROOT} ffScan_${ROOT}
  ffScanDone_${ROOT}:
!macroend

Section
  IfSilent ffStubGo
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Remove Fusion Flix Clip Renamer & Sorter and all of its files?$\r$\n$\r$\n\
     Your footage, your projects and your exported files are never touched." \
    /SD IDYES IDYES ffStubGo
  Abort

  ffStubGo:

  ; Shortcuts: Start Menu entry (and folder, should one be configured) plus
  ; the desktop shortcut.
  Delete "$SMPROGRAMS\${FF_APPNAME}.lnk"
  RMDir /r "$SMPROGRAMS\${FF_APPNAME}"
  Delete "$DESKTOP\${FF_APPNAME}.lnk"

  ; "Apps & features" entries.
  !insertmacro ffDropUninstallKey HKEY_CURRENT_USER
  !insertmacro ffDropUninstallKey HKLM

  ; Breadcrumb key written by packaging/installer.nsh.
  DeleteRegKey HKCU "Software\Fusion Flix\ClipRenamer"

  ; The program itself: the uninstaller always sits inside the install folder.
  RMDir /r "$EXEDIR"

  ; ...and finally the running executable (locked, so fall back to a delete on
  ; the next reboot if Windows refuses to remove it now).
  Delete "$EXEDIR\Uninstall ${FF_APPNAME}.exe"
  IfFileExists "$EXEDIR\Uninstall ${FF_APPNAME}.exe" 0 ffStubDone
    Delete /REBOOTOK "$EXEDIR\Uninstall ${FF_APPNAME}.exe"
  ffStubDone:
  RMDir "$EXEDIR"

  ; Refresh Explorer so the shortcuts vanish immediately.
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
SectionEnd
