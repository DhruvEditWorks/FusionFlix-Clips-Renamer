Var newStartMenuLink
Var oldStartMenuLink
Var newDesktopLink
Var oldDesktopLink
Var oldShortcutName
Var oldMenuDirectory

# ---------------------------------------------------------------------------
# FUSION FLIX - CLIP RENAMER & SORTER : custom NSIS installer script
#
# This is electron-builder's stock installer.nsi plus one deliberate change,
# so the Windows installer can be cross-built on Linux/macOS with NO wine.
#
# Why: electron-builder normally builds the uninstaller by compiling this very
# script with -DBUILD_UNINSTALLER and then *executing* the freshly built
# installer.  Running a Windows .exe requires wine, and a container without a
# working wine aborts the whole build at the last step.
#
# Instead the installer now writes its own uninstaller at install time with
# NSIS' WriteUninstaller (see the customInstall macro in
# packaging/installer.nsh) - the classic hand written NSIS pattern:
#
#   * Section "un.install" below is the real uninstaller code
#     (the stock templates/nsis/uninstaller.nsh, always included now), and
#   * the stock template still drops a small placeholder at
#     $INSTDIR\${UNINSTALL_FILENAME} (the File command in
#     include/installer.nsh), which WriteUninstaller overwrites with the real
#     thing a moment later.  The placeholder is only there to satisfy the
#     stock template; it is never executed.
#
# The outcome on the user's machine is identical: Add/Remove programs points
# at $INSTDIR\Uninstall Fusion Flix Clip Renamer & Sorter.exe, which removes
# the app, its shortcuts and its registry entries.
# ---------------------------------------------------------------------------

# Point the stock template's placeholder File command at a small stub that
# ships in ./packaging.  (electron-builder passes a bare -DUNINSTALLER_OUT_FILE
# when a custom script is used, so drop that first.)
!ifdef UNINSTALLER_OUT_FILE
  !undef UNINSTALLER_OUT_FILE
!endif
# (electron-builder feeds this script to makensis on stdin, so ${__FILEDIR__}
#  is just "." here - the build resources folder is the reliable anchor.)
!define UNINSTALLER_OUT_FILE "${BUILD_RESOURCES_DIR}\uninstaller-stub.exe"

# ---------------------------------------------------------------------------
# Uninstaller-safe "is the app running?" check.
#
# The stock template ({GetProcessInfo}) calls a helper function whose name
# flips between _GetProcessInfo (installer) and un._GetProcessInfo (uninstaller)
# depending on BUILD_UNINSTALLER.  In this script the installer *and* the
# uninstaller code are compiled together, so NSIS would reject the installer
# flavour of that Call inside the un.install section.
#
# electron-builder provides a hook for exactly this: the CHECK_APP_RUNNING
# macro uses customCheckAppRunning when it exists (and then skips the
# getProcessInfo include altogether).  This implementation uses only plugins,
# no function calls, so it is valid in both contexts, and behaves like the
# stock one: prompt once, close the running app, wait for it to disappear.
# ---------------------------------------------------------------------------
!include LogicLib.nsh

