# Package an already Authenticode-signed installer using the maintainer's trusted Windows signer.
# Refuses unsigned, untrusted or un-timestamped inputs; never accesses a signing key.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$InputDirectory, [Parameter(Mandatory)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$name = 'cloudssh-rdp-connector-windows-amd64'
$exe = Join-Path $InputDirectory "$name.exe"
$licenses = Join-Path $InputDirectory 'LICENSES.txt'
if (!(Test-Path -PathType Leaf -LiteralPath $licenses)) { throw 'Missing license notices' }
$signature = Get-AuthenticodeSignature -LiteralPath $exe
if ($signature.Status -ne 'Valid' -or !$signature.SignerCertificate -or !$signature.TimeStamperCertificate) {
    throw 'A trusted, timestamped Authenticode signature is required before packaging'
}
$out = (New-Item -Path $OutputDirectory -ItemType Directory -Force).FullName
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("cloudssh-connector-" + [Guid]::NewGuid().ToString('N'))
$null = New-Item -Path $tmp -ItemType Directory
try {
    $target = Join-Path $tmp "$name.exe"
    Copy-Item -LiteralPath $exe -Destination $target
    Copy-Item -LiteralPath $licenses -Destination $tmp
    $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $tmp 'SHA256SUMS'), "$hash  $name.exe`n")
    Compress-Archive -Path (Join-Path $tmp '*') -DestinationPath (Join-Path $out "$name.zip")
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force
}
$packageHash = (Get-FileHash -LiteralPath (Join-Path $out "$name.zip") -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $out 'SHA256SUMS'), "$packageHash  $name.zip`n")
Write-Host "Verified package ready for an explicit maintainer release in $out"
