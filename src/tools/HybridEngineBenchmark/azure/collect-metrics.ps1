<#
.SYNOPSIS
Saves Azure Monitor metrics for App Service sites and plans over a time window.

.DESCRIPTION
Calls the metrics REST API with "az account get-access-token --tenant <tenant>", one request per resource and metric
group, and writes one JSON file: { start, end, interval, series: [{ site, metric, aggregation, instance, points }] }.
Plan metrics are split by instance, so each instance of a scaled-out plan has its own series.

Metrics are platform metrics with a one-minute grain at best, and they arrive a few minutes late, so collect them
about five minutes after the load ends.

.EXAMPLE
.\collect-metrics.ps1 -TenantId $tenant -Start (Get-Date).AddHours(-1).ToUniversalTime() -OutFile metrics-sweep.json `
  -Resources @{ node = $nodeSiteId; node_plan = $nodePlanId; jint = $jintSiteId; jint_plan = $jintPlanId }
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $TenantId,
    [Parameter(Mandatory)] [hashtable] $Resources,
    [Parameter(Mandatory)] [datetime] $Start,
    [datetime] $End = (Get-Date).ToUniversalTime(),
    [string] $Interval = 'PT1M',
    [Parameter(Mandatory)] [string] $OutFile
)

$ErrorActionPreference = 'Stop'

function Get-Headers {
    $token = az account get-access-token --tenant $TenantId --resource https://management.azure.com/ --query accessToken -o tsv
    if (-not $token) { throw 'No access token. Sign in with az login.' }
    @{ Authorization = "Bearer $token" }
}

$siteMetrics = @(
    @{ names = 'Requests,Http5xx,Http4xx'; aggregation = 'Total' }
    @{ names = 'HttpResponseTime,AverageMemoryWorkingSet'; aggregation = 'Average' }
    @{ names = 'MemoryWorkingSet'; aggregation = 'Maximum' }
)
$planMetrics = @(
    @{ names = 'CpuPercentage,MemoryPercentage,HttpQueueLength'; aggregation = 'Average' }
    @{ names = 'CpuPercentage,MemoryPercentage'; aggregation = 'Maximum' }
)

$span = '{0:yyyy-MM-ddTHH:mm:ssZ}/{1:yyyy-MM-ddTHH:mm:ssZ}' -f $Start.ToUniversalTime(), $End.ToUniversalTime()
$series = New-Object System.Collections.Generic.List[object]

foreach ($label in $Resources.Keys) {
    $id = $Resources[$label]
    $isPlan = $id -match '/serverfarms/'
    foreach ($group in $(if ($isPlan) { $planMetrics } else { $siteMetrics })) {
        $filter = if ($isPlan) { '&$filter=' + [uri]::EscapeDataString("Instance eq '*'") } else { '' }
        $uri = "https://management.azure.com$id/providers/Microsoft.Insights/metrics?api-version=2018-01-01" +
            "&metricnames=$($group.names)&timespan=$span&interval=$Interval&aggregation=$($group.aggregation)$filter"
        try { $response = Invoke-RestMethod -Method Get -Uri $uri -Headers (Get-Headers) } catch {
            $detail = if ($_.ErrorDetails) { $_.ErrorDetails.Message } else { $_.Exception.Message }
            Write-Warning "$label $($group.names): $detail"
            continue
        }

        foreach ($metric in $response.value) {
            foreach ($timeseries in $metric.timeseries) {
                $instance = ($timeseries.metadatavalues | Where-Object { $_.name.value -eq 'instance' } | Select-Object -First 1).value
                $property = $group.aggregation.ToLowerInvariant()
                $points = @($timeseries.data | ForEach-Object { @{ time = $_.timeStamp; value = $_.$property } })
                $series.Add([ordered]@{
                    site = $label
                    metric = $metric.name.value
                    aggregation = $group.aggregation
                    instance = $instance
                    points = $points
                })
            }
        }
    }
}

$result = [ordered]@{
    start = $Start.ToUniversalTime().ToString('o')
    end = $End.ToUniversalTime().ToString('o')
    interval = $Interval
    series = $series
}
New-Item -ItemType Directory -Force (Split-Path -Parent ([System.IO.Path]::GetFullPath($OutFile))) | Out-Null
$result | ConvertTo-Json -Depth 8 -Compress | Set-Content -Encoding utf8 $OutFile
Write-Host "$($series.Count) series -> $OutFile"
