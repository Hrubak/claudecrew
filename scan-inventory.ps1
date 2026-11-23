# Read-only inventory of processes, shortcuts, scheduled tasks, and Run/RunOnce keys.
# Changes nothing: no Stop-Process, no Remove-Item, no registry writes, no schtasks change.
param()
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

function Get-ShortcutInfo($file) {
  try {
    $sh = New-Object -ComObject WScript.Shell
    $lnk = $sh.CreateShortcut($file.FullName)
    return [ordered]@{
      path = $file.FullName
      target = [string]$lnk.TargetPath
      args = [string]$lnk.Arguments
      workdir = [string]$lnk.WorkingDirectory
      location = $file.DirectoryName
    }
  } catch {
    return [ordered]@{ path = $file.FullName; target = ''; args = ''; workdir = ''; location = $file.DirectoryName; error = $_.Exception.Message }
  }
}

$names = @('node.exe','node','powershell.exe','powershell','pwsh.exe','pwsh','conhost.exe','conhost','cmd.exe','cmd')
$processes = @()
$runningPids = @()
Get-CimInstance Win32_Process | ForEach-Object {
  $runningPids += [int]$_.ProcessId
  if ($names -contains $_.Name) {
    $processes += [ordered]@{
      pid = [int]$_.ProcessId
      parentPid = [int]$_.ParentProcessId
      name = [string]$_.Name
      executablePath = [string]$_.ExecutablePath
      commandLine = [string]$_.CommandLine
    }
  }
}

$listeners = @()
try {
  Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    $listeners += [ordered]@{
      port = [int]$_.LocalPort
      address = [string]$_.LocalAddress
      pid = [int]$_.OwningProcess
    }
  }
} catch { }

$roots = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  [Environment]::GetFolderPath('Startup'),
  [Environment]::GetFolderPath('CommonStartup'),
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
) | Where-Object { $_ -and (Test-Path $_) }

$shortcuts = @()
foreach ($root in $roots) {
  Get-ChildItem -LiteralPath $root -Filter '*.lnk' -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
    $shortcuts += Get-ShortcutInfo $_
  }
}

$tasks = @()
Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object {
  $acts = @()
  foreach ($a in @($_.Actions)) {
    $acts += [ordered]@{ execute = [string]$a.Execute; arguments = [string]$a.Arguments; workingDirectory = [string]$a.WorkingDirectory }
  }
  $tasks += [ordered]@{ name = [string]$_.TaskName; path = [string]$_.TaskPath; actions = $acts }
}

function Read-RunKey($hive, $sub) {
  $out = @()
  $p = $hive + ':\' + $sub
  try {
    $item = Get-Item -LiteralPath $p -ErrorAction Stop
    foreach ($n in $item.GetValueNames()) {
      $out += [ordered]@{ hive = $hive; key = $sub; name = [string]$n; data = [string]$item.GetValue($n) }
    }
  } catch { }
  return $out
}

$runKeys = @()
$runKeys += Read-RunKey 'HKCU' 'Software\Microsoft\Windows\CurrentVersion\Run'
$runKeys += Read-RunKey 'HKCU' 'Software\Microsoft\Windows\CurrentVersion\RunOnce'
# HKLM is a read-only check. This script never writes.
$runKeys += Read-RunKey 'HKLM' 'Software\Microsoft\Windows\CurrentVersion\Run'
$runKeys += Read-RunKey 'HKLM' 'Software\Microsoft\Windows\CurrentVersion\RunOnce'
$runKeys += Read-RunKey 'HKLM' 'Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run'
$runKeys += Read-RunKey 'HKLM' 'Software\WOW6432Node\Microsoft\Windows\CurrentVersion\RunOnce'

[ordered]@{
  processes = $processes
  listeners = $listeners
  runningPids = $runningPids
  shortcuts = $shortcuts
  tasks = $tasks
  runKeys = $runKeys
  readOnly = $true
} | ConvertTo-Json -Depth 6 -Compress
