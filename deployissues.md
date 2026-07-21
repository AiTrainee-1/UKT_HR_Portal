Windows PowerShell
Copyright (C) Microsoft Corporation. All rights reserved.

Install the latest PowerShell for new features and improvements! https://aka.ms/PSWindows

PS C:\WINDOWS\system32> cd D:\HRMS\UKT_HR_Portal
PS D:\HRMS\UKT_HR_Portal> .\nssm.exe restart UKTextilesDjango
UKTextilesDjango: STOP: The operation completed successfully.
UKTextilesDjango: START: The operation completed successfully.
PS D:\HRMS\UKT_HR_Portal> # Restart Django / Waitress backend
>> .\nssm.exe restart UKTextilesDjango
>>
>> # Restart Nginx
>> .\nssm.exe restart UKTextilesNginx
>>
>> # Restart Cloudflare Tunnel
>> .\nssm.exe restart UKTextilesTunnel
UKTextilesDjango: STOP: The operation completed successfully.
UKTextilesDjango: START: The operation completed successfully.
UKTextilesNginx: STOP: The operation completed successfully.
UKTextilesNginx: START: The operation completed successfully.
UKTextilesTunnel: STOP: The operation completed successfully.
UKTextilesTunnel: START: The operation completed successfully.
PS D:\HRMS\UKT_HR_Portal> Get-Service -Name 'UKTextiles*' | Restart-Service -Verbose
VERBOSE: Performing the operation "Restart-Service" on target "UKTextilesDjango (UKTextilesDjango)".
VERBOSE: Performing the operation "Restart-Service" on target "UKTextilesNginx (UKTextilesNginx)".
VERBOSE: Performing the operation "Restart-Service" on target "UKTextilesTunnel (UKTextilesTunnel)".
PS D:\HRMS\UKT_HR_Portal> Get-Service -Name 'UKTextiles*' | Select-Object Name, Status, StartType

Name              Status StartType
----              ------ ---------
UKTextilesDjango Running Automatic
UKTextilesNginx  Running Automatic
UKTextilesTunnel Running Automatic


PS D:\HRMS\UKT_HR_Portal> .\nssm.exe restart UKTextilesDjango
>> .\nssm.exe restart UKTextilesNginx
>> .\nssm.exe restart UKTextilesTunnel
UKTextilesDjango: STOP: The operation completed successfully.
UKTextilesDjango: START: The operation completed successfully.
UKTextilesNginx: STOP: The operation completed successfully.
UKTextilesNginx: START: The operation completed successfully.
UKTextilesTunnel: STOP: The operation completed successfully.
UKTextilesTunnel: START: The operation completed successfully.
PS D:\HRMS\UKT_HR_Portal> Restart-Service -Name UKTextilesDjango -Force
PS D:\HRMS\UKT_HR_Portal> Get-NetTCPConnection -LocalPort 8000 -State Listen | Select OwningProcess

OwningProcess
-------------
         7556


PS D:\HRMS\UKT_HR_Portal> Get-NetTCPConnection -LocalPort 8000 -State Listen | Select OwningProcess

OwningProcess
-------------
         7556


PS D:\HRMS\UKT_HR_Portal> Restart-Service -Name UKTextilesDjango -Force
PS D:\HRMS\UKT_HR_Portal> Get-NetTCPConnection -LocalPort 8000 -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess

LocalAddress LocalPort OwningProcess
------------ --------- -------------
127.0.0.1         8000          7556


PS D:\HRMS\UKT_HR_Portal> Get-Process -Id 7556 | Select-Object Id, ProcessName, Path, StartTime

  Id ProcessName Path                                                              StartTime
  -- ----------- ----                                                              ---------
7556 python      C:\Users\uktex\AppData\Local\Python\pythoncore-3.14-64\python.exe 21-07-2026 08:56:11


PS D:\HRMS\UKT_HR_Portal> # 1. Stop the registered service first
>> Stop-Service -Name UKTextilesDjango -Force -ErrorAction SilentlyContinue
>>
>> # 2. Kill PID 7556 (the global python process)
>> Stop-Process -Id 7556 -Force -ErrorAction SilentlyContinue
>>
>> # 3. Double-check and kill ANY remaining global python processes
>> Get-Process -Name python -ErrorAction SilentlyContinue | ForEach-Object {
>>     if ($_.Path -like "*AppData*") {
>>         Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
>>     }
>> }
>>
>> # 4. Verify Port 8000 is completely FREE (should print nothing)
>> Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
>>
>> # 5. Start the official NSSM service
>> Start-Service -Name UKTextilesDjango
>> Start-Sleep -Seconds 3
>>
>> # 6. Check who owns Port 8000 now
>> Get-NetTCPConnection -LocalPort 8000 -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess

LocalAddress LocalPort OwningProcess
------------ --------- -------------
127.0.0.1         8000         17516


PS D:\HRMS\UKT_HR_Portal> $portPid = (Get-NetTCPConnection -LocalPort 8000 -State Listen).OwningProcess
>> Get-Process -Id $portPid | Select-Object Id, ProcessName, Path

   Id ProcessName Path
   -- ----------- ----
17516 python      C:\Users\uktex\AppData\Local\Python\pythoncore-3.14-64\python.exe


PS D:\HRMS\UKT_HR_Portal> Stop-Service -Name UKTextilesDjango -Force -ErrorAction SilentlyContinue
>> Stop-Process -Id 17516 -Force -ErrorAction SilentlyContinue
PS D:\HRMS\UKT_HR_Portal> cd D:\HRMS\UKT_HR_Portal
>>
>> # Update NSSM Application path to the virtual environment python.exe
>> .\nssm.exe set UKTextilesDjango Application "D:\HRMS\UKT_HR_Portal\backend\.venv\Scripts\python.exe"
Set parameter "Application" for service "UKTextilesDjango".
PS D:\HRMS\UKT_HR_Portal> Start-Service -Name UKTextilesDjango
>> Start-Sleep -Seconds 3
PS D:\HRMS\UKT_HR_Portal> $portPid = (Get-NetTCPConnection -LocalPort 8000 -State Listen).OwningProcess
>> Get-Process -Id $portPid | Select-Object Id, ProcessName, Path

   Id ProcessName Path
   -- ----------- ----
15504 python      C:\Users\uktex\AppData\Local\Python\pythoncore-3.14-64\python.exe


PS D:\HRMS\UKT_HR_Portal>