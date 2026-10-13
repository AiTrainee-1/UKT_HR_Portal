/**
 * Worked examples for the Payroll tab, computed with the payroll engine's own formulas, so the figures a preview shows
 * are the figures a payslip would print:
 *   staff PF / ESI / OT pay   backend/api/payroll_views.py  _generate_staff_payroll
 *   production PF / ESI       backend/api/payroll_views.py  _generate_production_payroll (flat rates and salary bands)
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
  /** Settings -> Payroll -> "Deduct PF and ESI from staff pay". */
  rulesOn: boolean;
  pfRate: number;
  esiRate: number;
  esiCeiling: number;
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
  pf: number;
  esi: number;
  /** True when the full monthly salary is at or below the ESI ceiling (and the ESI rate is above 0). */
  esiApplies: boolean;
  deductions: number;
  net: number;
};

/**
 * One staff payslip's pay, PF and ESI in paise. Basic is 50% (and HRA 20%) of the salary, pro-rated by the days paid:
 * fixed in the engine, whatever the employee's recorded Salary Split says. PF = Basic x PF rate (no wage ceiling).
 * ESI = pay earned (without OT pay) x ESI rate, only when the FULL monthly salary is at or below the ceiling.
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
  let pf = 0;
  let esi = 0;
  let esiApplies = false;
  if (input.rulesOn) {
    pf = input.pfRate > 0 ? percentOf(basic, input.pfRate) : 0;
    esiApplies = input.esiRate > 0 && salary <= toPaise(input.esiCeiling);
    esi = esiApplies ? percentOf(gross, input.esiRate) : 0;
  }
  const deductions = pf + esi;
  return { gross, basic, hra, dailyRate, ot, pf, esi, esiApplies, deductions, net: gross + ot - deductions };
}

// ── production payslip ──

/** One salary band of Settings -> Payroll -> Production PF/EF, as stored (values may be anything an old client sent). */
export type PfEfRule = {
  label?: unknown;
  minSalary?: unknown;
  maxSalary?: unknown;
  pfRate?: unknown;
  efRate?: unknown;
};

/** The "estimated monthly pay" factor of a production payslip that belongs to no pay cycle: the old fixed period pay x 2. */
export const NO_CYCLE_MONTHLY_FACTOR = 2;

export type ProductionPayInput = {
  /** Shifts earned in the pay period (quarter shifts allowed). */
  shifts: number;
  /** The employee's own Salary Per Shift (₹). */
  ratePerShift: number;
  /** Flat rates: "Deduct flat-rate PF and ESI from production pay" and its three values. */
  flatOn: boolean;
  pfRate: number;
  esiRate: number;
  esiCeiling: number;
  /** Salary bands: their own switch and rows. */
  bandsOn: boolean;
  bands: PfEfRule[];
  /** Late deduction already priced in paise (Production Payroll -> Late Detection). */
  latePenalty?: number;
  /**
   * What the period's pay is multiplied by to get the "estimated monthly pay" the bands and the ESI ceiling are tested
   * on: 4 on the Weekly cycle, 2 on BiWeekly, 1 on Monthly (a production month is four weeks). Left out it is 2, the
   * rule payroll keeps for a payslip that belongs to no cycle.
   */
  monthlyFactor?: number;
};

export type ProductionPay = {
  gross: number;
  /** "Estimated monthly pay" = the period's pay x the cycle's factor (4 Weekly, 2 BiWeekly, 1 Monthly). */
  monthlyEstimate: number;
  /** Which mechanism decided PF / ESI: a salary band, the flat rates, or nothing. */
  source: "band" | "flat" | "none";
  /** The matching band (1-based position in the list) when source is "band". */
  band: { position: number; label: string } | null;
  pfRate: number;
  esiRate: number;
  pf: number;
  esi: number;
  latePenalty: number;
  net: number;
};

/** A stored number the way the engine reads it: `Decimal(str(value or 0))`; null when it cannot be read. */
function engineNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || value === 0 || value === false) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*[+-]?(\d+\.?\d*|\.\d+)\s*$/.test(value)) return Number(value);
  return null;
}

/**
 * The first band (in list order) whose range holds `monthlyEstimatePaise`: Min <= estimate and (Max <= 0 or estimate
 * <= Max), both ends included. Rows whose Min or Max cannot be read are skipped, as the engine does.
 */
export function matchingBand(bands: PfEfRule[], monthlyEstimatePaise: number): number {
  const estimate = monthlyEstimatePaise / 100;
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i];
    if (!band || typeof band !== "object") continue;
    const low = engineNumber(band.minSalary);
    const high = engineNumber(band.maxSalary);
    if (low === null || high === null) continue;
    if (estimate >= low && (high <= 0 || estimate <= high)) return i;
  }
  return -1;
}

