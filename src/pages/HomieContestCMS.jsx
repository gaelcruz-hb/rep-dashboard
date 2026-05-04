import { useState, useEffect, useCallback } from 'react';

const API = '/api/contest';

// ── Castle theme ──────────────────────────────────────────────────────────────
const C = {
  bg: '#08091c', surface: '#0e1130', surface2: '#13163d',
  border: '#232650', borderGlow: '#3a3e70',
  gold: '#d4880e', goldDim: '#8a5a08', goldGlow: '#f0a030',
  blue: '#4a8ab5', blueDim: '#2a5070',
  red: '#c44828', redDim: '#6a2010',
  purple: '#8a5abf', purpleDim: '#4a2870',
  text: '#d8dcf0', muted: '#5a628a',
  green: '#2a8058', greenBright: '#38b07a',
  danger: '#c03828',
};
const HOUSE_COLOR  = { Grind: C.red,    Reign: C.blue,    Legacy: C.purple };
const HOUSE_DIM    = { Grind: C.redDim, Reign: C.blueDim, Legacy: C.purpleDim };
const HOUSE_EMOJI  = { Grind: '🔴', Reign: '🔵', Legacy: '🟣' };
const HOUSES       = ['Grind', 'Reign', 'Legacy'];
const BONUS_LABELS = { bounty_win: '⚔️ Bounty Win', fortress: '🏰 Fortress', daily_raid: '🌅 Daily Raid', discretionary: '✨ Discretionary', weekly_battle: '🏆 Weekly Battle' };
const BONUS_TYPES  = ['bounty_win', 'fortress', 'daily_raid', 'discretionary'];

const WEEK_RANGES = {
  1: { label: 'Week 1', dates: 'May 4–9',   start: '2026-05-04', end: '2026-05-09', section: 'OYI',        prize: 'Boba run' },
  2: { label: 'Week 2', dates: 'May 11–16', start: '2026-05-11', end: '2026-05-16', section: 'OYI',        prize: 'WFH Monday May 19' },
  3: { label: 'Week 3', dates: 'May 18–23', start: '2026-05-18', end: '2026-05-23', section: 'BCO',        prize: 'Movie tickets' },
  4: { label: 'Week 4', dates: 'May 26–29', start: '2026-05-26', end: '2026-05-29', section: 'In Service', prize: '$25 GC per rep' },
};

const MRR_GOALS = { Angel: 1050, Eric: 1050, Lois: 750, Stephen: 750, default: 1500 };

// ── Shared helpers ────────────────────────────────────────────────────────────
function apiFetch(path, method = 'GET', pin = null, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (pin) headers['x-contest-pin'] = pin;
  return fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
}

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Client-side point calculation mirrors server logic
function calcPts(entry) {
  if (!entry.attended) return 0;
  let pts = entry.onTime ? 1 : 0;
  pts += (entry.productivityPct ?? 0) >= 75 ? 5 : 0;
  const convos = entry.instascoreConvos ?? 0;
  const insta  = entry.instascorePct ?? 0;
  if (convos >= 5) { if (insta >= 80) pts += 3; else if (insta >= 70) pts += 2; }
  const u = entry.upgrades ?? {};
  pts += (u.anyToEssentials  ?? 0) * 1;
  pts += (u.essentialsToPlus ?? 0) * 2;
  pts += (u.essentialsToAio  ?? 0) * 4;
  pts += (u.plusToAio        ?? 0) * 2;
  pts += (u.basicToPlus      ?? 0) * 3;
  pts += (u.basicToAio       ?? 0) * 5;
  const a = entry.addons ?? {};
  pts += (a.hourlyPay   ?? 0) * 1;
  pts += (a.payrollPass ?? 0) * 2;
  return pts;
}

function calcHouseBonus(entries) {
  // entries: array of day entries for one house (same date)
  const present = entries.filter(e => e.attended);
  if (!present.length) return { prodBonus: 0, attBonus: 0 };
  const allProd = present.every(e => (e.productivityPct ?? 0) >= 75);
  const attRate  = present.length / entries.length;
  return { prodBonus: allProd ? 1 : 0, attBonus: attRate >= 0.9 ? 1 : 0 };
}

function emptyEntry() {
  return {
    attended: false, onTime: false,
    productivityPct: '', instascorePct: '', instascoreConvos: '', mrrDollars: '', fortressPct: '',
    upgrades: { anyToEssentials: '', essentialsToPlus: '', essentialsToAio: '', plusToAio: '', basicToPlus: '', basicToAio: '' },
    addons: { hourlyPay: '', payrollPass: '' },
    _expanded: false,
  };
}

