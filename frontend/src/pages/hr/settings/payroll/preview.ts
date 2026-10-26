/**
 * Worked examples for the Payroll tab, computed with the payroll engine's own formulas, so the figures a preview shows
 * are the figures a payslip would print:
 *   staff pay / OT pay        backend/api/payroll_views.py  _generate_staff_payroll
 *   production pay            backend/api/payroll_views.py  _generate_production_payroll
 *   statutory bonus           backend/api/growth_views.py   _calculate_bonus_for_employee, _fy_label_for_date, _fy_month_years
 *   overtime                  backend/api/overtime.py       detect_overtime_for_month
 *   salary pay day            backend/api/md_portal/analytics/payroll.py  _pay_day, _due_status_items
 * Money is kept in whole paise and rounded the way the engine rounds (Decimal, ROUND_HALF_UP to 2 places; the bonus
 * amount uses Decimal.quantize's default ROUND_HALF_EVEN). Nothing here fetches or stores anything.
 */

// ── money ──

/** ₹ amount -> whole paise. */
export const toPaise = (rupees: number): number => Math.round(rupees * 100);

/** A percentage as whole ten-thousandths of a per cent (12 -> 120000, 0.75 -> 7500), so rates with up to four decimals stay exact. */
const rateUnits = (percent: number): number => Math.round(percent * 10_000);

/** num / den rounded half away from zero (Decimal ROUND_HALF_UP); integers in, integer out. */
export function divRoundHalfUp(num: number, den: number): number {
  const sign = num < 0 ? -1 : 1;
  const n = Math.abs(num);
  let q = Math.floor(n / den);
  let r = n - q * den;
  if (r < 0) {
    q -= 1;
    r += den;
  } else if (r >= den) {
    q += 1;
    r -= den;
  }
  return sign * (2 * r >= den ? q + 1 : q);
}

/** num / den rounded half to even (Decimal.quantize with the default context); integers in, integer out. */
export function divRoundHalfEven(num: number, den: number): number {
  const sign = num < 0 ? -1 : 1;
  const n = Math.abs(num);
  let q = Math.floor(n / den);
  let r = n - q * den;
  if (r < 0) {
    q -= 1;
    r += den;
  } else if (r >= den) {
    q += 1;
    r -= den;
  }
  if (2 * r > den || (2 * r === den && q % 2 === 1)) q += 1;
  return sign * q;
}

/** `amountPaise` x `percent` %, rounded to the paisa like the engine's _d2. */
export const percentOf = (amountPaise: number, percent: number): number =>
  divRoundHalfUp(amountPaise * rateUnits(percent), 1_000_000);

/** 120000 -> "₹1,200.00" (Indian digit grouping). */
export function formatPaise(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100).toLocaleString("en-IN");
  return `${sign}₹${whole}.${String(abs % 100).padStart(2, "0")}`;
}

/** 20000 -> "₹20,000" (whole rupees, for amounts typed as whole numbers in a scenario). */
export const formatRupees = (rupees: number): string =>
  Number.isInteger(rupees) ? `₹${rupees.toLocaleString("en-IN")}` : formatPaise(toPaise(rupees));

/** 12 -> "12%", 0.75 -> "0.75%". */
export const formatPercent = (percent: number): string => `${Number(percent.toFixed(4))}%`;

// ── staff payslip ──

export type StaffPayInput = {
  /** Full monthly salary (₹). */
  salary: number;
  /** That month's working days for the employee. */
  workingDays: number;
  /** Days paid: present shifts plus paid leave (a half day counts 0.5). */
  daysPaid: number;
  /** Announced OT "pay" days in the month, and whether the OT & Compensation features are on. */
  otDays?: number;
  otOn?: boolean;
};

export type StaffPay = {
  gross: number;
  basic: number;
  hra: number;
  dailyRate: number;
  ot: number;
  /** Pay plus OT pay: PF, ESI and TDS are not part of these examples (they have their own tab, PF & ESI). */
  net: number;
};

/**
 * One staff payslip's pay in paise: the salary pro-rated by the days paid, plus OT pay. Basic is 50% (and HRA 20%) of the
 * salary earned, pro-rated the same way. PF and ESI are not worked out here: their rules are on the PF & ESI tab and its
 * own examples (./pf-esi/preview.ts).
 */
