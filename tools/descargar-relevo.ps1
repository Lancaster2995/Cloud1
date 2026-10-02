# Descarga Relevo (Windows, iPhone, Android y codigo fuente) a una carpeta local.
# Uso: abre PowerShell y ejecuta este archivo, o pega su contenido.
#   powershell -ExecutionPolicy Bypass -File descargar-relevo.ps1
#   powershell -ExecutionPolicy Bypass -File descargar-relevo.ps1 -Destino "D:\Otra carpeta"
param(
    [string]$Destino = 'C:\Users\USAURIO\Desktop\Claude Core'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'   # mucho mas rapido en PowerShell 5.1

$repo = 'https://github.com/Lancaster2995/Cloud1'
$rama = 'claude/affectionate-cerf-ayb5xv'
$archivos = [ordered]@{
    'Relevo-Setup-1.2.2.exe'    = "$repo/releases/download/windows-v1.2.2/Relevo-Setup-1.2.2.exe"
    'Relevo-1.2.2-portable.exe' = "$repo/releases/download/windows-v1.2.2/Relevo-1.2.2-portable.exe"
    'Relevo-iPhone.ipa'         = "$repo/releases/download/ios-v1.1.0/Relevo.ipa"
    'Relevo-Android.apk'        = "$repo/releases/download/v1.1.0/Relevo.apk"
    'Relevo-codigo-fuente.zip'  = "$repo/archive/refs/heads/$rama.zip"
    'LEEME.md'                  = "https://raw.githubusercontent.com/Lancaster2995/Cloud1/$rama/README.md"
}

New-Item -ItemType Directory -Force -Path $Destino | Out-Null
foreach ($nombre in $archivos.Keys) {
    $salida = Join-Path $Destino $nombre
    Write-Host "Descargando $nombre ..."
    Invoke-WebRequest -Uri $archivos[$nombre] -OutFile $salida -UseBasicParsing
}
Write-Host ""
Write-Host "Listo. Archivos en: $Destino"
Write-Host "Para instalar en Windows ejecuta Relevo-Setup-1.2.2.exe"
Start-Process explorer.exe $Destino