function toPayload(entry) {
  const num = (v) => v === '' || v === undefined ? 0 : Number(v);
  const maybeNum = (v) => v === '' || v === undefined || v === null ? null : Number(v);
  return {
    attended: !!entry.attended,
    onTime: !!entry.onTime,
    productivityPct: num(entry.productivityPct),
    instascorePct: num(entry.instascorePct),
    instascoreConvos: num(entry.instascoreConvos),
    mrrDollars: num(entry.mrrDollars),
    fortressPct: maybeNum(entry.fortressPct),
    upgrades: {
      anyToEssentials:  num(entry.upgrades?.anyToEssentials),
      essentialsToPlus: num(entry.upgrades?.essentialsToPlus),
      essentialsToAio:  num(entry.upgrades?.essentialsToAio),
      plusToAio:        num(entry.upgrades?.plusToAio),
      basicToPlus:      num(entry.upgrades?.basicToPlus),
      basicToAio:       num(entry.upgrades?.basicToAio),
    },
    addons: {
      hourlyPay:    num(entry.addons?.hourlyPay),
      payrollPass:  num(entry.addons?.payrollPass),
    },
  };
}

function fromServer(serverDay) {
  if (!serverDay) return emptyEntry();
  return {
    attended: !!serverDay.attended,
    onTime: !!serverDay.onTime,
    productivityPct: serverDay.productivityPct ?? '',
    instascorePct: serverDay.instascorePct ?? '',
    instascoreConvos: serverDay.instascoreConvos ?? '',
    mrrDollars: serverDay.mrrDollars ?? '',
    fortressPct: serverDay.fortressPct ?? '',
    upgrades: {
      anyToEssentials:  serverDay.upgrades?.anyToEssentials  ?? '',
      essentialsToPlus: serverDay.upgrades?.essentialsToPlus ?? '',
      essentialsToAio:  serverDay.upgrades?.essentialsToAio  ?? '',
      plusToAio:        serverDay.upgrades?.plusToAio        ?? '',
      basicToPlus:      serverDay.upgrades?.basicToPlus      ?? '',
      basicToAio:       serverDay.upgrades?.basicToAio       ?? '',
    },
    addons: {
      hourlyPay:    serverDay.addons?.hourlyPay    ?? '',
      payrollPass:  serverDay.addons?.payrollPass  ?? '',
    },
    _expanded: false,
  };
}

// ── PIN Gate ──────────────────────────────────────────────────────────────────
function PinGate({ onUnlock }) {
  const [pin, setPin]     = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setLoading(true); setError('');
    const res = await fetch(`${API}/verify-pin`, { method: 'POST', headers: { 'x-contest-pin': pin } });
    setLoading(false);
    if (res.ok) onUnlock(pin);
    else { setError('Wrong PIN. The fortress doors remain sealed.'); setPin(''); }
  }

  return (
    <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: C.surface, border: `1px solid ${C.borderGlow}`, borderRadius: 16, padding: '2.5rem 2rem', width: 340, textAlign: 'center', boxShadow: `0 0 40px ${C.goldDim}55, 0 0 80px ${C.blueDim}33` }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>🏰</div>
        <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'DM Mono, monospace', color: C.goldGlow, marginBottom: 4 }}>Homie Hustlers</div>
        <div style={{ fontSize: 11, color: C.muted, fontFamily: 'DM Mono, monospace', marginBottom: 28 }}>May 4 – May 29 · CMS Access</div>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input type="password" placeholder="Enter PIN" value={pin} onChange={e => setPin(e.target.value)} autoFocus
            style={{ background: C.surface2, border: `1px solid ${C.border}`, color: C.text, fontFamily: 'DM Mono, monospace', borderRadius: 8, padding: '10px 16px', fontSize: 20, textAlign: 'center', letterSpacing: '0.3em', outline: 'none' }} />
          {error && <div style={{ color: C.danger, fontSize: 11, fontFamily: 'DM Mono, monospace' }}>{error}</div>}
          <button type="submit" disabled={loading || !pin}
            style={{ background: `linear-gradient(135deg, ${C.goldDim}, ${C.gold})`, color: '#08091c', fontWeight: 700, fontFamily: 'DM Mono, monospace', border: 'none', borderRadius: 8, padding: '10px 0', cursor: loading || !pin ? 'not-allowed' : 'pointer', opacity: loading || !pin ? 0.45 : 1, fontSize: 13 }}>
            {loading ? 'Checking…' : '⚔️ Enter the Fortress'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Shared input styles ───────────────────────────────────────────────────────
const inp = (extra = {}) => ({
  background: C.surface2, border: `1px solid ${C.border}`,
  color: C.text, fontFamily: 'DM Mono, monospace',
  borderRadius: 6, outline: 'none', ...extra,
});

// ── Small numeric input ───────────────────────────────────────────────────────
function Num({ value, onChange, width = 60, placeholder = '0', disabled }) {
  return (
    <input type="number" min="0" placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} disabled={disabled}
      style={{ ...inp(), width, padding: '5px 6px', fontSize: 12, textAlign: 'center', opacity: disabled ? 0.35 : 1 }} />
  );
}

