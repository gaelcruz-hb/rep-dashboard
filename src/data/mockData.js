// ── CONSTANTS ─────────────────────────────────────────────────────────────────
export { MANAGERS, TEAMS, ALL_REPS } from './orgData';
import { MANAGERS, TEAMS, ALL_REPS } from './orgData';

export const CASE_SUBJECTS = [
  'Payroll Q1 Filing Failure','Tax Notice','Amended Filings','2023 W-2 Health Ins',
  'Cancel/Remove Request','FICA Withholding Refund','EDD Report Due','Q3 Failed Filing',
  'Jabdi Inc EDD Problem','Homebase Payroll Follow Up','Adjustment Completed',
  'Tax Refund Grocery Outlet','Harvest Drug & Gift','Urgent Action Required',
  'Multi-state Compliance','Garnishment Question','Direct Deposit Setup',
  'W-4 Update Request','Payroll Tax Filing','Benefits Enrollment',
];

export const CHANNELS   = ['Email','Chat','Phone','Messaging'];
export const ISSUE_TYPES = ['Payroll','Login/Auth','Tax Filing','Direct Deposit','Time Clock','Reports','Benefits','General'];
export const STATUSES    = ['Open','Pending','On Hold','New'];

// ── HELPERS ────────────────────────────────────────────────────────────────────
const rand  = (a, b)      => Math.floor(Math.random() * (b - a + 1)) + a;
const randF = (a, b, d=1) => parseFloat((Math.random() * (b - a) + a).toFixed(d));
const genId = ()           => '0' + Array.from({length:7}, () => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random()*36)]).join('');

function genCases(n) {
  return Array.from({length: n}, () => ({
    caseNum: '01' + rand(100000, 999999),
    sfId:    genId(),
    subject: CASE_SUBJECTS[rand(0, CASE_SUBJECTS.length - 1)],
    status:  STATUSES[rand(0, STATUSES.length - 1)],
    ageDays:      rand(1, 400),
    replyAgeDays: Math.random() < 0.4 ? rand(1, 60) : null,
    custWaitHrs:  rand(0, 200),
    hot:          Math.random() < 0.25,
    slaPct:       randF(50, 100),
    channel:      CHANNELS[rand(0, CHANNELS.length - 1)],
  }));
}

function getManager(name) {
  return Object.entries(MANAGERS).find(([, reps]) => reps.includes(name))?.[0] || 'Unknown';
}
function getTeam(name) {
  return Object.entries(TEAMS).find(([, reps]) => reps.includes(name))?.[0] || 'ECE';
}

export function genRepData(name) {
  const manager = getManager(name);
  const team    = getTeam(name);
  return {
    name, manager, team,
    // Case counts
    openCases:    rand(80, 400),
    pendingCases: rand(20, 150),
    holdCases:    rand(10, 100),
    newCases:     rand(1, 20),
    closedToday:  rand(2, 35),
    closedWeek:   rand(10, 120),
    closedLastWeek: rand(10, 120),
    newCasesWeek: rand(5, 60),
    // Response
    avgResponseHrs:    randF(0.5, 20),
    medianResponseHrs: randF(0.5, 15),
    slaMeetPct:        randF(70, 99),
    slaBreachCount:    rand(0, 15),
    slaRiskCount:      rand(0, 8),
    // Resolution
    avgTTRHrs:      rand(2, 72),
    medianTTRHrs:   rand(2, 48),
    reopenedPct:    randF(0, 12),
    escalated:      rand(0, 20),
    oldestCaseDays: rand(30, 400),
    // Activity
    newCasesToday: rand(1, 15),
    emailsToday:   rand(2, 18),
    emailsWeek:    rand(10, 80),
    transfers:     rand(0, 15),
    statusChanges: rand(5, 40),
    touchedCases:  rand(20, 100),
    untouchedCases: rand(5, 30),
    // Productivity (Talkdesk)
    availPct:     randF(40, 70),
    prodTimePct:  randF(50, 82),
    contactsHr:   randF(3, 9),
    ahtMin:       randF(8, 25),
    acwMin:       randF(1, 8),
    instascore:      rand(55, 98),
    fcrPct:          randF(60, 95),
    escalationRate:  randF(2, 25),
    // Cases detail
    cases: genCases(rand(80, 200)),
  };
}

