/**
 * Parse the 4 SOQL result sets from /api/channels-data into the shape
 * that Channels.jsx expects.
 *
 * Input shape:
 *   { volumeByDay, summary, endedBy, byAgent }  — each a SOQL query result
 *
 * Output shape:
 *   { totalChats, avgAccept, avgAHT, volumeTrend, endedBy, chatsByAgent, acceptByAgent }
 */
export function parseChannelsData(data) {
  if (!data?.summary) return null;

  const summaryRec = data.summary?.records?.[0] ?? {};

  const totalChats = summaryRec.cnt ?? 0;
  const avgAccept  = (summaryRec.avgWait ?? 0) / 60;  // seconds → minutes
  const avgAHT     = (summaryRec.avgDur  ?? 0) / 60;  // seconds → minutes

  // Volume trend: [{date, value}] oldest → newest
  const volumeTrend = (data.volumeByDay?.records ?? []).map(r => ({
    date:  String(r.day),
    value: r.cnt ?? 0,
  }));

  // Ended by: { 'Agent': N, 'End User': M, ... }
  const endedBy = {};
  for (const r of (data.endedBy?.records ?? [])) {
    if (r.EndedBy) endedBy[r.EndedBy] = r.cnt ?? 0;
  }

  // Chats by agent: { 'Full Name': cnt }
  const chatsByAgent = {};
  // Accept time by agent: { 'Full Name': avgWait (minutes) }
  const acceptByAgent = {};
  for (const r of (data.byAgent?.records ?? [])) {
    const name = r.Owner?.Name ?? r.OwnerId;
    if (!name || name === '-') continue;
    chatsByAgent[name]  = r.cnt ?? 0;
    acceptByAgent[name] = (r.avgWait ?? 0) / 60;
  }

  return {
    totalChats,
    avgAccept,
    avgAHT,
    volumeTrend,
    endedBy,
    chatsByAgent,
    acceptByAgent,
  };
}
