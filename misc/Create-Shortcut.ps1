# Creates / refreshes the "DevWebUI" shortcut in the project root, pointing at
# the shared misc\Tray-Launch.vbs and carrying the icon. Re-run after moving/renaming
# the folder (.lnk files store ABSOLUTE paths) or after regenerating the icon.
#
# THIN ADAPTER over the shared LunarWerx tray shortcut engine — this file just supplies
# DevWebUI's own name / icon / description; the actual .lnk-building logic lives in
# New-TrayShortcut.ps1 (kit-synced, DO NOT EDIT).
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition   # ...\misc
$root = Split-Path -Parent $scriptDir

. (Join-Path $scriptDir "New-TrayShortcut.ps1")

New-TrayShortcut `
  -Root $root `
  -ScriptDir $scriptDir `
  -LnkName "DevWebUI" `
  -IconFile "DevWebUI.ico" `
  -Description "Launch DevWebUI (system tray)"
