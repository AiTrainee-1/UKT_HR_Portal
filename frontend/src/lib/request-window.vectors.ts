// The shared request-window test vectors, copied unchanged from the product-owner reference (request-window-vectors.json).
// The backend, the Employee Web App, the Mobile App and this portal all assert the SAME vectors, so do not edit them
// here: change the rule in every codebase together and regenerate this file from the shared JSON.
//
// Each probe's `today` is a local date; the test builds a Date at 13:30 local time on that day.

export type WindowVector = {
  today: string;
  min: string;
  max: string;
  graceOpen: boolean;
  currentMonth: string;
  previousMonth: string;
  message: string;
  hint: string;
};

export type DateVector = {
  today: string;
  date: string;
  error: string | null;
  errorNoFuture: string | null;
};

export type RangeVector = {
  today: string;
  start: string;
  end: string;
  error: string | null;
};

export type RequestWindowVectors = {
  graceDays: number;
  windows: WindowVector[];
  dates: DateVector[];
  ranges: RangeVector[];
};

export const requestWindowVectors: RequestWindowVectors = {
  graceDays: 2,
  windows: [
    {
      today: "2026-10-01",
      min: "2026-09-01",
      max: "2026-10-31",
      graceOpen: true,
      currentMonth: "October 2026",
      previousMonth: "September 2026",
      message:
        "You can only request dates from 1 September 2026 to 31 October 2026. September closes at the end of 2 October.",
      hint: "1 September 2026 to 31 October 2026",
    },
    {
      today: "2026-10-02",
      min: "2026-09-01",
      max: "2026-10-31",
      graceOpen: true,
      currentMonth: "October 2026",
      previousMonth: "September 2026",
      message:
        "You can only request dates from 1 September 2026 to 31 October 2026. September closes at the end of 2 October.",
      hint: "1 September 2026 to 31 October 2026",
    },
    {
      today: "2026-10-03",
      min: "2026-10-01",
      max: "2026-10-31",
      graceOpen: false,
      currentMonth: "October 2026",
      previousMonth: "September 2026",
      message: "You can only request dates in October 2026.",
      hint: "Any day in October 2026",
    },
    {
      today: "2026-10-15",
      min: "2026-10-01",
      max: "2026-10-31",
      graceOpen: false,
      currentMonth: "October 2026",
      previousMonth: "September 2026",
      message: "You can only request dates in October 2026.",
      hint: "Any day in October 2026",
    },
    {
      today: "2026-10-31",
      min: "2026-10-01",
      max: "2026-10-31",
      graceOpen: false,
      currentMonth: "October 2026",
      previousMonth: "September 2026",
      message: "You can only request dates in October 2026.",
      hint: "Any day in October 2026",
    },
    {
      today: "2026-01-01",
      min: "2025-12-01",
      max: "2026-01-31",
      graceOpen: true,
      currentMonth: "January 2026",
      previousMonth: "December 2025",
      message:
        "You can only request dates from 1 December 2025 to 31 January 2026. December closes at the end of 2 January.",
      hint: "1 December 2025 to 31 January 2026",
    },
    {
      today: "2026-01-02",
      min: "2025-12-01",
      max: "2026-01-31",
      graceOpen: true,
      currentMonth: "January 2026",
      previousMonth: "December 2025",
      message:
        "You can only request dates from 1 December 2025 to 31 January 2026. December closes at the end of 2 January.",
      hint: "1 December 2025 to 31 January 2026",
    },
    {
      today: "2026-01-03",
      min: "2026-01-01",
      max: "2026-01-31",
      graceOpen: false,
      currentMonth: "January 2026",
      previousMonth: "December 2025",
      message: "You can only request dates in January 2026.",
      hint: "Any day in January 2026",
    },
    {
      today: "2026-03-01",
      min: "2026-02-01",
      max: "2026-03-31",
      graceOpen: true,
      currentMonth: "March 2026",
      previousMonth: "February 2026",
      message:
        "You can only request dates from 1 February 2026 to 31 March 2026. February closes at the end of 2 March.",
      hint: "1 February 2026 to 31 March 2026",
    },
    {
      today: "2026-03-02",
      min: "2026-02-01",
      max: "2026-03-31",
      graceOpen: true,
      currentMonth: "March 2026",
      previousMonth: "February 2026",
      message:
        "You can only request dates from 1 February 2026 to 31 March 2026. February closes at the end of 2 March.",
      hint: "1 February 2026 to 31 March 2026",
    },
    {
      today: "2026-03-03",
      min: "2026-03-01",
      max: "2026-03-31",
      graceOpen: false,
      currentMonth: "March 2026",
      previousMonth: "February 2026",
      message: "You can only request dates in March 2026.",
      hint: "Any day in March 2026",
    },
    {
      today: "2028-03-01",
      min: "2028-02-01",
      max: "2028-03-31",
      graceOpen: true,
      currentMonth: "March 2028",
      previousMonth: "February 2028",
      message:
        "You can only request dates from 1 February 2028 to 31 March 2028. February closes at the end of 2 March.",
      hint: "1 February 2028 to 31 March 2028",
    },
    {
      today: "2028-03-02",
      min: "2028-02-01",
      max: "2028-03-31",
      graceOpen: true,
      currentMonth: "March 2028",
      previousMonth: "February 2028",
      message:
        "You can only request dates from 1 February 2028 to 31 March 2028. February closes at the end of 2 March.",
      hint: "1 February 2028 to 31 March 2028",
    },
    {
      today: "2028-03-03",
      min: "2028-03-01",
      max: "2028-03-31",
      graceOpen: false,
      currentMonth: "March 2028",
      previousMonth: "February 2028",
      message: "You can only request dates in March 2028.",
      hint: "Any day in March 2028",
    },
    {
      today: "2026-02-28",
      min: "2026-02-01",
      max: "2026-02-28",
      graceOpen: false,
      currentMonth: "February 2026",
      previousMonth: "January 2026",
      message: "You can only request dates in February 2026.",
      hint: "Any day in February 2026",
    },
    {
      today: "2028-02-29",
      min: "2028-02-01",
      max: "2028-02-29",
      graceOpen: false,
      currentMonth: "February 2028",
      previousMonth: "January 2028",
      message: "You can only request dates in February 2028.",
      hint: "Any day in February 2028",
    },
    {
      today: "2026-12-01",
      min: "2026-11-01",
      max: "2026-12-31",
      graceOpen: true,
      currentMonth: "December 2026",
      previousMonth: "November 2026",
      message:
        "You can only request dates from 1 November 2026 to 31 December 2026. November closes at the end of 2 December.",
      hint: "1 November 2026 to 31 December 2026",
    },
    {
      today: "2026-12-02",
      min: "2026-11-01",
      max: "2026-12-31",
      graceOpen: true,
      currentMonth: "December 2026",
      previousMonth: "November 2026",
      message:
        "You can only request dates from 1 November 2026 to 31 December 2026. November closes at the end of 2 December.",
      hint: "1 November 2026 to 31 December 2026",
    },
    {
      today: "2026-12-31",
      min: "2026-12-01",
      max: "2026-12-31",
      graceOpen: false,
      currentMonth: "December 2026",
      previousMonth: "November 2026",
      message: "You can only request dates in December 2026.",
      hint: "Any day in December 2026",
    },
    {
      today: "2026-11-30",
      min: "2026-11-01",
      max: "2026-11-30",
      graceOpen: false,
      currentMonth: "November 2026",
      previousMonth: "October 2026",
      message: "You can only request dates in November 2026.",
      hint: "Any day in November 2026",
    },
    {
      today: "2026-05-01",
      min: "2026-04-01",
      max: "2026-05-31",
      graceOpen: true,
      currentMonth: "May 2026",
      previousMonth: "April 2026",
      message: "You can only request dates from 1 April 2026 to 31 May 2026. April closes at the end of 2 May.",
      hint: "1 April 2026 to 31 May 2026",
    },
    {
      today: "2026-07-31",
      min: "2026-07-01",
      max: "2026-07-31",
      graceOpen: false,
      currentMonth: "July 2026",
      previousMonth: "June 2026",
      message: "You can only request dates in July 2026.",
      hint: "Any day in July 2026",
    },
  ],
  dates: [
    {
      today: "2026-10-01",
      date: "2026-09-30",
      error: null,
      errorNoFuture: null,
    },
    {
      today: "2026-10-01",
      date: "2026-09-01",
      error: null,
      errorNoFuture: null,
    },
    {
      today: "2026-10-01",
      date: "2026-08-31",
      error:
        "You can only request dates from 1 September 2026 to 31 October 2026. September closes at the end of 2 October.",
      errorNoFuture:
        "You can only request dates from 1 September 2026 to 31 October 2026. September closes at the end of 2 October.",
    },
    {
      today: "2026-10-01",
      date: "2026-10-01",
      error: null,
      errorNoFuture: null,
    },
    {
      today: "2026-10-01",
      date: "2026-10-31",
      error: null,
      errorNoFuture: "Date cannot be in the future.",
    },
    {
      today: "2026-10-01",
      date: "2026-11-01",
      error:
        "You can only request dates from 1 September 2026 to 31 October 2026. September closes at the end of 2 October.",
      errorNoFuture: "Date cannot be in the future.",
    },
    {
      today: "2026-10-02",
      date: "2026-09-01",
      error: null,
      errorNoFuture: null,
    },
    {
      today: "2026-10-02",
      date: "2026-08-31",
      error:
        "You can only request dates from 1 September 2026 to 31 October 2026. September closes at the end of 2 October.",
      errorNoFuture:
        "You can only request dates from 1 September 2026 to 31 October 2026. September closes at the end of 2 October.",
    },
    {
      today: "2026-10-02",
      date: "2026-10-31",
      error: null,
      errorNoFuture: "Date cannot be in the future.",
    },
    {
      today: "2026-10-03",
      date: "2026-09-30",
      error: "You can only request dates in October 2026.",
      errorNoFuture: "You can only request dates in October 2026.",
    },
    {
      today: "2026-10-03",
      date: "2026-09-01",
      error: "You can only request dates in October 2026.",
      errorNoFuture: "You can only request dates in October 2026.",
    },
    {
      today: "2026-10-03",
      date: "2026-10-01",
      error: null,
      errorNoFuture: null,
    },
    {
      today: "2026-10-03",
      date: "2026-10-03",
      error: null,
      errorNoFuture: null,
    },
    {
      today: "2026-10-03",
      date: "2026-10-31",
      error: null,
      errorNoFuture: "Date cannot be in the future.",
    },
    {
      today: "2026-10-03",
      date: "2026-11-01",
      error: "You can only request dates in October 2026.",
      errorNoFuture: "Date cannot be in the future.",
    },
    {
      today: "2026-10-31",
      date: "2026-10-01",
      error: null,
      errorNoFuture: null,
    },
    {
      today: "2026-10-31",
      date: "2026-09-30",
      error: "You can only request dates in October 2026.",
      errorNoFuture: "You can only request dates in October 2026.",
    },
    {
      today: "2026-10-31",
      date: "2026-11-01",
      error: "You can only request dates in October 2026.",
      errorNoFuture: "Date cannot be in the future.",
    },
    {
      today: "2026-01-01",
      date: "2025-12-01",
      error: null,
      errorNoFuture: null,
    },
    {
      today: "2026-01-01",
      date: "2025-12-31",
      error: null,
      errorNoFuture: null,
    },
    {
      today: "2026-01-01",
      date: "2025-11-30",
      error:
        "You can only request dates from 1 December 2025 to 31 January 2026. December closes at the end of 2 January.",
      errorNoFuture:
        "You can only request dates from 1 December 2025 to 31 January 2026. December closes at the end of 2 January.",
    },
    {
      today: "2026-01-02",
      date: "2025-12-15",
      error: null,
      errorNoFuture: null,
    },
    {
      today: "2026-01-03",
      date: "2025-12-31",
      error: "You can only request dates in January 2026.",
      errorNoFuture: "You can only request dates in January 2026.",
    },
    {
      today: "2026-01-03",
      date: "2026-01-01",
      error: null,
      errorNoFuture: null,
    },
    {
      today: "2026-01-03",
      date: "2026-01-31",
      error: null,
      errorNoFuture: "Date cannot be in the future.",
    },
    {
      today: "2026-01-03",
      date: "2026-02-01",
      error: "You can only request dates in January 2026.",
      errorNoFuture: "Date cannot be in the future.",
    },
    {
      today: "2026-03-01",
      date: "2026-02-01",
      error: null,
      errorNoFuture: null,
    },
    {
      today: "2026-03-01",
      date: "2026-02-28",
      error: null,
      errorNoFuture: null,
    },
    {
      today: "2026-03-01",
      date: "2026-02-29",
      error: "Choose a valid date.",
      errorNoFuture: "Choose a valid date.",
    },
    {
      today: "2026-03-03",
      date: "2026-02-28",
      error: "You can only request dates in March 2026.",
      errorNoFuture: "You can only request dates in March 2026.",
    },
    {
      today: "2028-03-01",
      date: "2028-02-29",
      error: null,
      errorNoFuture: null,
    },
    {
      today: "2028-03-01",
      date: "2028-02-01",
      error: null,
      errorNoFuture: null,
    },
    {
      today: "2028-03-03",
      date: "2028-02-29",
      error: "You can only request dates in March 2028.",
      errorNoFuture: "You can only request dates in March 2028.",
    },
    {
      today: "2028-02-29",
      date: "2028-02-29",
      error: null,
      errorNoFuture: null,
    },
    {
      today: "2028-02-29",
      date: "2028-03-01",
      error: "You can only request dates in February 2028.",
      errorNoFuture: "Date cannot be in the future.",
    },
    {
      today: "2026-02-28",
      date: "2026-02-28",
      error: null,
      errorNoFuture: null,
    },
    {
      today: "2026-02-28",
      date: "2026-03-01",
      error: "You can only request dates in February 2026.",
      errorNoFuture: "Date cannot be in the future.",
    },
    {
      today: "2026-12-31",
      date: "2026-12-31",
      error: null,
      errorNoFuture: null,
    },
    {
      today: "2026-12-31",
      date: "2027-01-01",
      error: "You can only request dates in December 2026.",
      errorNoFuture: "Date cannot be in the future.",
    },
    {
      today: "2026-12-02",
      date: "2026-11-01",
      error: null,
      errorNoFuture: null,
    },
    {
      today: "2026-12-03",
      date: "2026-11-30",
      error: "You can only request dates in December 2026.",
      errorNoFuture: "You can only request dates in December 2026.",
    },
    {
      today: "2026-10-15",
      date: "not-a-date",
      error: "Choose a valid date.",
      errorNoFuture: "Choose a valid date.",
    },
    {
      today: "2026-10-15",
      date: "",
      error: "Choose a valid date.",
      errorNoFuture: "Choose a valid date.",
    },
    {
      today: "2026-10-15",
      date: "2026-13-01",
      error: "Choose a valid date.",
      errorNoFuture: "Choose a valid date.",
    },
    {
      today: "2026-10-15",
      date: "2026-02-30",
      error: "Choose a valid date.",
      errorNoFuture: "Choose a valid date.",
    },
    {
      today: "2026-10-15",
      date: "2026-10-1",
      error: "Choose a valid date.",
      errorNoFuture: "Choose a valid date.",
    },
    {
      today: "2026-10-15",
      date: "26-10-15",
      error: "Choose a valid date.",
      errorNoFuture: "Choose a valid date.",
    },
  ],
  ranges: [
    {
      today: "2026-10-15",
      start: "2026-10-20",
      end: "2026-10-22",
      error: null,
    },
    {
      today: "2026-10-15",
      start: "2026-10-30",
      end: "2026-11-02",
      error: "You can only request dates in October 2026.",
    },
    {
      today: "2026-10-15",
      start: "2026-09-30",
      end: "2026-10-02",
      error: "You can only request dates in October 2026.",
    },
    {
      today: "2026-10-15",
      start: "2026-10-22",
      end: "2026-10-20",
      error: "End date must be on or after start date.",
    },
    {
      today: "2026-10-02",
      start: "2026-09-29",
      end: "2026-10-02",
      error: null,
    },
    {
      today: "2026-10-02",
      start: "2026-09-30",
      end: "2026-09-30",
      error: null,
    },
    {
      today: "2026-10-03",
      start: "2026-09-30",
      end: "2026-10-02",
      error: "You can only request dates in October 2026.",
    },
    {
      today: "2026-10-03",
      start: "2026-10-01",
      end: "2026-10-31",
      error: null,
    },
    {
      today: "2026-10-15",
      start: "2026-10-31",
      end: "2026-10-31",
      error: null,
    },
    {
      today: "2026-10-15",
      start: "2026-11-01",
      end: "2026-11-01",
      error: "You can only request dates in October 2026.",
    },
    {
      today: "2026-01-02",
      start: "2025-12-30",
      end: "2026-01-02",
      error: null,
    },
    {
      today: "2026-10-15",
      start: "2026-10-10",
      end: "bad",
      error: "Choose a valid date.",
    },
    {
      today: "2026-10-15",
      start: "",
      end: "2026-10-10",
      error: "Choose a valid date.",
    },
    {
      today: "2026-10-02",
      start: "2026-10-05",
      end: "2026-09-28",
      error: "End date must be on or after start date.",
    },
  ],
};
