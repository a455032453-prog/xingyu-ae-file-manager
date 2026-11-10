param([ValidateSet('protect','unprotect')][string]$Mode)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::InputEncoding = $encoding
  [Console]::OutputEncoding = $encoding
  $inputText = [Console]::In.ReadToEnd()
  if ($Mode -eq 'protect') {
    $protected = [Security.Cryptography.ProtectedData]::Protect($encoding.GetBytes($inputText), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Convert]::ToBase64String($protected))
  } else {
    $plain = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($inputText.Trim()), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write($encoding.GetString($plain))
  }
} catch {
  [Console]::Error.Write('AI credential protection failed for the current Windows user.')
  exit 1
}