// ── COACHING DATA ──────────────────────────────────────────────────────────────
const PLAN_STATUSES = ['Active', 'Completed', 'At Risk'];
const TRENDS        = ['↑ Improving', '↔ Flat', '↓ Declining'];

function genCoachingEntry(name) {
  const manager = getManager(name);
  return {
    name,
    manager,
    lastCoached:          rand(1, 14),
    sessionsThisWeek:     rand(0, 3),
    coachingDocsComplete: Math.random() > 0.3,
    onPlan:               Math.random() > 0.65,
    planStatus:           PLAN_STATUSES[rand(0, PLAN_STATUSES.length - 1)],
    planWeek:             rand(1, 6),
    trend:                TRENDS[rand(0, TRENDS.length - 1)],
  };
}

export const COACHING_DATA = ALL_REPS.map(genCoachingEntry);

// ── SEED DATA (stable for the session) ────────────────────────────────────────
export const REPS_DATA = ALL_REPS.map(genRepData);

// ── DAILY TREND (last 14 days) ─────────────────────────────────────────────────
export function genDailyTrend(min, max) {
  return Array.from({length: 14}, () => rand(min, max));
}

export const DAILY_CLOSED = genDailyTrend(80, 200);
export const DAILY_CREATED = genDailyTrend(70, 180);
export const DAILY_SLA_BREACHES = genDailyTrend(2, 30);
export const DAILY_LABELS = (() => {
  const labels = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    labels.push(d.toLocaleDateString('en-US', {month:'short', day:'numeric'}));
  }
  return labels;
})();

// Hourly new cases — today
export const HOURLY_LABELS = Array.from({length: 17}, (_, i) => `${i + 7}:00`);
export const HOURLY_CASES  = Array.from({length: 17}, () => rand(3, 35));

// ── GOALS DEFAULTS ─────────────────────────────────────────────────────────────
export const DEFAULT_GOALS = {
  closedDay:    15,
  responseHrs:  4,
  emailsDay:    20,
  maxOnHold:    30,
  maxOpen:      100,
  transferRate: 10,
  availPct:     55,
  prodPct:      70,
  contactsHr:   6,
  slaBreach:    24,
  instascore:   75,
  fcrPct:       80,
  totalPending: 500,
  avgHoldSec:   120,
};

// ── CHANNEL SESSION DATA ───────────────────────────────────────────────────────
const SESSION_TOPICS = ['Payroll Question','Login Help','Time Clock Issue','Benefits Question','Direct Deposit','Tax Filing','General Support','Report Access','MFA Reset','Payroll Run Help'];
const ENDED_BY_OPTIONS = ['Agent','End User','System'];

function genSessions(n, channel) {
  return Array.from({length: n}, () => {
    const daysAgo = rand(0, 6);
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return {
      id:               genId(),
      rep:              ALL_REPS[rand(0, ALL_REPS.length - 1)],
      channel,
      topic:            SESSION_TOPICS[rand(0, SESSION_TOPICS.length - 1)],
      waitMin:          randF(0, 15),
      ahtMin:           randF(5, 45),
      timeInSessionMin: randF(5, 50),
      acceptMin:        randF(0.1, 20),
      endedBy:          ENDED_BY_OPTIONS[rand(0, ENDED_BY_OPTIONS.length - 1)],
      date:             d.toLocaleDateString('en-US', {month:'short', day:'numeric'}),
      hot:              Math.random() < 0.15,
    };
  });
}

export const SESSION_DATA = [
  ...genSessions(40, 'Chat'),
  ...genSessions(40, 'Messaging'),
  ...genSessions(30, 'Phone'),
  ...genSessions(20, 'Email'),
];
