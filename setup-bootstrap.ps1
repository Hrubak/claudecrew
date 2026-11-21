# Ensures Node.js 20+ is available so setup.cmd can start the wizard.
# No administrator rights. Safe to run again. Does not install Crew itself.
$ErrorActionPreference = 'Stop'
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + (Join-Path $env:USERPROFILE '.local\bin')
  $rt = Join-Path $PSScriptRoot 'runtime\node'
  if (Test-Path (Join-Path $rt 'node.exe')) { $env:Path = "$rt;$env:Path" }
}
function Node-Ok {
  if (-not (Have node)) { return $false }
  try { return ([int]((node --version) -replace '^v(\d+).*', '$1')) -ge 20 } catch { return $false }
}
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
Refresh-Path
if (Node-Ok) { Write-Host "Node $(node --version) is ready."; exit 0 }
if (Have winget) {
  Write-Host 'Installing Node.js LTS with winget...'
  try { winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements | Out-Null } catch { }
  Refresh-Path
}
if (-not (Node-Ok)) {
  Write-Host 'Downloading a private copy of Node.js into runtime\node (no administrator needed)...'
  try {
    $idx = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $rel = $idx | Where-Object { $_.lts -and ($_.files -contains "win-$arch-zip") } | Select-Object -First 1
    $zip = Join-Path $env:TEMP 'crew-node.zip'; $tmp = Join-Path $env:TEMP 'crew-node-x'
    Invoke-WebRequest "https://nodejs.org/dist/$($rel.version)/node-$($rel.version)-win-$arch.zip" -OutFile $zip -UseBasicParsing
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive $zip $tmp -Force
    $rt = Join-Path $PSScriptRoot 'runtime'; New-Item -ItemType Directory -Force $rt | Out-Null
    if (Test-Path (Join-Path $rt 'node')) { Remove-Item (Join-Path $rt 'node') -Recurse -Force }
    Move-Item (Get-ChildItem $tmp | Select-Object -First 1).FullName (Join-Path $rt 'node')
    Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Refresh-Path
  } catch { Write-Host "Could not download Node.js automatically: $($_.Exception.Message)" }
}
if (-not (Node-Ok)) {
  Write-Host 'Please install Node.js 20 or newer: a browser will open at https://nodejs.org — click the LTS button, accept the defaults, then press Enter here.'
  Start-Process 'https://nodejs.org'
  Read-Host 'When Node.js has finished installing, press Enter'
  Refresh-Path
}
if (Node-Ok) { Write-Host "Node $(node --version) is ready."; exit 0 }
Write-Host 'Node.js 20 or newer is still missing. Install it from https://nodejs.org (the LTS button), then double-click setup.cmd again.'
exit 1
