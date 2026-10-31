; DeepSeek Harness CLI offline installer (Windows x64).
; Built by build-installer.ts, which defines STAGE (staging folder that contains the
; deepseek-harness payload tree), OUT (installer output path) and VERSION.
; The installer copies the self-contained payload into $PROGRAMFILES64\deepseek-harness,
; appends the folder to the machine PATH, and registers an uninstaller. It touches no
; system component beyond the PATH entry and its own directory. PATH matching is
; hand-rolled on NSIS core primitives (StrCpy/StrLen/IntCmp) — no string-library
; plugins or includes.

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "x64.nsh"
!include "WinMessages.nsh"

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

; $R0 haystack, $R1 needle -> $R2 zero-based offset of the first occurrence, or -1.
; Preserves $R0 and $R1.
Function FindSubstring
  StrCpy $R2 -1
  StrLen $R3 $R1
  IntCmp $R3 0 find_done
  StrLen $R4 $R0
  StrCpy $R5 0
find_loop:
  IntCmp $R5 $R4 find_done
  StrCpy $R6 $R0 $R3 $R5
  StrCmp $R6 $R1 find_found
  IntOp $R5 $R5 + 1
  Goto find_loop
find_found:
  StrCpy $R2 $R5
find_done:
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\deepseek-harness\*.*"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ReadRegStr $R0 HKLM "${REG_PATH_KEY}" "Path"
  StrCpy $R1 "$INSTDIR"
  Call FindSubstring
  IntCmp $R2 -1 0 path_done
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

; $R0 text in place, $R1 needle — removes every occurrence of the needle. Preserves $R1.
Function un.RemoveSubstring
  StrLen $R3 $R1
  IntCmp $R3 0 remove_done
remove_loop:
  StrLen $R4 $R0
  IntCmp $R4 $R3 remove_done
  StrCpy $R5 0
remove_scan:
  IntCmp $R5 $R4 remove_done
  StrCpy $R6 $R0 $R3 $R5
  StrCmp $R6 $R1 remove_splice
  IntOp $R5 $R5 + 1
  Goto remove_scan
remove_splice:
  StrCpy $R7 $R0 $R5
  IntOp $R8 $R5 + $R3
  StrCpy $R9 $R0 "" $R8
  StrCpy $R0 "$R7$R9"
  Goto remove_loop
remove_done:
FunctionEnd

Section "Uninstall"
  ReadRegStr $R0 HKLM "${REG_PATH_KEY}" "Path"
  ; Delimit both ends so whole-entry matching works, remove ";$INSTDIR;" occurrences,
  ; then strip the synthetic delimiters again.
  StrCpy $R0 ";$R0;"
  StrCpy $R1 ";$INSTDIR;"
  Call un.RemoveSubstring
  StrLen $R4 $R0
  IntCmp $R4 2 strip_done
  IntOp $R4 $R4 - 2
  StrCpy $R0 $R0 $R4 1
strip_done:
  WriteRegExpandStr HKLM "${REG_PATH_KEY}" "Path" "$R0"
  Call un.BroadcastEnvironment

  DeleteRegKey HKLM "${UNINSTALL_KEY}"
  RMDir /r "$INSTDIR"
SectionEnd

Function un.BroadcastEnvironment
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
FunctionEnd
