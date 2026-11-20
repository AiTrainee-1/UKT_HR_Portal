"""HR -> Payroll -> Salary Slip (/hr/salary-slip): standalone salary slips, salary statements and bank files.

Owner 2026-11-20: slips for ANY employee (active, inactive, on hold, new joiners) worked out from the employee's own
details, their attendance and their salary details only - no dependency on Staff Payroll, Production Payroll,
Settlements or any payroll generation, lock or processing. Nothing here reads or writes Payroll / SalarySlip rows and
nothing in payroll reads what this module saves.

    engine.py     works one employee's month out (read-only): the pay rules payroll uses, re-applied here
    service.py    the page's rows, Generate (saves StandaloneSalarySlip) and the page's own Hold switch
    pdf.py        the slip PDF (the payroll slip's own layout, fed with these figures)
    statement.py  the salary statement, PDF and Excel
    bank_file.py  the bank transfer file, in the same bank template as the payroll bank file
    views.py      /api/salary-slip-center/...  (permission key salary_slip_center)
"""
