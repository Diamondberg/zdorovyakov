param([Parameter(Mandatory=$true)][string]$LiteralPath)
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $LiteralPath
$fsObject = New-Object -ComObject Scripting.FileSystemObject
if ($item.PSIsContainer) { $fsObject.GetFolder($item.FullName).ShortPath }
else { $fsObject.GetFile($item.FullName).ShortPath }