// ── Tab bar ───────────────────────────────────────────────────────────────────
function Tabs({ active, setActive }) {
  const tabs = [
    { id: 'daily',   label: '📅 Daily Entry' },
    { id: 'battles', label: '⚔️ Weekly Battles' },
    { id: 'bonuses', label: '🎁 Bonuses' },
  ];
  return (
    <div style={{ display: 'flex', gap: 4, marginBottom: 24 }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => setActive(t.id)}
          style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, fontWeight: active === t.id ? 700 : 400, padding: '8px 18px', borderRadius: 8, border: `1px solid ${active === t.id ? C.goldGlow : C.border}`, background: active === t.id ? `${C.goldDim}40` : C.surface, color: active === t.id ? C.goldGlow : C.muted, cursor: 'pointer', transition: 'all 0.15s' }}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── Rep day entry row ─────────────────────────────────────────────────────────
function RepDayRow({ name, house, entry, onChange, onSave, saving, saved }) {
  const color = HOUSE_COLOR[house];
  const pts   = calcPts(toPayload(entry));
  const u     = entry.upgrades ?? {};
  const a     = entry.addons ?? {};

  function field(key, val) { onChange({ ...entry, [key]: val }); }
  function upg(key, val)   { onChange({ ...entry, upgrades: { ...u, [key]: val } }); }
  function adn(key, val)   { onChange({ ...entry, addons:   { ...a, [key]: val } }); }

  return (
    <div style={{ background: `${C.surface2}55`, border: `1px solid ${C.border}44`, borderRadius: 8, marginBottom: 6, overflow: 'hidden' }}>
      {/* Main row */}
      <div style={{ display: 'grid', gridTemplateColumns: '120px 50px 50px 72px 72px 54px 72px 54px 1fr auto auto', gap: 6, alignItems: 'center', padding: '10px 12px' }}>
        {/* Name */}
        <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, color: C.text, fontWeight: 600 }}>{name}</div>

        {/* Attended */}
        <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, cursor: 'pointer' }}>
          <span style={{ fontSize: 9, color: C.muted, fontFamily: 'DM Mono, monospace' }}>Attend</span>
          <input type="checkbox" checked={!!entry.attended} onChange={e => { onChange({ ...entry, attended: e.target.checked, onTime: e.target.checked ? entry.onTime : false }); }}
            style={{ width: 16, height: 16, accentColor: C.goldGlow, cursor: 'pointer' }} />
        </label>

        {/* On Time */}
        <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, cursor: entry.attended ? 'pointer' : 'not-allowed' }}>
          <span style={{ fontSize: 9, color: C.muted, fontFamily: 'DM Mono, monospace' }}>OnTime</span>
          <input type="checkbox" checked={!!entry.onTime} disabled={!entry.attended} onChange={e => field('onTime', e.target.checked)}
            style={{ width: 16, height: 16, accentColor: C.goldGlow, cursor: entry.attended ? 'pointer' : 'not-allowed', opacity: entry.attended ? 1 : 0.35 }} />
        </label>

        {/* Productivity */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 9, color: C.muted, fontFamily: 'DM Mono, monospace' }}>Prod %</span>
          <Num value={entry.productivityPct} onChange={v => field('productivityPct', v)} width={66} disabled={!entry.attended} />
        </div>

        {/* Instascore */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 9, color: C.muted, fontFamily: 'DM Mono, monospace' }}>Insta %</span>
          <Num value={entry.instascorePct} onChange={v => field('instascorePct', v)} width={66} disabled={!entry.attended} />
        </div>

        {/* Convos */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 9, color: C.muted, fontFamily: 'DM Mono, monospace' }}>Convos</span>
          <Num value={entry.instascoreConvos} onChange={v => field('instascoreConvos', v)} width={48} disabled={!entry.attended} />
        </div>

        {/* MRR $ */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 9, color: C.muted, fontFamily: 'DM Mono, monospace' }}>MRR $</span>
          <Num value={entry.mrrDollars} onChange={v => field('mrrDollars', v)} width={66} disabled={!entry.attended} />
        </div>

        {/* Fortress % */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 9, color: C.goldDim, fontFamily: 'DM Mono, monospace' }}>Fort %</span>
          <Num value={entry.fortressPct} onChange={v => field('fortressPct', v)} width={48} placeholder="—" disabled={!entry.attended} />
        </div>

        {/* Upgrade toggle */}
        <button onClick={() => field('_expanded', !entry._expanded)}
          style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: entry._expanded ? C.goldGlow : C.muted, background: entry._expanded ? `${C.goldDim}30` : 'transparent', border: `1px solid ${entry._expanded ? C.goldDim : C.border}`, borderRadius: 5, padding: '4px 8px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          Upgrades {entry._expanded ? '▲' : '▼'}
        </button>

        {/* Points badge */}
        <div style={{ textAlign: 'right', fontFamily: 'DM Mono, monospace', fontSize: 16, fontWeight: 700, color: pts > 0 ? C.goldGlow : C.muted, minWidth: 40 }}>
          {pts}<span style={{ fontSize: 9, color: C.muted, fontWeight: 400 }}> pts</span>
        </div>

        {/* Save */}
        {saved ? (
          <span style={{ fontSize: 10, color: C.greenBright, fontFamily: 'DM Mono, monospace', minWidth: 44 }}>✓ saved</span>
        ) : (
          <button onClick={onSave} disabled={saving}
            style={{ fontSize: 10, fontFamily: 'DM Mono, monospace', background: `${C.goldDim}30`, color: C.goldGlow, border: `1px solid ${C.goldDim}`, borderRadius: 5, padding: '5px 10px', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.5 : 1, minWidth: 44 }}>
            {saving ? '…' : 'Save'}
          </button>
        )}
      </div>

      {/* Upgrade / Add-on expansion */}
      {entry._expanded && (
        <div style={{ borderTop: `1px solid ${C.border}44`, padding: '10px 12px', background: `${C.surface}88`, display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {[
            { key: 'anyToEssentials',  label: '→ Essentials',      pts: 1 },
            { key: 'essentialsToPlus', label: 'Ess → Plus',  pts: 2 },
            { key: 'essentialsToAio',  label: 'Ess → AIO',  pts: 4 },
            { key: 'plusToAio',        label: 'Plus → AIO', pts: 2 },
            { key: 'basicToPlus',      label: 'Basic → Plus',       pts: 3 },
            { key: 'basicToAio',       label: 'Basic → AIO',        pts: 5 },
          ].map(({ key, label, pts: p }) => (
            <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' }}>
              <span style={{ fontSize: 9, color: C.muted, fontFamily: 'DM Mono, monospace', whiteSpace: 'nowrap' }}>{label} <span style={{ color: C.goldGlow }}>+{p}ea</span></span>
              <Num value={u[key]} onChange={v => upg(key, v)} width={52} disabled={!entry.attended} />
            </div>
          ))}
          <div style={{ width: 1, background: C.border, margin: '0 4px' }} />
          {[
            { key: 'hourlyPay',   label: 'Hourly Pay',   pts: 1 },
            { key: 'payrollPass', label: 'Payroll Pass',  pts: 2 },
          ].map(({ key, label, pts: p }) => (
            <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' }}>
              <span style={{ fontSize: 9, color: C.muted, fontFamily: 'DM Mono, monospace', whiteSpace: 'nowrap' }}>{label} <span style={{ color: C.greenBright }}>+{p}ea</span></span>
              <Num value={a[key]} onChange={v => adn(key, v)} width={52} disabled={!entry.attended} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Daily Entry Tab ───────────────────────────────────────────────────────────
const REP_HOUSES = {
  Grind:  ['Amber', 'Philip', 'Angel', 'Stephen', 'Priscilla'],
  Reign:  ['Nick', 'Eric', 'Courtney', 'Rosalyn'],
  Legacy: ['Melissa', 'David', 'Shakilla', 'Lois'],
};

function DailyEntryTab({ pin }) {
  const [date, setDate]       = useState(yesterday());
  const [entries, setEntries] = useState({});
  const [saving, setSaving]   = useState({});
  const [saved, setSaved]     = useState({});
  const [loading, setLoading] = useState(false);

  const allReps = HOUSES.flatMap(h => REP_HOUSES[h]);

  const loadDate = useCallback(async (d) => {
    setLoading(true);
    const results = await Promise.all(
      allReps.map(name =>
        apiFetch(`/reps/${name}/days/${d}`, 'GET', pin).then(res => [name, fromServer(res)])
      )
    );
    setEntries(Object.fromEntries(results));
    setLoading(false);
    setSaved({});
  }, [pin]);

  useEffect(() => { loadDate(date); }, [date]);

  function updateEntry(name, val) {
    setEntries(prev => ({ ...prev, [name]: val }));
  }

  async function saveRep(name) {
    setSaving(prev => ({ ...prev, [name]: true }));
    await apiFetch(`/reps/${name}/days/${date}`, 'PUT', pin, toPayload(entries[name]));
    setSaving(prev => ({ ...prev, [name]: false }));
    setSaved(prev => ({ ...prev, [name]: true }));
    setTimeout(() => setSaved(prev => ({ ...prev, [name]: false })), 2000);
  }

  async function saveAll(house) {
    const reps = REP_HOUSES[house];
    await Promise.all(reps.map(name => saveRep(name)));
  }

  return (
    <div>
      {/* Date picker */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, color: C.muted }}>Entering data for:</span>
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          style={{ ...inp(), padding: '7px 12px', fontSize: 13, color: C.text }} />
        {loading && <span style={{ fontSize: 11, color: C.muted, fontFamily: 'DM Mono, monospace' }}>Loading…</span>}
      </div>

      {/* Column headers */}
      <div style={{ display: 'grid', gridTemplateColumns: '120px 50px 50px 72px 72px 54px 72px 1fr auto auto', gap: 6, padding: '0 12px 6px', marginBottom: 4 }}>
        {['Rep', 'Attend', 'OnTime', 'Prod %', 'Insta %', 'Convos', 'MRR $', 'Upgrades', 'Pts', ''].map((h, i) => (
          <div key={i} style={{ fontFamily: 'DM Mono, monospace', fontSize: 9, color: C.muted, textAlign: i >= 8 ? 'right' : 'left', letterSpacing: '0.05em' }}>{h.toUpperCase()}</div>
        ))}
      </div>

      {/* Houses */}
      {HOUSES.map(house => {
        const color = HOUSE_COLOR[house];
        const dim   = HOUSE_DIM[house];
        const houseEntries = REP_HOUSES[house].map(n => entries[n] ? toPayload(entries[n]) : null).filter(Boolean);
        const { prodBonus, attBonus } = houseEntries.length ? calcHouseBonus(houseEntries) : { prodBonus: 0, attBonus: 0 };

        return (
          <div key={house} style={{ marginBottom: 20 }}>
            {/* House header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: `linear-gradient(90deg, ${dim}55, transparent)`, borderLeft: `3px solid ${color}`, borderRadius: '0 6px 6px 0', marginBottom: 8 }}>
              <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, fontWeight: 700, color }}>
                {HOUSE_EMOJI[house]} House {house}
                {(prodBonus > 0 || attBonus > 0) && (
                  <span style={{ marginLeft: 10, fontSize: 10, color: C.greenBright, fontWeight: 400 }}>
                    Team bonus: {prodBonus > 0 ? '+1 prod ' : ''}{attBonus > 0 ? '+1 attendance' : ''}(each rep)
                  </span>
                )}
              </div>
              <button onClick={() => saveAll(house)}
                style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color, background: `${dim}30`, border: `1px solid ${color}50`, borderRadius: 5, padding: '4px 12px', cursor: 'pointer' }}>
                Save All →
              </button>
            </div>

            {REP_HOUSES[house].map(name => (
              <RepDayRow
                key={name} name={name} house={house}
                entry={entries[name] ?? emptyEntry()}
                onChange={val => updateEntry(name, val)}
                onSave={() => saveRep(name)}
                saving={!!saving[name]} saved={!!saved[name]}
              />
            ))}
          </div>
        );
      })}

      {/* Point reference */}
      <details style={{ marginTop: 16 }}>
        <summary style={{ fontFamily: 'DM Mono, monospace', fontSize: 11, color: C.muted, cursor: 'pointer', userSelect: 'none' }}>📋 Point reference</summary>
        <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {[
            ['Attend + on time', '1 pt'],
            ['Productivity ≥ 75%', '5 pts'],
            ['Instascore ≥ 80% (5+ convos)', '3 pts'],
            ['Instascore 70–79% (5+ convos)', '2 pts'],
            ['Any → Essentials', '1 pt'],
            ['Essentials → Plus', '2 pts'],
            ['Plus → AIO', '2 pts'],
            ['Basic → Plus', '3 pts'],
            ['Basic → AIO', '5 pts'],
            ['Hourly Pay add-on', '1 pt'],
            ['Payroll Pass add-on', '2 pts'],
            ['Whole house prod ≥ 75%', '+1 each'],
            ['Whole house att ≥ 90%', '+1 each'],
          ].map(([rule, val]) => (
            <div key={rule} style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'DM Mono, monospace', fontSize: 10, color: C.muted, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 4, padding: '4px 8px' }}>
              <span>{rule}</span><span style={{ color: C.goldGlow }}>{val}</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

// ── Weekly Battles Tab ────────────────────────────────────────────────────────
function WeeklyBattlesTab({ pin }) {
  const [week, setWeek]     = useState(1);
  const [stats, setStats]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [awarding, setAwarding] = useState(false);
  const [fortressWinner, setFortressWinner] = useState('');
  const [fortressSaving, setFortressSaving] = useState(false);
  const [fortressSaved, setFortressSaved]   = useState(false);

  const load = useCallback(async (w) => {
    setLoading(true);
    const res = await apiFetch(`/weekly/${w}`, 'GET', pin);
    setStats(res);
    setFortressWinner(res.fortress ?? '');
    setLoading(false);
  }, [pin]);

  useEffect(() => { load(week); }, [week]);

  async function award() {
    if (!window.confirm(`Award Week ${week} battle bonuses (+5 pts per rep per battle won)?`)) return;
    setAwarding(true);
    await apiFetch(`/weekly/${week}/award`, 'POST', pin);
    await load(week);
    setAwarding(false);
  }

  async function revokeAward() {
    if (!window.confirm(`Remove Week ${week} battle bonuses from all reps? You can re-award them after.`)) return;
    setAwarding(true);
    await apiFetch(`/weekly/${week}/award`, 'DELETE', pin);
    await load(week);
    setAwarding(false);
  }

  async function saveFortress() {
    setFortressSaving(true);
    await apiFetch(`/weekly/${week}/fortress`, 'PUT', pin, { winner: fortressWinner || null });
    setFortressSaving(false);
    setFortressSaved(true);
    setTimeout(() => setFortressSaved(false), 2000);
  }

  const battles = [
    { key: 'goldRush',     label: '💰 Gold Rush',     metric: 'avgMrrPct',  fmt: v => `${v.toFixed(1)}%` },
    { key: 'hustleSprint', label: '⚡ Hustle Sprint',  metric: 'avgProd',    fmt: v => `${v.toFixed(1)}%` },
    { key: 'sharpshooter', label: '🎯 Sharpshooter',   metric: 'avgInsta',   fmt: v => `${v.toFixed(1)}%` },
    { key: 'attendance',   label: '✅ Attendance',     metric: 'avgAtt',     fmt: v => `${(v * 100).toFixed(1)}%` },
  ];

  return (
    <div>
      {/* Week selector */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        {[1, 2, 3, 4].map(w => {
          const wr = WEEK_RANGES[w];
          return (
            <button key={w} onClick={() => setWeek(w)}
              style={{ fontFamily: 'DM Mono, monospace', fontSize: 11, padding: '8px 16px', borderRadius: 8, border: `1px solid ${week === w ? C.goldGlow : C.border}`, background: week === w ? `${C.goldDim}40` : C.surface, color: week === w ? C.goldGlow : C.muted, cursor: 'pointer' }}>
              {wr.label}<br /><span style={{ fontSize: 9, opacity: 0.7 }}>{wr.dates}</span>
            </button>
          );
        })}
      </div>

      {loading ? (
        <div style={{ color: C.muted, fontFamily: 'DM Mono, monospace', fontSize: 12 }}>Loading…</div>
      ) : stats && (
        <>
          {/* Battle cards */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 }}>
            {battles.map(({ key, label, metric, fmt }) => {
              const winner = stats.winners[key];
              return (
                <div key={key} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16 }}>
                  <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, color: C.text, marginBottom: 10, fontWeight: 700 }}>{label} <span style={{ fontSize: 10, color: C.muted, fontWeight: 400 }}>+5 pts each</span></div>
                  {HOUSES.map(house => {
                    const val = stats.houseStats?.[house]?.[metric] ?? 0;
                    const isWinner = winner === house;
                    const color = HOUSE_COLOR[house];
                    return (
                      <div key={house} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 11, color, minWidth: 60 }}>{HOUSE_EMOJI[house]} {house}</span>
                        <div style={{ flex: 1, height: 6, background: `${color}22`, borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${Math.min(100, val * (metric === 'avgAtt' ? 100 : 1))}%`, background: color, borderRadius: 3 }} />
                        </div>
                        <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 11, color: isWinner ? C.goldGlow : C.muted, fontWeight: isWinner ? 700 : 400, minWidth: 48, textAlign: 'right' }}>
                          {fmt(val)} {isWinner ? '🏆' : ''}
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* Award / Revoke */}
          {stats.awarded ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 16px', background: `${C.green}22`, border: `1px solid ${C.green}44`, borderRadius: 8, marginBottom: 20 }}>
              <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, color: C.greenBright }}>
                ✓ Week {week} battle bonuses have been awarded.
              </span>
              <button onClick={revokeAward} disabled={awarding}
                style={{ fontFamily: 'DM Mono, monospace', fontSize: 11, fontWeight: 700, background: `${C.danger}22`, color: C.danger, border: `1px solid ${C.danger}55`, borderRadius: 6, padding: '6px 14px', cursor: awarding ? 'not-allowed' : 'pointer', opacity: awarding ? 0.5 : 1, whiteSpace: 'nowrap' }}>
                {awarding ? '…' : '🗑 Remove Award'}
              </button>
            </div>
          ) : (
            <button onClick={award} disabled={awarding}
              style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, fontWeight: 700, background: `linear-gradient(135deg, ${C.goldDim}, ${C.gold})`, color: '#08091c', border: 'none', borderRadius: 8, padding: '10px 24px', cursor: awarding ? 'not-allowed' : 'pointer', opacity: awarding ? 0.5 : 1, marginBottom: 20 }}>
              {awarding ? '…' : `⚔️ Award Week ${week} Battle Bonuses (+5 pts per winner)`}
            </button>
          )}

          {/* Fortress */}
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16 }}>
            <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, color: C.text, fontWeight: 700, marginBottom: 4 }}>
              🏯 Fortress — {WEEK_RANGES[week].section}
            </div>
            <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 11, color: C.muted, marginBottom: 12 }}>
              Prize: <span style={{ color: C.goldGlow }}>{WEEK_RANGES[week].prize}</span> · No KP added
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select value={fortressWinner} onChange={e => setFortressWinner(e.target.value)}
                style={{ ...inp(), padding: '7px 12px', fontSize: 12 }}>
                <option value="">— No winner yet —</option>
                {HOUSES.map(h => <option key={h} value={h}>{HOUSE_EMOJI[h]} House {h}</option>)}
              </select>
              <button onClick={saveFortress} disabled={fortressSaving}
                style={{ fontFamily: 'DM Mono, monospace', fontSize: 11, background: `${C.green}30`, color: C.greenBright, border: `1px solid ${C.green}50`, borderRadius: 6, padding: '7px 16px', cursor: 'pointer', opacity: fortressSaving ? 0.5 : 1 }}>
                {fortressSaved ? '✓ Saved' : 'Save Fortress'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Bonuses Tab ───────────────────────────────────────────────────────────────
function BonusList({ bonuses, onRemove }) {
  if (!bonuses.length) return <div style={{ color: C.muted, fontSize: 11, fontFamily: 'DM Mono, monospace', fontStyle: 'italic' }}>No bonuses yet</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {bonuses.map(b => (
        <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 6, padding: '7px 12px', fontFamily: 'DM Mono, monospace', fontSize: 11 }}>
          <span style={{ color: C.goldGlow, minWidth: 110 }}>{BONUS_LABELS[b.type] ?? b.type}</span>
          <span style={{ color: C.greenBright, fontWeight: 700 }}>+{b.amount} pts</span>
          <span style={{ color: C.text, flex: 1 }}>{b.note}</span>
          <span style={{ color: C.muted }}>{b.date}</span>
          <button onClick={() => onRemove(b.id)} style={{ color: C.danger, background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 }}>✕</button>
        </div>
      ))}
    </div>
  );
}

function AddBonusForm({ onAdd }) {
  const [type, setType]     = useState('discretionary');
  const [amount, setAmount] = useState('');
  const [note, setNote]     = useState('');
  const [date, setDate]     = useState(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    await onAdd({ type, amount: Number(amount), note, date });
    setSaving(false);
    setAmount(''); setNote('');
  }

  const fieldStyle = { ...inp(), padding: '6px 10px', fontSize: 11, borderRadius: 6 };
  return (
    <form onSubmit={submit} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end', marginTop: 8 }}>
      <select value={type} onChange={e => setType(e.target.value)} style={{ ...fieldStyle, cursor: 'pointer' }}>
        {BONUS_TYPES.map(t => <option key={t} value={t}>{BONUS_LABELS[t]}</option>)}
      </select>
      <input type="number" placeholder="pts" value={amount} onChange={e => setAmount(e.target.value)} required style={{ ...fieldStyle, width: 64, textAlign: 'center' }} />
      <input type="text" placeholder="note" value={note} onChange={e => setNote(e.target.value)} style={{ ...fieldStyle, flex: 1, minWidth: 140 }} />
      <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ ...fieldStyle }} />
      <button type="submit" disabled={saving || !amount}
        style={{ background: `${C.green}30`, color: C.greenBright, border: `1px solid ${C.green}50`, borderRadius: 6, padding: '6px 14px', fontSize: 11, fontFamily: 'DM Mono, monospace', cursor: saving || !amount ? 'not-allowed' : 'pointer', opacity: saving || !amount ? 0.4 : 1 }}>
        {saving ? '…' : '+ Add'}
      </button>
    </form>
  );
}

function BonusesTab({ pin }) {
  const [data, setData]           = useState(null);
  const [expandedRep, setExpandedRep]     = useState(null);
  const [expandedHouse, setExpandedHouse] = useState(null);

  const load = useCallback(() => apiFetch('').then(setData), []);
  useEffect(() => { load(); }, []);

  async function removeRepBonus(name, id) { await apiFetch(`/reps/${name}/bonuses/${id}`, 'DELETE', pin); load(); }
  async function removeHouseBonus(name, id) { await apiFetch(`/houses/${name}/bonuses/${id}`, 'DELETE', pin); load(); }
  async function addRepBonus(name, body)   { await apiFetch(`/reps/${name}/bonuses`, 'POST', pin, body); load(); }
  async function addHouseBonus(name, body) { await apiFetch(`/houses/${name}/bonuses`, 'POST', pin, body); load(); }

  if (!data) return <div style={{ color: C.muted, fontFamily: 'DM Mono, monospace', fontSize: 12 }}>Loading…</div>;

  const allReps = HOUSES.flatMap(h => REP_HOUSES[h]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Individual */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ padding: '14px 20px', borderBottom: `1px solid ${C.border}`, background: `${C.surface2}88` }}>
          <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 13, fontWeight: 700, color: C.text }}>🐉 Individual Bonuses</div>
          <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 10, color: C.muted, marginTop: 2 }}>Dragon/Sword bounties, daily raid recognition, discretionary</div>
        </div>
        {allReps.map(name => {
          const rep   = data.reps.find(r => r.name === name);
          const house = Object.entries(REP_HOUSES).find(([, members]) => members.includes(name))?.[0];
          const isOpen = expandedRep === name;
          return (
            <div key={name} style={{ borderBottom: `1px solid ${C.border}44` }}>
              <button onClick={() => setExpandedRep(isOpen ? null : name)}
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                onMouseEnter={e => e.currentTarget.style.background = `${C.surface2}66`}
                onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, color: C.text }}>{name}</span>
                  <span style={{ fontSize: 9, fontFamily: 'DM Mono, monospace', fontWeight: 700, color: HOUSE_COLOR[house], background: `${HOUSE_COLOR[house]}18`, border: `1px solid ${HOUSE_COLOR[house]}40`, borderRadius: 4, padding: '2px 6px' }}>{house?.toUpperCase()}</span>
                  {rep?.bonuses?.length > 0 && <span style={{ fontSize: 10, color: C.greenBright, fontFamily: 'DM Mono, monospace' }}>+{rep.breakdown?.manual ?? 0} pts · {rep.bonuses.length} bonus{rep.bonuses.length !== 1 ? 'es' : ''}</span>}
                </div>
                <span style={{ fontSize: 9, color: C.muted }}>{isOpen ? '▲' : '▼'}</span>
              </button>
              {isOpen && (
                <div style={{ padding: '4px 20px 16px' }}>
                  <BonusList bonuses={rep?.bonuses ?? []} onRemove={id => removeRepBonus(name, id)} />
                  <AddBonusForm onAdd={body => addRepBonus(name, body)} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* House */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ padding: '14px 20px', borderBottom: `1px solid ${C.border}`, background: `${C.surface2}88` }}>
          <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 13, fontWeight: 700, color: C.text }}>🏯 House Bonuses</div>
        </div>
        {HOUSES.map(house => {
          const h = data.houses.find(x => x.name === house);
          const isOpen = expandedHouse === house;
          return (
            <div key={house} style={{ borderBottom: `1px solid ${C.border}44` }}>
              <button onClick={() => setExpandedHouse(isOpen ? null : house)}
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                onMouseEnter={e => e.currentTarget.style.background = `${C.surface2}66`}
                onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, fontWeight: 700, color: HOUSE_COLOR[house] }}>{HOUSE_EMOJI[house]} House {house}</span>
                  {h?.bonuses?.length > 0 && <span style={{ fontSize: 10, color: C.greenBright, fontFamily: 'DM Mono, monospace' }}>+{h.bonusTotal} pts · {h.bonuses.length} bonus{h.bonuses.length !== 1 ? 'es' : ''}</span>}
                </div>
                <span style={{ fontSize: 9, color: C.muted }}>{isOpen ? '▲' : '▼'}</span>
              </button>
              {isOpen && (
                <div style={{ padding: '4px 20px 16px' }}>
                  <BonusList bonuses={h?.bonuses ?? []} onRemove={id => removeHouseBonus(house, id)} />
                  <AddBonusForm onAdd={body => addHouseBonus(house, body)} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main CMS ──────────────────────────────────────────────────────────────────
function CMS({ pin }) {
  const [tab, setTab] = useState('daily');

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text }}>
      <div style={{ maxWidth: 1060, margin: '0 auto', padding: '32px 24px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'DM Mono, monospace', color: C.goldGlow }}>🏰 Homie Hustlers — CMS</div>
            <div style={{ fontSize: 10, color: C.muted, fontFamily: 'DM Mono, monospace', marginTop: 4 }}>May 4 – May 29 · Hustle & Conquer</div>
          </div>
          <a href="/homie-contest"
            style={{ fontSize: 11, fontFamily: 'DM Mono, monospace', color: C.muted, border: `1px solid ${C.border}`, borderRadius: 6, padding: '7px 14px', textDecoration: 'none' }}
            onMouseEnter={e => e.target.style.color = C.goldGlow}
            onMouseLeave={e => e.target.style.color = C.muted}>
            ← Dashboard
          </a>
        </div>

        <Tabs active={tab} setActive={setTab} />

        {tab === 'daily'   && <DailyEntryTab  pin={pin} />}
        {tab === 'battles' && <WeeklyBattlesTab pin={pin} />}
        {tab === 'bonuses' && <BonusesTab     pin={pin} />}
      </div>
    </div>
  );
}

// ── Page entry ────────────────────────────────────────────────────────────────
export function HomieContestCMS() {
  const [pin, setPin] = useState(null);
  if (!pin) return <PinGate onUnlock={setPin} />;
  return <CMS pin={pin} />;
}
