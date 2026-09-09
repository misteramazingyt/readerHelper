<#
.SYNOPSIS
    Registers the readerhelper:// protocol so the web app can open local PDFs.

.DESCRIPTION
    A page served from GitHub Pages cannot navigate to file:///C:/... — browsers
    block it. A custom protocol is the supported way across that boundary, and
    this registers one that hands the path to readerhelper_open.py, which opens
    it the same way Zotero Searcher does.

    Everything is written under HKCU, so no administrator rights are needed and
    nothing is changed for other users on the machine.

    After running this, set "Local PDF button opens" to "System PDF app" in the
    readerHelper Settings dialog.

.PARAMETER Uninstall
    Remove the registration.

.PARAMETER Test
    Register (if needed), then open a PDF to prove the chain works end to end.

.EXAMPLE
    .\install-protocol.ps1
    .\install-protocol.ps1 -Test "C:\Users\Shae\Zotero\storage\ABCD1234\paper.pdf"
    .\install-protocol.ps1 -Uninstall
#>

[CmdletBinding()]
param(
    [switch]$Uninstall,
    [string]$Test
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Scheme   = 'readerhelper'
$RegRoot  = "HKCU:\Software\Classes\$Scheme"
$Here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$Handler  = Join-Path $Here 'readerhelper_open.py'

function Write-Step($message) { Write-Host "  $message" -ForegroundColor Cyan }
function Write-Good($message) { Write-Host "  $message" -ForegroundColor Green }
function Write-Warn($message) { Write-Host "  $message" -ForegroundColor Yellow }

# ---------------------------------------------------------------- uninstall

if ($Uninstall) {
    if (Test-Path -LiteralPath $RegRoot) {
        Remove-Item -LiteralPath $RegRoot -Recurse -Force
        Write-Good "Removed $RegRoot"
    } else {
        Write-Warn "Nothing to remove - $Scheme:// was not registered."
    }
    Write-Host ''
    Write-Host 'Set "Local PDF button opens" back to Zotero in readerHelper Settings.'
    return
}

# ------------------------------------------------------------------ checks

Write-Host ''
Write-Host "Registering $Scheme:// for readerHelper" -ForegroundColor White
Write-Host ''

if (-not (Test-Path -LiteralPath $Handler)) {
    throw "readerhelper_open.py is missing. Expected it at: $Handler"
}

# pythonw.exe runs without a console window; python.exe would flash one open
# on every click, which is unpleasant when opening a PDF.
$pythonw = (Get-Command pythonw.exe -ErrorAction SilentlyContinue)
if ($null -eq $pythonw) {
    $python = (Get-Command python.exe -ErrorAction SilentlyContinue)
    if ($null -eq $python) {
        throw 'Neither pythonw.exe nor python.exe is on PATH. Install Python 3 from python.org and re-run.'
    }
    $exe = $python.Source
    Write-Warn 'pythonw.exe not found; falling back to python.exe (a console window may flash).'
} else {
    $exe = $pythonw.Source
}

Write-Step "Handler script : $Handler"
Write-Step "Interpreter    : $exe"

# ---------------------------------------------------------------- register

# Per the URL-protocol contract, the default value is a description and an
# empty "URL Protocol" value marks the key as a scheme handler.
$command = '"{0}" "{1}" "%1"' -f $exe, $Handler

New-Item -Path $RegRoot -Force | Out-Null
Set-ItemProperty -LiteralPath $RegRoot -Name '(Default)'   -Value "URL:$Scheme Protocol"
Set-ItemProperty -LiteralPath $RegRoot -Name 'URL Protocol' -Value ''

$iconPath = Join-Path (Split-Path -Parent $Here) 'icon.ico'
$zoteroIcon = 'C:\Program Files\Zotero Searcher\icon.ico'
if (Test-Path -LiteralPath $zoteroIcon) { $iconPath = $zoteroIcon }
if (Test-Path -LiteralPath $iconPath) {
    New-Item -Path "$RegRoot\DefaultIcon" -Force | Out-Null
    Set-ItemProperty -LiteralPath "$RegRoot\DefaultIcon" -Name '(Default)' -Value "$iconPath,0"
}

New-Item -Path "$RegRoot\shell\open\command" -Force | Out-Null
Set-ItemProperty -LiteralPath "$RegRoot\shell\open\command" -Name '(Default)' -Value $command

Write-Good "Registered $RegRoot"
Write-Step "Command        : $command"

# -------------------------------------------------------------------- test

if ($Test) {
    Write-Host ''
    if (-not (Test-Path -LiteralPath $Test)) {
        throw "Test file not found: $Test"
    }
    $encoded = [uri]::EscapeDataString((Resolve-Path -LiteralPath $Test).Path)
    $url = "${Scheme}://open?path=$encoded&page=1"
    Write-Step "Opening $url"
    Start-Process $url
    Write-Good 'If your PDF reader just opened, the chain works.'
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host ''
Write-Host 'Next:' -ForegroundColor White
Write-Host '  1. Open readerHelper and go to Settings.'
Write-Host '  2. Set "Local PDF button opens" to "System PDF app via readerhelper://".'
Write-Host '  3. The first click per browser session asks for permission - tick'
Write-Host '     "Always allow" so it stops asking.'
Write-Host ''
Write-Host 'Only existing .pdf files are ever opened; see the SAFETY note in'
Write-Host 'readerhelper_open.py, and ALLOWED_ROOTS there to restrict it further.'
Write-Host ''
