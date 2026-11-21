# Native folder picker for the setup wizard. Invoked only via setup-wizard.js
# with an argv list (no powershell -Command string). Requires -STA.
#   powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File browse-folder.ps1 [-SelectedPath <path>]
# On OK, writes the chosen path to stdout and exits 0. On cancel, exits 1.
param([string]$SelectedPath = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles() | Out-Null
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose a folder for Claude Crew'
$dialog.ShowNewFolderButton = $true
if ($SelectedPath) {
  try {
    if (Test-Path -LiteralPath $SelectedPath -PathType Container) {
      $dialog.SelectedPath = (Resolve-Path -LiteralPath $SelectedPath).Path
    }
  } catch { }
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {
  [Console]::Out.WriteLine($dialog.SelectedPath)
  exit 0
}
exit 1
