# Prompts for the Squarespace API key and saves it to the project's .env file.
# The key is typed in masked, so it never appears on screen or in shell history.
#
# Usage (from the project root):
#   powershell -ExecutionPolicy Bypass -File .\scripts\set-squarespace-key.ps1

[CmdletBinding()]
param(
    [string]$EnvPath,
    [string]$VariableName = 'SQUARESPACE_API_KEY'
)

$ErrorActionPreference = 'Stop'

# Resolved here, not in the param block: $PSScriptRoot can be empty in parameter defaults.
if (-not $EnvPath) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $EnvPath = Join-Path $scriptDir '..\.env'
}

$secure = Read-Host -AsSecureString "Paste your Squarespace API key"
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $key = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim()
} finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if ([string]::IsNullOrWhiteSpace($key)) {
    throw 'No key entered. Nothing was saved.'
}
if ($key -match '[\r\n]') {
    throw 'The key contains line breaks. Nothing was saved.'
}

$envFile = [System.IO.Path]::GetFullPath($EnvPath)
$newLine = "$VariableName=$key"

# Keep every other line in .env; replace only the existing line for this variable.
$lines = @()
if (Test-Path $envFile) {
    $lines = @(Get-Content -Path $envFile | Where-Object { $_ -notmatch "^\s*$([regex]::Escape($VariableName))\s*=" })
}
$lines += $newLine

[System.IO.File]::WriteAllLines($envFile, $lines, (New-Object System.Text.UTF8Encoding $false))

# Limit read access to the current Windows user.
icacls $envFile /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null

$key = $null
$newLine = $null

Write-Host "Saved $VariableName to $envFile"
