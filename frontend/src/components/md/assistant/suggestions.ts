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
