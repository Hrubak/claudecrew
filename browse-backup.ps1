# ZIP file picker for Restore / Import backup. Invoked only via setup-wizard.js or Settings.
param([string]$Title = 'Choose a Claude Crew backup zip')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Title = $Title
$dlg.Filter = 'Crew backup (*.zip)|*.zip|All files (*.*)|*.*'
$dlg.Multiselect = $false
$dlg.CheckFileExists = $true
if ($env:USERPROFILE) { $dlg.InitialDirectory = $env:USERPROFILE }
$r = $dlg.ShowDialog()
if ($r -eq [System.Windows.Forms.DialogResult]::OK -and $dlg.FileName) {
  [Console]::Out.Write($dlg.FileName)
  exit 0
}
exit 1
