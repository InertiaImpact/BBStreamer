param([Parameter(Mandatory)][string]$NodePath, [Parameter(Mandatory)][string]$ApplicationPath, [int]$Port = 8085)

$ErrorActionPreference = 'Stop'
$arguments = '"{0}" --port {1}' -f $ApplicationPath, $Port
$controller = Start-Process -FilePath $NodePath -ArgumentList $arguments -WorkingDirectory (Split-Path -Parent $ApplicationPath) -WindowStyle Hidden -PassThru
$controller.WaitForExit()
exit $controller.ExitCode
