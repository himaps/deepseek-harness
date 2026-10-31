; DeepSeek Harness CLI offline installer (Windows x64).
; Built by build-installer.ts, which defines STAGE (staging folder that contains the
; deepseek-harness payload tree), OUT (installer output path) and VERSION.
; The installer copies the self-contained payload into $PROGRAMFILES64\deepseek-harness,
; appends the folder to the machine PATH, and registers an uninstaller. It touches no
; system component beyond the PATH entry and its own directory.

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "x64.nsh"
!include "WinMessages.nsh"
!include "StrFunc.nsh"
; Global-scope calls with dummy arguments install the helpers; the sections below use them.
${StrContains} $R0 "" ""
${UnStrContains} $R0 "" ""
${StrContains}
${UnStrContains}

!define REG_PATH_KEY "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\deepseek-harness"

Name "DeepSeek Harness CLI"
OutFile "${OUT}"
InstallDir "$PROGRAMFILES64\deepseek-harness"
RequestExecutionLevel admin
ShowInstDetails show
ShowUninstDetails show

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "此安装包仅支持 64 位 Windows。$\nThis installer supports 64-bit Windows only."
    Abort
  ${EndIf}
FunctionEnd

; Broadcast the environment change so new processes see the PATH without a reboot.
Function BroadcastEnvironment
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\deepseek-harness\*.*"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ReadRegStr $R0 HKLM "${REG_PATH_KEY}" "Path"
  ${StrContains} $R1 "$INSTDIR" "$R0"
  StrCmp $R1 "" 0 path_done
  StrCpy $R0 "$R0;$INSTDIR"
  WriteRegExpandStr HKLM "${REG_PATH_KEY}" "Path" "$R0"
  Call BroadcastEnvironment
path_done:

  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayName" "DeepSeek Harness CLI"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "Publisher" "Hangzhou DeepSeek Artificial Intelligence Co., Ltd."
  WriteRegStr HKLM "${UNINSTALL_KEY}" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  ReadRegStr $R0 HKLM "${REG_PATH_KEY}" "Path"
  ${UnStrReplace} $R0 ";$INSTDIR" ""
  ${UnStrReplace} $R0 "$INSTDIR;" ""
  ${UnStrReplace} $R0 "$INSTDIR" ""
  WriteRegExpandStr HKLM "${REG_PATH_KEY}" "Path" "$R0"
  Call un.BroadcastEnvironment

  DeleteRegKey HKLM "${UNINSTALL_KEY}"
  RMDir /r "$INSTDIR"
SectionEnd

Function un.BroadcastEnvironment
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
FunctionEnd
