$siteRoot = Split-Path -Parent $PSScriptRoot
$env:PATH = (Join-Path $siteRoot '.sites-runtime\npm-bin') + ';' + $env:PATH
$env:npm_config_cache = Join-Path $siteRoot '.sites-runtime\npm-cache'
$env:TEMP = Join-Path $siteRoot '.sites-runtime\tmp'
$env:TMP = $env:TEMP