/**
 * One production payslip: gross = shifts x rate per shift. PF / ESI: a matching salary band wins (even while the flat
 * switch is off; its EF % has no ceiling test); otherwise the flat rates when their switch is on (ESI only while the
 * estimated monthly pay is at or below the ceiling); otherwise none. The late penalty comes off take-home pay.
 */
export function productionPay(input: ProductionPayInput): ProductionPay {
  const gross = divRoundHalfUp(Math.round(input.shifts * 100) * toPaise(input.ratePerShift), 100);
  const monthlyEstimate = gross * (input.monthlyFactor ?? NO_CYCLE_MONTHLY_FACTOR);
  const latePenalty = input.latePenalty ?? 0;
  const index = input.bandsOn ? matchingBand(input.bands, monthlyEstimate) : -1;
  let result: Pick<ProductionPay, "source" | "band" | "pfRate" | "esiRate" | "pf" | "esi">;
  if (index >= 0) {
    const band = input.bands[index];
    const pfRate = engineNumber(band.pfRate) ?? 0;
    const esiRate = engineNumber(band.efRate) ?? 0;
    result = {
      source: "band",
      band: { position: index + 1, label: typeof band.label === "string" ? band.label : "" },
      pfRate,
      esiRate,
      pf: pfRate > 0 ? percentOf(gross, pfRate) : 0,
      esi: esiRate > 0 ? percentOf(gross, esiRate) : 0,
    };
  } else if (input.flatOn) {
    result = {
      source: "flat",
      band: null,
      pfRate: input.pfRate,
      esiRate: input.esiRate,
      pf: input.pfRate > 0 ? percentOf(gross, input.pfRate) : 0,
      esi: input.esiRate > 0 && monthlyEstimate <= toPaise(input.esiCeiling) ? percentOf(gross, input.esiRate) : 0,
    };
  } else {
    result = { source: "none", band: null, pfRate: 0, esiRate: 0, pf: 0, esi: 0 };
  }
  return { gross, monthlyEstimate, latePenalty, ...result, net: gross - result.pf - result.esi - latePenalty };
}

export type BandIssue = { kind: "overlap" | "gap" | "open-top" | "unreadable" | "never"; text: string };

/**
 * What a list of salary bands leaves to chance: two bands that overlap (the higher one in the list wins), estimates no
 * band covers (gaps, or nothing above the highest band), rows the engine skips, and rows that can never match.
 * Estimates are whole paise, so a gap is any paisa between two bands.
 */
export function bandIssues(bands: PfEfRule[]): BandIssue[] {
  const issues: BandIssue[] = [];
  const ranges: { position: number; low: number; high: number }[] = [];
  bands.forEach((band, i) => {
    const low = engineNumber(band?.minSalary);
    const high = engineNumber(band?.maxSalary);
    if (low === null || high === null) {
      issues.push({ kind: "unreadable", text: `Band ${i + 1} has a Min or Max that is not a number: it is skipped.` });
      return;
    }
    const top = high <= 0 ? Infinity : high;
    if (top < low) {
      issues.push({ kind: "never", text: `Band ${i + 1} can never match: its Max is below its Min.` });
      return;
    }
    ranges.push({ position: i + 1, low: toPaise(low), high: top === Infinity ? Infinity : toPaise(top) });
  });
  for (let a = 0; a < ranges.length; a++) {
    for (let b = a + 1; b < ranges.length; b++) {
      const from = Math.max(ranges[a].low, ranges[b].low);
      const to = Math.min(ranges[a].high, ranges[b].high);
      if (from <= to) {
        const until = to === Infinity ? "upwards" : `to ${formatPaise(to)}`;
        issues.push({
          kind: "overlap",
          text: `Bands ${ranges[a].position} and ${ranges[b].position} overlap from ${formatPaise(from)} ${until}: band ${ranges[a].position} wins there.`,
        });
      }
    }
  }
  if (ranges.length > 0) {
    const sorted = [...ranges].sort((x, y) => x.low - y.low);
    let covered = -1; // highest paisa covered so far
    for (const r of sorted) {
      if (r.low > covered + 1) {
        issues.push({
          kind: "gap",
          text: `An estimated monthly pay from ${formatPaise(covered + 1)} to ${formatPaise(r.low - 1)} matches no band.`,
        });
      }
      covered = Math.max(covered, r.high);
    }
    if (covered !== Infinity) {
      issues.push({
        kind: "open-top",
        text: `An estimated monthly pay above ${formatPaise(covered)} matches no band.`,
      });
    }
  }
  return issues;
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