!macro FF_FIND_APP_PROCESS _ERR
  nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO csv | "$SYSDIR\find.exe" "${APP_EXECUTABLE_FILENAME}"`
  Pop ${_ERR}
!macroend

!macro customCheckAppRunning
  !insertmacro FF_FIND_APP_PROCESS $R0
  ${If} $R0 == 0
    ${If} ${isUpdated}
      # an update: give the app a moment to exit on its own first
      Sleep 1000
      Goto ffCloseApp
    ${EndIf}

    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK ffCloseApp
    Quit

    ffCloseApp:
    DetailPrint `Closing running "${PRODUCT_NAME}"...`
    nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /im "${APP_EXECUTABLE_FILENAME}" /fi "USERNAME eq %USERNAME%"`
    Sleep 300

    StrCpy $R1 0
    ffWaitLoop:
      IntOp $R1 $R1 + 1
      !insertmacro FF_FIND_APP_PROCESS $R0
      ${If} $R0 == 0
        # still there: ask again, harder
        nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /fi "USERNAME eq %USERNAME%"`
        Sleep 500
        !insertmacro FF_FIND_APP_PROCESS $R0
        ${If} $R0 == 0
          IntCmp $R1 20 ffGiveUp ffWaitLoop ffGiveUp
          ffGiveUp:
            DetailPrint `Could not close "${PRODUCT_NAME}".`
            MessageBox MB_OK|MB_ICONSTOP "$(appCannotBeClosed)"
            Quit
        ${EndIf}
      ${EndIf}
  ${EndIf}
!macroend

!include "common.nsh"
!include "MUI2.nsh"
!include "multiUser.nsh"
!include "allowOnlyOneInstallerInstance.nsh"

!ifdef INSTALL_MODE_PER_ALL_USERS
  !ifdef BUILD_UNINSTALLER
    RequestExecutionLevel user
  !else
    RequestExecutionLevel admin
  !endif
!else
  RequestExecutionLevel user
!endif

!ifdef BUILD_UNINSTALLER
  SilentInstall silent
!else
  Var appExe
  Var launchLink
!endif

!ifdef ONE_CLICK
  !include "oneClick.nsh"
!else
  !include "assistedInstaller.nsh"
!endif

!insertmacro addLangs

!ifmacrodef customHeader
  !insertmacro customHeader
!endif

Function .onInit
  Call setInstallSectionSpaceRequired

  SetOutPath $INSTDIR
  ${LogSet} on

  !ifmacrodef preInit
    !insertmacro preInit
  !endif

  !ifdef DISPLAY_LANG_SELECTOR
    !insertmacro MUI_LANGDLL_DISPLAY
  !endif

  !ifdef BUILD_UNINSTALLER
    WriteUninstaller "${UNINSTALLER_OUT_FILE}"
    !insertmacro quitSuccess
  !else
    !insertmacro check64BitAndSetRegView

    !ifdef ONE_CLICK
      !insertmacro ALLOW_ONLY_ONE_INSTALLER_INSTANCE
    !else
      ${IfNot} ${UAC_IsInnerInstance}
        !insertmacro ALLOW_ONLY_ONE_INSTALLER_INSTANCE
      ${EndIf}
    !endif

    !insertmacro initMultiUser

    !ifmacrodef customInit
      !insertmacro customInit
    !endif

    !ifmacrodef addLicenseFiles
      InitPluginsDir
      !insertmacro addLicenseFiles
    !endif
  !endif
FunctionEnd

!ifndef BUILD_UNINSTALLER
  !include "installUtil.nsh"
!endif

Section "install" INSTALL_SECTION_ID
  !ifndef BUILD_UNINSTALLER
    # If we're running a silent upgrade of a per-machine installation, elevate so extracting the new app will succeed.
    # For a non-silent install, the elevation will be triggered when the install mode is selected in the UI,
    # but that won't be executed when silent.
    !ifndef INSTALL_MODE_PER_ALL_USERS
      !ifndef ONE_CLICK
          ${if} $hasPerMachineInstallation == "1" # set in onInit by initMultiUser
          ${andIf} ${Silent}
            ${ifNot} ${UAC_IsAdmin}
              ShowWindow $HWNDPARENT ${SW_HIDE}
              !insertmacro UAC_RunElevated
              ${Switch} $0
                ${Case} 0
                  ${Break}
                ${Case} 1223 ;user aborted
                  ${Break}
                ${Default}
                  MessageBox mb_IconStop|mb_TopMost|mb_SetForeground "Unable to elevate, error $0"
                  ${Break}
              ${EndSwitch}
              Quit
            ${else}
              !insertmacro setInstallModePerAllUsers
            ${endIf}
          ${endIf}
      !endif
    !endif
    !include "installSection.nsh"
  !endif
SectionEnd

Function setInstallSectionSpaceRequired
  !insertmacro setSpaceRequired ${INSTALL_SECTION_ID}
FunctionEnd

# This build never runs in BUILD_UNINSTALLER mode: the uninstaller code has to
# live inside the installer so WriteUninstaller can emit it at install time.
# (The stock `!ifdef BUILD_UNINSTALLER` wrapper around this include is dropped
# on purpose - see the header comment above.)
!include "uninstaller.nsh"
