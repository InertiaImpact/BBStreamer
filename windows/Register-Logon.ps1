param([ValidateRange(1024, 65535)][int]$Port = 8085)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$main = Join-Path $root 'src\main.mjs'
$launcher = Join-Path $PSScriptRoot 'Start-BBStreamer.ps1'
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name

if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\mqtt\package.json'))) {
  throw 'Run Start.cmd once to install the dependencies before registering logon startup.'
}
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -NodePath "{1}" -ApplicationPath "{2}" -Port {3}' -f $launcher, $node, $main, $Port
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument $arguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 15 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'BBStreamer' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Start the local BambuBoard stream controller at Windows sign-in.' -Force | Out-Null
Write-Output "BBStreamer is registered for $account. It starts at the next sign-in. To start it now, close any foreground BBStreamer window and run Start-ScheduledTask -TaskName BBStreamer."
