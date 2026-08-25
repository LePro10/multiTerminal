# Installs multiTerminal on Windows: installs npm dependencies and creates
# Start Menu and Desktop shortcuts so the app launches like any other program.
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# Pass -NoDesktop to skip the desktop shortcut.

param(
    [switch]$NoDesktop
)

$ErrorActionPreference = 'Stop'

$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ElectronExe = Join-Path $AppDir 'node_modules\electron\dist\electron.exe'
$IconPath = Join-Path $AppDir 'build\icon.png'

Write-Host '==> Installing npm dependencies'
Push-Location $AppDir
try {
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

if (-not (Test-Path $ElectronExe)) {
    throw "electron.exe not found at $ElectronExe after npm install"
}

# Windows shortcuts want an .ico; generate one from the PNG if it isn't there
# already. Falls back to the Electron binary's own icon when that fails.
$IcoPath = Join-Path $AppDir 'build\icon.ico'
if (-not (Test-Path $IcoPath) -and (Test-Path $IconPath)) {
    try {
        Add-Type -AssemblyName System.Drawing
        $bitmap = [System.Drawing.Bitmap]::FromFile($IconPath)
        $handle = $bitmap.GetHicon()
        $icon = [System.Drawing.Icon]::FromHandle($handle)
        $stream = [System.IO.File]::Create($IcoPath)
        $icon.Save($stream)
        $stream.Close()
        $icon.Dispose()
        $bitmap.Dispose()
    } catch {
        Write-Warning "Could not convert the icon, using the default: $_"
    }
}
$ShortcutIcon = if (Test-Path $IcoPath) { $IcoPath } else { $ElectronExe }

function New-MultiTerminalShortcut {
    param([string]$Path)

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $ElectronExe
    $shortcut.Arguments = "`"$AppDir`""
    $shortcut.WorkingDirectory = $AppDir
    $shortcut.IconLocation = $ShortcutIcon
    $shortcut.Description = 'Grid of real terminals with templates and broadcast input'
    $shortcut.Save()
    Write-Host "    $Path"
}

Write-Host '==> Creating shortcuts'
$StartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
New-Item -ItemType Directory -Force -Path $StartMenu | Out-Null
New-MultiTerminalShortcut (Join-Path $StartMenu 'multiTerminal.lnk')

if (-not $NoDesktop) {
    New-MultiTerminalShortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'multiTerminal.lnk')
}

Write-Host ''
Write-Host '==> Done'
Write-Host 'multiTerminal is in your Start Menu. Right-click it there and choose'
Write-Host '"Pin to Start" or "Pin to taskbar" to keep it handy.'
Write-Host ''
Write-Host "Run it any time with: npm start (from $AppDir)"
