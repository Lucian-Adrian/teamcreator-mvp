$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot

$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) {
  Write-Host 'Node.js and npm are required. Install them, reopen this launcher, and try again.' -ForegroundColor Yellow
  exit 1
}
Write-Host "Node.js: $(& $node.Source --version)"

$codex = Get-Command codex -ErrorAction SilentlyContinue
if ($codex) {
  Write-Host 'Codex CLI: installed. Provider sign-in and model availability are checked by the app.'
} else {
  Write-Host 'Codex CLI: not found. The app can open, but it will record sources without proposing extracted records.' -ForegroundColor Yellow
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
  Write-Host 'Installing project dependencies…'
  Push-Location $projectRoot
  try { & $npm.Source install } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed. See the output above.' }
}

$busyPorts = @(3001) | Where-Object {
  @(Get-NetTCPConnection -LocalPort $_ -State Listen -ErrorAction SilentlyContinue).Count -gt 0
}
if ($busyPorts.Count) {
  Write-Host "Port(s) $($busyPorts -join ', ') are already in use. Stop the matching app yourself, then run this launcher again." -ForegroundColor Yellow
  exit 1
}

Write-Host 'Building the local app…'
Push-Location $projectRoot
try { & $npm.Source run build } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'The app build failed. See the output above.' }

Write-Host 'Starting the local app in a visible terminal…'
$server = Start-Process -FilePath $env:ComSpec -ArgumentList @('/k', 'npm start') -WorkingDirectory $projectRoot -PassThru -WindowStyle Normal
$healthUrl = 'http://127.0.0.1:3001/api/health'
$deadline = [DateTime]::UtcNow.AddSeconds(90)
$health = $null
while ([DateTime]::UtcNow -lt $deadline) {
  if ($server.HasExited) { break }
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
    if ($health.status -eq 'ok' -and $health.api -eq 'ready') { break }
  } catch { }
  Start-Sleep -Seconds 1
}

if (-not $health -or $health.status -ne 'ok' -or $health.api -ne 'ready') {
  Write-Host 'The local API did not become ready. Check the visible server terminal for errors.' -ForegroundColor Red
  Write-Host 'If another app is using port 3001, stop it and run this launcher again.'
  exit 1
}

$provider = $health.provider
if ($provider) {
  Write-Host "Extraction mode: $($provider.mode) ($($provider.provider)); $($provider.message)"
  Write-Host 'A successful model-backed extraction is verified per request, not by CLI presence alone.'
}
Start-Process 'http://localhost:3001'
Write-Host 'TeamCreator is open at http://localhost:3001. Stop the app with Ctrl+C in the server terminal.' -ForegroundColor Green
