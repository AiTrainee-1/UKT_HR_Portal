"""
Employer cost (CTC) of one employee: the figures behind the Compensation page's CTC Breakdown and the Report
Center's Employer Cost / CTC Statement, calculated in ONE place so the two can never disagree.

    Salary split     the employee's 50% + 50% split (salary_split.py): Basic, DA, Retaining Allowance | Other,
                     Petrol, HRA, Special Allowance, CA. An employee with a salary but no recorded split shows the
                     automatic one (`splitRecorded` false) - nothing is written.
    Employer PF      the matched PF rule's percentage x the FIRST portion (Basic + DA + Retaining Allowance, which is what
                     PF wages are made of, and equal to the 50% base payroll itself uses).
    Employer ESI     the matched ESI rule's percentage x the same first portion.
    Annual CTC       (monthly salary + employer PF + employer ESI) x 12.

PF and ESI exist only for Co Emp employees (pf_esi.py: the rule lists of Settings -> PF & ESI, Co Emp switch): everybody
else, TDS employees included, has none.

Display only: nothing here feeds payroll generation, which judges the same rules itself (pf_esi.staff_statutory /
production_statutory). The settings are passed in already resolved for the employee's branch, so a caller looping over a
company reads them once per branch rather than once per employee.
"""

from decimal import Decimal

from . import pf_esi, salary_split
from .models import Employee

ZERO = Decimal("0.00")

# The eight components, in display order, as the API names them.
SPLIT_JSON_KEYS = tuple(salary_split.JSON_KEYS[c] for c in salary_split.COMPONENTS)


def _d2(value) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.01"))


def ctc_figures(emp: Employee, settings) -> dict:
    """The salary split plus PF / ESI / gross / annual CTC for one employee, as JSON-ready numbers. The eight split
    keys and the two portion totals are None when the employee has no monthly salary."""
    salary = emp.salary_amount or ZERO
    parts, recorded = salary_split.effective_split(emp)

    figures: dict = {key: None for key in SPLIT_JSON_KEYS}
    first = second = None
    if parts is not None:
        figures.update({salary_split.JSON_KEYS[c]: float(parts[c]) for c in salary_split.COMPONENTS})
        first = sum((parts[c] for c in salary_split.FIRST_PORTION), ZERO)
        second = sum((parts[c] for c in salary_split.SECOND_PORTION), ZERO)

    employer_pf, employer_esi = pf_esi.employer_contributions(emp, settings)
    gross_monthly = _d2(salary)

    figures.update(
        {
            "firstPortion": float(first) if first is not None else None,
            "secondPortion": float(second) if second is not None else None,
            "splitRecorded": recorded,
            "employerPf": float(employer_pf),
            "employerEsi": float(employer_esi),
            "grossMonthly": float(gross_monthly),
            "annualCtc": float(_d2((gross_monthly + employer_pf + employer_esi) * 12)),
        }
    )
    return figures
