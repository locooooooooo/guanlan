; F03 · 观澜（Guanlan）Windows NSIS 安装器扩展钩子
; 职责：
; 1. 安装完成后为当前用户（HKCU，免 UAC 管理员提权）注册资源管理器文件夹右键菜单
;    「用观澜打开此文件夹」（支持选中目录右键 & 目录空白处右键）；
; 2. 卸载时彻底清理所有 HKCU 注册表项，不留任何系统垃圾残余。

!macro NSIS_HOOK_POSTINSTALL
  ; 1) 文件夹对象右键菜单：HKCU\Software\Classes\Directory\shell\GuanlanOpen
  WriteRegStr HKCU "Software\Classes\Directory\shell\GuanlanOpen" "" "用观澜打开此文件夹"
  WriteRegStr HKCU "Software\Classes\Directory\shell\GuanlanOpen" "Icon" "$INSTDIR\guanlan-desktop.exe,0"
  WriteRegStr HKCU "Software\Classes\Directory\shell\GuanlanOpen\command" "" '"$INSTDIR\guanlan-desktop.exe" --open "%1"'

  ; 2) 文件夹空白处右键菜单：HKCU\Software\Classes\Directory\Background\shell\GuanlanOpen
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\GuanlanOpen" "" "用观澜打开此文件夹"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\GuanlanOpen" "Icon" "$INSTDIR\guanlan-desktop.exe,0"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\GuanlanOpen\command" "" '"$INSTDIR\guanlan-desktop.exe" --open "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\GuanlanOpen"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\GuanlanOpen"
!macroend
