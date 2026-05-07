import { ORG } from './orgData.js';

const CALL_TEAMS  = new Set(['Inbound Reps']);
const CHAT_TEAMS  = new Set(['Chat Support Reps: Sales', 'Chat Support Reps: Non-Sales', 'Chat Support Reps']);
const MIXED_TEAMS = new Set(['EE Hybrid']);

export function getRepChannelType(repName) {
  for (const { teams } of ORG) {
    for (const team of teams) {
      const members = team.members.map(m => typeof m === 'string' ? m : m.name);
      if (members.includes(repName)) {
        if (CALL_TEAMS.has(team.name))  return 'calls';
        if (CHAT_TEAMS.has(team.name))  return 'chats';
        if (MIXED_TEAMS.has(team.name)) return 'mixed';
        return 'chats';
      }
    }
  }
  return 'calls';
}
