# Builds the Voter Desk API and packages it for AWS Elastic Beanstalk (Node.js platform).
# Output: Backend/deploy/voter-desk-backend.zip  (upload it as a new application version)
#
#   powershell -ExecutionPolicy Bypass -File deploy/package-eb.ps1
$ErrorActionPreference = 'Stop'
$backend = Split-Path -Parent $PSScriptRoot
Set-Location $backend

npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
# Start from an empty dist so files removed from src are not shipped.
if (Test-Path dist) { Remove-Item -Recurse -Force dist }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'build failed' }

# Amazon RDS certificate bundle, so the API can verify the database's TLS certificate.
New-Item -ItemType Directory -Force certs | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem' -OutFile 'certs/rds-global-bundle.pem'

$stage = Join-Path $env:TEMP ("voterdesk-eb-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force $stage | Out-Null
foreach ($item in @('dist', 'migrations', 'certs', '.ebextensions', 'package.json', 'package-lock.json')) {
  Copy-Item -Recurse -Force $item (Join-Path $stage $item)
}

$zip = Join-Path $PSScriptRoot 'voter-desk-backend.zip'
if (Test-Path $zip) { Remove-Item -Force $zip }
# Windows tar.exe writes forward-slash paths, which Elastic Beanstalk (Linux) needs.
& "$env:SystemRoot\System32\tar.exe" -a -c -f $zip -C $stage dist migrations certs .ebextensions package.json package-lock.json
if ($LASTEXITCODE -ne 0) { throw 'zip failed' }
Remove-Item -Recurse -Force $stage
Write-Host "Created $zip"
