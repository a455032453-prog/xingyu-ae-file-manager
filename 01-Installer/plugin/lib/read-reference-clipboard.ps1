# Read only the current clipboard; never replace or clear its contents.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $paths = @()
    if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
        foreach ($filePath in [System.Windows.Forms.Clipboard]::GetFileDropList()) {
            if ($filePath -match '\.(png|jpe?g|webp)$' -and (Test-Path -LiteralPath $filePath -PathType Leaf)) { $paths += [string]$filePath }
        }
    } elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) {
        $targetDir = $env:AFM_REFERENCE_CLIPBOARD_DIR
        if (!$targetDir -or !(Test-Path -LiteralPath $targetDir -PathType Container)) { throw 'Reference directory is unavailable' }
        $outPath = Join-Path $targetDir ('clipboard-' + [Guid]::NewGuid().ToString('N') + '.png')
        $bitmap = [System.Windows.Forms.Clipboard]::GetImage()
        try {
            if (!$bitmap -or ([long]$bitmap.Width * [long]$bitmap.Height) -gt 67108864) { throw 'Clipboard image exceeds 64 megapixels' }
            $bitmap.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
            $paths += $outPath
        } finally { if ($bitmap) { $bitmap.Dispose() } }
    } elseif ([System.Windows.Forms.Clipboard]::ContainsText()) {
        foreach ($line in ([System.Windows.Forms.Clipboard]::GetText() -split '\r?\n')) {
            $candidate = $line.Trim().Trim('"')
            if ($candidate -match '\.(png|jpe?g|webp)$' -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $paths += $candidate }
        }
    }
    [Console]::WriteLine((@{ ok = $true; paths = @($paths) } | ConvertTo-Json -Compress))
} catch {
    [Console]::WriteLine((@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
    exit 1
}