export function staffPay(input: StaffPayInput): StaffPay {
  const salary = toPaise(input.salary);
  const days = Math.round(input.daysPaid * 100);
  const working = Math.max(1, Math.round(input.workingDays)) * 100;
  const gross = divRoundHalfUp(salary * days, working);
  const basic = divRoundHalfUp(divRoundHalfUp(salary * 50, 100) * days, working);
  const hra = divRoundHalfUp(divRoundHalfUp(salary * 20, 100) * days, working);
  const dailyRate = divRoundHalfUp(salary * 100, working);
  const ot = input.otOn && input.otDays ? dailyRate * input.otDays : 0;
  return { gross, basic, hra, dailyRate, ot, net: gross + ot };
}

// ── production payslip ──

/** The "estimated monthly pay" factor of a production payslip that belongs to no pay cycle: the old fixed period pay x 2. */
export const NO_CYCLE_MONTHLY_FACTOR = 2;

export type ProductionPayInput = {
  /** Shifts earned in the pay period (quarter shifts allowed). */
  shifts: number;
  /** The employee's own Salary Per Shift (₹). */
  ratePerShift: number;
  /** Late deduction already priced in paise (Production Payroll -> Late Detection). */
  latePenalty?: number;
  /**
   * What the period's pay is multiplied by to get the "estimated monthly pay" the PF / ESI rules are tested on (their
   * "Full monthly salary" basis): 4 on the Weekly cycle, 2 on BiWeekly, 1 on Monthly (a production month is four weeks).
   * Left out it is 2, the rule payroll keeps for a payslip that belongs to no cycle.
   */
  monthlyFactor?: number;
};

export type ProductionPay = {
  gross: number;
  /** "Estimated monthly pay" = the period's pay x the cycle's factor (4 Weekly, 2 BiWeekly, 1 Monthly). */
  monthlyEstimate: number;
  latePenalty: number;
  /** Pay less the late penalty (PF, ESI and TDS are not part of these examples). */
  net: number;
};

/** One production payslip: gross = shifts x rate per shift; the late penalty comes off take-home pay. */
export function productionPay(input: ProductionPayInput): ProductionPay {
  const gross = divRoundHalfUp(Math.round(input.shifts * 100) * toPaise(input.ratePerShift), 100);
  const monthlyEstimate = gross * (input.monthlyFactor ?? NO_CYCLE_MONTHLY_FACTOR);
  const latePenalty = input.latePenalty ?? 0;
  return { gross, monthlyEstimate, latePenalty, net: gross - latePenalty };
}

// ── statutory bonus ──

export type BonusInput = {
  /** The "Basic" of each of the financial year's salary slips, oldest first (₹). */
  slipBasics: number[];
  /** Used as the monthly wage when there is no slip in the year (₹). */
  profileSalary?: number;
  wageCeiling: number;
  eligibilityCeiling: number;
  percent: number;
};

export type Bonus = { base: number; monthlyWage: number; eligible: boolean; amount: number };

/**
 * The Bonus page's figure for one employee: base = sum over the year's slips of the smaller of the slip's Basic and the
 * wage ceiling; eligible when the latest slip's Basic (or the profile salary with no slip) is at or below the
 * eligibility ceiling; bonus = base x percent / 100.
 */
export function bonusFor(input: BonusInput): Bonus {
  const ceiling = toPaise(input.wageCeiling);
  const basics = input.slipBasics.map(toPaise);
  const base = basics.reduce((sum, basic) => sum + Math.min(basic, ceiling), 0);
  const monthlyWage = basics.length ? basics[basics.length - 1] : toPaise(input.profileSalary ?? 0);
  const hasData = basics.length > 0 || monthlyWage > 0;
  const eligible = hasData && monthlyWage <= toPaise(input.eligibilityCeiling);
  const amount = eligible ? divRoundHalfEven(base * rateUnits(input.percent), 1_000_000) : 0;
  return { base, monthlyWage, eligible, amount };
}

/** A staff slip's Basic for a fully paid month: 50% of the salary (₹). */
export const staffFullMonthBasic = (salary: number): number => divRoundHalfUp(toPaise(salary) * 50, 100) / 100;

