// Starter questions for the assistant, by the page the MD is on. Written the way an MD would ask, each one answerable
// from the data the assistant can read.

export type Suggestion = { text: string };

const GENERAL: string[] = [
  "Give me a briefing on how the company is doing today",
  "What needs my attention this week?",
  "How many people are on the payroll and what does it cost?",
];

const BY_PAGE: Record<string, string[]> = {
  dashboard: [
    "Give me a briefing on how the company is doing today",
    "What needs my attention this week?",
    "Which department has the highest absenteeism this month?",
    "Why did payroll change compared with last month?",
  ],
  "attendance-production": [
    "How is production attendance this week compared with last week?",
    "Which production shift has the lowest attendance?",
    "Who are the chronic absentees in production this month?",
    "How much overtime did production run this month?",
  ],
  branches: [
    "Compare my branches on attendance, lateness and overtime",
    "Which branch has the most absenteeism this month?",
    "Which branch has the highest attrition?",
    "How is headcount spread across the branches?",
  ],
  "geo-attendance": [
    "How many on-duty (geo) sessions were there this week?",
    "Which on-duty punches are waiting for verification?",
    "Who works outside the premises most often?",
    "Are there on-duty sessions that look unusual?",
  ],
  "attendance-search": [
    "How do punches reach the system, and how many are manual?",
    "Which employees have missing punches this month?",
    "Which devices recorded the fewest punches this week?",
    "Explain this employee's attendance this month",
  ],
  "report-log": [
    "Which attendance reports were generated this month, and by whom?",
    "How often are attendance reports produced?",
    "Who generates the most reports?",
  ],
  outpass: [
    "How many outpasses were taken this week compared with last week?",
    "Which employees take the most outpasses?",
    "How many working hours were lost to outpasses this month?",
    "Are any outpass requests waiting too long for approval?",
  ],
  shifts: [
    "How many people are assigned to each shift?",
    "Which employees have no shift assigned?",
    "Which shift or department is thinly covered?",
    "Did anyone change shifts recently?",
  ],
  leave: [
    "How much leave was taken this month, and in which departments?",
    "Who is on leave today and this week?",
    "Which leave types are used the most?",
    "When is the next holiday, and how does leave bunch around holidays?",
  ],
  requests: [
    "How many requests are waiting for a decision, and for how long?",
    "Which kind of request waits the longest?",
    "How fast are requests decided on average?",
    "Which requests have been waiting more than three days?",
  ],
  attendance: [
    "Why is absenteeism high in the worst department?",
    "Who are the chronic absentees this month?",
    "Compare this week's attendance with last week",
    "How much overtime did we run this month, and where?",
  ],
  employees: [
    "What is our attrition rate and where is it highest?",
    "How many people joined and left in the last 3 months?",
    "Which departments are below their required headcount?",
    "Who is completing 10 or more years this month?",
  ],
  visitors: [
    "How many visitors came this week compared with last week?",
    "Which employees take the most outpasses?",
    "How many hours were lost to outpasses this month?",
    "Are there outpass requests waiting too long for approval?",
  ],
  "tea-break": [
    "How much production time did tea breaks cost this week?",
    "Which department overruns tea breaks the most?",
    "Is tea-break discipline getting better or worse?",
    "What counts as a tea-break overrun?",
  ],
  payroll: [
    "Why did payroll change compared with last month?",
    "Which department costs the most per employee?",
    "How much did we spend on overtime last month?",
    "Are there any unusual salary slips this month?",
  ],
  reports: [
    "Which report shows overtime by department?",
    "Which report should I read for attrition?",
    "Summarise this month's key numbers",
  ],
  recruitment: [
    "How many positions are open and for how long?",
    "Where are candidates dropping out of the hiring funnel?",
    "Who has resigned recently and which departments are affected?",
    "Are we hiring fast enough to cover resignations?",
  ],
  activity: [
    "Were there any sensitive actions in the system this week?",
    "Who was active in the system after hours?",
    "Were there failed sign-in attempts recently?",
    "Which user made the most changes this month?",
  ],
};

export function suggestionsFor(page: string | null | undefined): string[] {
  return (page && BY_PAGE[page]) || GENERAL;
}
