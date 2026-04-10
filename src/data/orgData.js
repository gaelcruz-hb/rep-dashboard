export const ORG = [
  {
    manager: 'Rose',
    teams: [
      { name: 'Chat Support Reps: Sales',     members: ['Aldrin Ege'] },
      { name: 'EE Hybrid',                    members: ['Sharlyn Chiong'] },
      { name: 'Payroll Support',              members: ['Euvince Arias', 'Jonnielyn Jane Sandoval'] },
      { name: 'Chat Support Reps: Non-Sales', members: ['Godrey Dugmoc', 'Clied Verano'] },
      { name: 'Inbound Reps',                 members: ['Jay-Ar Ordaniza', 'Hannah Vivien Inclino', 'Jerick Go'] },
    ],
  },
  {
    manager: 'Zee',
    teams: [
      { name: 'Inbound Reps',                 members: ['Pia Infante', 'Gricel Ramirez', 'Caine Yusay'] },
      { name: 'Chat Support Reps: Sales',     members: ['Mark Rodriguez', 'Trixy Alcoriza'] },
      { name: 'Chat Support Reps: Non-Sales', members: ['Rose Ann Dasig'] },
      { name: 'Payroll Support',              members: ['Leabeth Gutierrez', 'Mikaela Lopez'] },
    ],
  },
  {
    manager: 'Aldrin',
    teams: [
      { name: 'Hiring',                       members: ['Jomari Gutib'] },
      { name: 'Chat Support Reps: Non-Sales', members: ['Agnes Mae Elarcosa'] },
      { name: 'Inbound Reps',                 members: ['Aileen Facturan'] },
      { name: 'EE Hybrid',                    members: ['Regenlyn Mapa'] },
      { name: 'Payroll Support',              members: ['Lee Manikan'] },
    ],
  },
  {
    manager: 'Ian',
    teams: [
      { name: 'Payroll Implementation',       members: ['Irish Jane Nudo', 'Sweet April Rebutazo', 'David Larosa', 'Aljun Alcantara'] },
      { name: 'Chat Support Reps: Sales',     members: ['Stephanie Aira Bandico'] },
      { name: 'Chat Support Reps: Non-Sales', members: ['Nica Ann Margarita Felisilda'] },
      { name: 'Inbound Reps',                 members: ['Venus Morales'] },
      { name: 'Payroll Support',              members: ['Almyra Hernandez'] },
    ],
  },
  {
    manager: 'Yanaa',
    teams: [
      { name: 'Email',  members: ['Audrie Ambos', 'Jason Tugdang', 'Ken Claude Yusores', 'Jesa Centeno', 'Eric Nacilla'] },
      { name: 'Tier 2', members: ['Jin Rivera', 'Louie Jay Infante', 'Mary Facturan'] },
      { name: 'APS',    members: ['Ethelle Avecilla', 'Eric Manlapas', 'Evan Jelmer Calma'] },
      { name: 'QA',     members: ['Sharon Tinosan', 'Jingle Luyas', 'Jun Renquijo'] },
    ],
  },
  {
    manager: 'Karelyn',
    teams: [
      { name: 'Inbound Reps', members: [
        'Amber Henley', 'Courtney Whaley', 'Marcos Calero', 'Philip De Villa',
        'Rosalyn Lee', 'Shakilla Wright', 'Eric Herrera', 'David Nguyen', 'Angel Marquez', 'Gael Cruz',
        // active: false — not counted in HC
        { name: 'Lilly Hill', active: false },
      ]},
      { name: 'Chat Support Reps', members: ['Melissa Vega', 'Nicholas Morgan', 'Priscilla Casas'] },
      { name: 'Hiring',            members: ['Adams Adedeji', 'Michael Heistand'] },
    ],
  },
  {
    manager: 'Daniel',
    teams: [
      { name: 'APS',    members: ['Lily Lloyd', 'Ciara Roberts', 'Luis Salazar', 'Mazel Salazar'] },
      { name: 'Tier 2', members: ['Michael Nguyen', 'Cornelius Hyacinth', 'Andrew Sanchez'] },
    ],
  },
];

// ── Helpers to normalize members (handles string or {name, active} object) ────
export function getActiveMembers(team) {
  return team.members
    .map(m => (typeof m === 'string' ? { name: m, active: true } : m))
    .filter(m => m.active !== false)
    .map(m => m.name);
}

// ── Derived exports (backward-compatible with all existing imports) ────────────
export const MANAGERS = Object.fromEntries(
  ORG.map(m => [m.manager, m.teams.flatMap(getActiveMembers)])
);

export const TEAMS = ORG.reduce((acc, { teams }) => {
  for (const team of teams) {
    const active = getActiveMembers(team);
    acc[team.name] = [...(acc[team.name] ?? []), ...active];
  }
  return acc;
}, {});

export const ALL_REPS = [...new Set(Object.values(MANAGERS).flat())];