// ── financial year ──

export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const SHORT_MONTHS = MONTHS.map((m) => m.slice(0, 3));

export type YearMonth = { year: number; month: number };

/** The financial year a month belongs to, labelled the engine's way: "2026-27" (start year, then the next year's last two digits). */
export function fyLabelFor(year: number, month: number, startMonth: number): string {
  const startYear = month >= startMonth ? year : year - 1;
  return `${startYear}-${String(startYear + 1).slice(-2)}`;
}

/** The twelve months of a financial year label ("2026-27"), first to last. */
export function fyMonths(label: string, startMonth: number): YearMonth[] {
  const startYear = Number.parseInt(label.split("-")[0], 10);
  return Array.from({ length: 12 }, (_, i) => {
    const raw = startMonth + i;
    return { year: startYear + Math.floor((raw - 1) / 12), month: ((raw - 1) % 12) + 1 };
  });
}

export const formatYearMonth = (ym: YearMonth): string => `${SHORT_MONTHS[ym.month - 1]} ${ym.year}`;

// ── overtime ──

/** "HH:MM" or "HH:MM:SS" -> seconds past midnight; null for anything else. */
export function clockSeconds(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const [h, min, s] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  return h <= 23 && min <= 59 && s <= 59 ? h * 3600 + min * 60 + s : null;
}

/**
 * Overtime for one day: whole minutes from the shift's end to the last punch (never negative), flagged when at least
 * the threshold. A threshold of 0 behaves as 60 in the engine (`ot_threshold_minutes or 60`).
 */
export function overtimeFor(lastPunch: string, shiftEnd: string, threshold: number) {
  const last = clockSeconds(lastPunch) ?? 0;
  const end = clockSeconds(shiftEnd) ?? 0;
  const minutes = Math.max(0, Math.floor((last - end) / 60));
  const effective = threshold || 60;
  return { minutes, threshold: effective, flagged: minutes >= effective };
}

/** "17:30" + 75 minutes -> "18:45" (same day; for building examples). */
export function addMinutes(clock: string, minutes: number): string {
  const total = Math.floor((clockSeconds(clock) ?? 0) / 60) + minutes;
  const wrapped = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

// ── dates ──

export type Day = { year: number; month: number; day: number };

export const dayOf = (date: Date): Day => ({
  year: date.getFullYear(),
  month: date.getMonth() + 1,
  day: date.getDate(),
});

const utc = (d: Day): number => Date.UTC(d.year, d.month - 1, d.day);

export const daysBetween = (from: Day, to: Day): number => Math.round((utc(to) - utc(from)) / 86_400_000);

/** "5 Oct 2026". */
export const formatDay = (d: Day): string => `${d.day} ${SHORT_MONTHS[d.month - 1]} ${d.year}`;

// ── salary pay day ──

export const PAY_DAY_CRITICAL_DAYS = 7;

export type PayDayStatus = {
  /** The pay day the MD portal uses (blank -> 5, then kept within 1-28). */
  payDay: number;
  /** The salary month that is due now: the month before `today`. */
  salaryMonth: YearMonth;
  due: Day;
  /** Days since the due date (0 or less = not yet due). */
  daysPast: number;
  level: "not-due" | "warning" | "critical";
};

/**
 * What the MD portal makes of the salary pay day on `today`: last month's salary is due on the pay day of this month;
 * once that day has passed an unpaid or ungenerated payroll is a warning, and critical after 7 more days.
 */
export function payDayStatus(payDay: number, today: Day): PayDayStatus {
  const pay = Math.min(28, Math.max(1, Math.trunc(payDay) || 5));
  const salaryMonth =
    today.month === 1 ? { year: today.year - 1, month: 12 } : { year: today.year, month: today.month - 1 };
  const due = { year: today.year, month: today.month, day: pay };
  const daysPast = daysBetween(due, today);
  const level = daysPast <= 0 ? "not-due" : daysPast > PAY_DAY_CRITICAL_DAYS ? "critical" : "warning";
  return { payDay: pay, salaryMonth, due, daysPast, level };
}

/** 1 -> "1st", 22 -> "22nd", 13 -> "13th". */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}
