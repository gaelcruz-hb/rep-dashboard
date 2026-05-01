import { useEffect, useRef, useState } from 'react';
import {
  Chart as ChartJS, CategoryScale, LinearScale,
  BarElement, Title, Tooltip, Legend,
} from 'chart.js';
import { Bar } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

const API = import.meta.env.PROD ? '' : 'http://localhost:3001';

// ── Theme ──────────────────────────────────────────────────────────────────────
const HOUSES = ['Grind', 'Reign', 'Legacy'];
const HOUSE = {
  Grind:  { main: '#FF3B3B', dim: '#FF7070', bg: 'rgba(255,59,59,0.12)',  glow: 'rgba(255,59,59,0.3)',  emoji: '🔴', label: 'House Grind',  reps: 'Amber · Philip · Angel · Stephen · Priscilla' },
  Reign:  { main: '#3B8BFF', dim: '#7AB0FF', bg: 'rgba(59,139,255,0.12)', glow: 'rgba(59,139,255,0.3)', emoji: '🔵', label: 'House Reign',  reps: 'Nick · Eric · Courtney · Rosalyn' },
  Legacy: { main: '#B03BFF', dim: '#CF80FF', bg: 'rgba(176,59,255,0.12)', glow: 'rgba(176,59,255,0.3)', emoji: '🟣', label: 'House Legacy', reps: 'Melissa · David · Shakilla · Lois' },
};
const WEEK_CONFIG = {
  1: { label: 'Week 1', badge: 'WEEK 1 · OYI FORTRESS', dates: 'May 4–9',   fortressName: 'Own Your Impact',      prize: 'Boba Run ☕',       goal: 0  },
  2: { label: 'Week 2', badge: 'WEEK 2 · OYI FORTRESS', dates: 'May 11–16', fortressName: 'Own Your Impact',      prize: 'WFH Day 🏠',        goal: 75 },
  3: { label: 'Week 3', badge: 'WEEK 3 · BCO FORTRESS', dates: 'May 18–23', fortressName: 'Be Customer Obsessed', prize: 'Movie Tickets 🎬',  goal: 0  },
  4: { label: 'Week 4', badge: 'WEEK 4 · IN SERVICE',   dates: 'May 26–29', fortressName: 'In Service',           prize: '$25 GC Each 💰',   goal: 0  },
};
const RANK = ['👑', '🥈', '🥉'];
const PARTICLE_COLORS = ['#FFE500','#FFF176','#FF3B3B','#3B8BFF','#C03BFF','#DF90FF','#ffffff'];

// ── Animated background ────────────────────────────────────────────────────────
function AnimatedBg() {
  const pfRef = useRef(null);
  useEffect(() => {
    const pf = pfRef.current;
    if (!pf) return;
    for (let i = 0; i < 45; i++) {
      const p = document.createElement('div');
      const sz = Math.random() * 4 + 1;
      const color = PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)];
      const dur = Math.random() * 18 + 12;
      const delay = Math.random() * 12;
      p.style.cssText = `position:absolute;border-radius:50%;width:${sz}px;height:${sz}px;left:${Math.random()*100}%;background:${color};opacity:${Math.random()*0.5+0.15};animation:hc-float ${dur}s ${delay}s linear infinite;${Math.random()>0.7?`box-shadow:0 0 ${sz*3}px ${color};`:''}`;
      pf.appendChild(p);
    }
    return () => { while (pf.firstChild) pf.removeChild(pf.firstChild); };
  }, []);

  return (
    <>
      <style>{`
        @keyframes hc-float {
          0%   { transform: translateY(100vh) scale(0); opacity: 0; }
          10%  { opacity: 1; }
          90%  { opacity: 0.3; }
          100% { transform: translateY(-100px) scale(1); opacity: 0; }
        }
        @keyframes hc-scan { 0%,100%{opacity:0.3} 50%{opacity:1} }
        @keyframes hc-ride {
          0%   { transform: translateY(-100%) rotate(-1deg); }
          25%  { transform: translateY(-112%) rotate(2deg) scaleX(1.04); }
          50%  { transform: translateY(-100%) rotate(-1deg) scaleX(0.97); }
          75%  { transform: translateY(-108%) rotate(1deg); }
          100% { transform: translateY(-100%) rotate(-1deg); }
        }
        @keyframes hc-lead-glow {
          0%,100% { box-shadow: 0 0 0 0 rgba(255,229,0,0), 0 0 0 0 rgba(180,100,255,0); }
          50%     { box-shadow: 0 0 20px 0 rgba(255,229,0,0.2), 0 0 40px 0 rgba(180,100,255,0.1); }
        }
        @keyframes hc-goal-blink { 0%,100%{opacity:0.5} 50%{opacity:1} }
        @keyframes hc-card-pulse-y { 0%,100%{box-shadow:0 0 0 rgba(255,229,0,0)} 50%{box-shadow:0 0 16px rgba(255,229,0,0.15)} }
        @keyframes hc-card-pulse-b { 0%,100%{box-shadow:0 0 0 rgba(59,139,255,0)} 50%{box-shadow:0 0 16px rgba(59,139,255,0.15)} }
        @keyframes hc-card-pulse-g { 0%,100%{box-shadow:0 0 0 rgba(34,211,90,0)} 50%{box-shadow:0 0 16px rgba(34,211,90,0.15)} }
      `}</style>
      <div style={{ position: 'fixed', inset: 0, zIndex: 0, background: `
        radial-gradient(ellipse 140% 70% at 50% -10%, #4A1A9E 0%, transparent 50%),
        radial-gradient(ellipse 60% 50% at 0% 50%, rgba(192,59,255,0.2) 0%, transparent 55%),
        radial-gradient(ellipse 60% 50% at 100% 50%, rgba(255,229,0,0.08) 0%, transparent 55%),
        radial-gradient(ellipse 50% 40% at 0% 100%, rgba(255,59,59,0.1) 0%, transparent 50%),
        radial-gradient(ellipse 50% 40% at 100% 100%, rgba(59,139,255,0.1) 0%, transparent 50%),
        #130328`
      }} />
      <div style={{ position: 'fixed', inset: 0, zIndex: 1, backgroundImage: 'linear-gradient(rgba(180,100,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(180,100,255,0.06) 1px, transparent 1px)', backgroundSize: '44px 44px', pointerEvents: 'none' }} />
      <div ref={pfRef} style={{ position: 'fixed', inset: 0, zIndex: 1, overflow: 'hidden', pointerEvents: 'none' }} />
      <div style={{ position: 'fixed', inset: 0, zIndex: 2, background: 'radial-gradient(ellipse 90% 90% at 50% 50%, transparent 40%, rgba(19,3,40,0.5) 100%)', pointerEvents: 'none' }} />
      <div style={{ position: 'fixed', top: -100, left: -100, width: 300, height: 300, background: 'radial-gradient(circle, rgba(192,59,255,0.15) 0%, transparent 70%)', zIndex: 2, pointerEvents: 'none' }} />
      <div style={{ position: 'fixed', bottom: -100, right: -100, width: 300, height: 300, background: 'radial-gradient(circle, rgba(255,229,0,0.08) 0%, transparent 70%)', zIndex: 2, pointerEvents: 'none' }} />
      <div style={{ position: 'fixed', top: -100, right: -100, width: 200, height: 200, background: 'radial-gradient(circle, rgba(59,139,255,0.1) 0%, transparent 70%)', zIndex: 2, pointerEvents: 'none' }} />
    </>
  );
}

// ── Header ─────────────────────────────────────────────────────────────────────
function Header({ week }) {
  const wc = WEEK_CONFIG[week];
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 0 20px 0', flexWrap: 'wrap', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ background: '#FFE500', color: '#1F0A45', fontFamily: "'Bebas Neue', sans-serif", fontSize: '0.85rem', padding: '3px 14px', borderRadius: 4, letterSpacing: 2 }}>homebase</div>
        <div style={{ fontFamily: "'Cinzel Decorative', serif", fontSize: '1.7rem', lineHeight: 1, letterSpacing: 2, textShadow: '0 0 40px rgba(180,100,255,0.6), 0 0 80px rgba(255,229,0,0.2)' }}>
          <span style={{ color: '#FFE500', textShadow: '0 0 30px rgba(255,229,0,0.8)' }}>Hustle</span>
          <span style={{ color: 'rgba(255,255,255,0.9)' }}> & </span>
          <span style={{ color: '#CF80FF', textShadow: '0 0 30px rgba(192,59,255,0.8)' }}>Conquer</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <div style={{ background: 'rgba(255,229,0,0.08)', border: '1px solid rgba(255,229,0,0.25)', color: '#FFE500', fontFamily: "'Barlow', sans-serif", fontWeight: 800, fontSize: '0.6rem', letterSpacing: 2, padding: '4px 12px', borderRadius: 4, textTransform: 'uppercase' }}>
          {wc.badge}
        </div>
        <div style={{ fontFamily: "'Barlow', sans-serif", fontWeight: 600, fontSize: '0.6rem', color: 'rgba(255,255,255,0.55)', letterSpacing: 1 }}>
          {wc.dates} · May 4 – 29, 2026
        </div>
      </div>
    </div>
  );
}

// ── Week tabs ──────────────────────────────────────────────────────────────────
function WeekTabs({ week, setWeek }) {
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
      {[1, 2, 3, 4].map(w => {
        const active = week === w;
        return (
          <button key={w} onClick={() => setWeek(w)} style={{
            fontFamily: "'Barlow', sans-serif", fontWeight: 800, fontSize: '0.7rem',
            letterSpacing: 1, textTransform: 'uppercase', padding: '7px 18px',
            borderRadius: 6, border: `1px solid ${active ? 'rgba(255,229,0,0.5)' : 'rgba(255,255,255,0.1)'}`,
            background: active ? 'rgba(255,229,0,0.1)' : 'rgba(255,255,255,0.03)',
            color: active ? '#FFE500' : 'rgba(255,255,255,0.45)', cursor: 'pointer',
            transition: 'all 0.15s',
          }}>
            {WEEK_CONFIG[w].label}
            <span style={{ fontWeight: 400, opacity: 0.7, fontSize: '0.55rem', display: 'block', letterSpacing: 0.5 }}>{WEEK_CONFIG[w].dates}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Daily Raid section ─────────────────────────────────────────────────────────
function DailyRaidSection({ dailyRaid }) {
  const cards = [
    { key: 'mrr',    cat: '💰 MRR King/Queen', scoreColor: '#FFE500', borderColor: 'rgba(255,229,0,0.25)',   bg: 'rgba(255,229,0,0.06)',  anim: 'hc-card-pulse-y 4s ease-in-out infinite',    placeholder: '💰' },
    { key: 'hustle', cat: '⚡ Hustle Award',    scoreColor: '#7AB0FF', borderColor: 'rgba(59,139,255,0.25)', bg: 'rgba(59,139,255,0.06)', anim: 'hc-card-pulse-b 4s ease-in-out infinite 1s', placeholder: '⚡' },
    { key: 'sharp',  cat: '🎯 Sharpshooter',   scoreColor: '#7EFFA8', borderColor: 'rgba(34,211,90,0.25)',  bg: 'rgba(34,211,90,0.06)',  anim: 'hc-card-pulse-g 4s ease-in-out infinite 2s', placeholder: '🎯' },
  ];

  return (
    <div style={{
      background: 'linear-gradient(135deg, rgba(255,229,0,0.06) 0%, rgba(192,59,255,0.06) 100%)',
      border: '1px solid rgba(255,229,0,0.35)', borderRadius: 12, padding: '14px 16px',
      position: 'relative',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'linear-gradient(90deg, transparent, #FFE500, transparent)', animation: 'hc-scan 3s ease-in-out infinite', borderRadius: '12px 12px 0 0' }} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: '1.05rem', letterSpacing: 4, color: '#FFE500' }}>⚡ YESTERDAY'S DAILY RAID WINNERS</div>
        <div style={{ fontFamily: "'Barlow', sans-serif", fontSize: '0.55rem', fontWeight: 600, color: 'rgba(255,255,255,0.55)', letterSpacing: 1 }}>
          {dailyRaid?.date ? `DATA FROM ${dailyRaid.date.toUpperCase()}` : 'NO DATA YET · ENTER DAILY STATS IN CMS'}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        {cards.map(({ key, cat, scoreColor, borderColor, bg, anim, placeholder }) => {
          const winner = dailyRaid?.[key];
          const houseInfo = winner ? HOUSE[winner.house] : null;
          return (
            <div key={key} style={{ borderRadius: 10, padding: '12px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, background: bg, border: `1px solid ${borderColor}`, animation: anim }}>
              <div style={{ fontFamily: "'Barlow', sans-serif", fontWeight: 800, fontSize: '0.5rem', letterSpacing: 2, textTransform: 'uppercase', color: scoreColor }}>{cat}</div>
              <div style={{ width: 60, height: 60, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Bebas Neue', sans-serif", fontSize: '1.3rem', background: `${scoreColor}22`, border: `3px solid ${scoreColor}`, boxShadow: `0 0 16px ${scoreColor}55`, color: scoreColor }}>
                {winner ? winner.name.slice(0, 2).toUpperCase() : placeholder}
              </div>
              <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: '1.1rem', letterSpacing: 2, textAlign: 'center', lineHeight: 1.1, color: '#fff' }}>
                {winner ? winner.name : '—'}
              </div>
              {houseInfo && (
                <div style={{ fontFamily: "'Barlow', sans-serif", fontWeight: 700, fontSize: '0.5rem', letterSpacing: 1, padding: '2px 8px', borderRadius: 4, background: houseInfo.bg, color: houseInfo.dim }}>
                  {houseInfo.emoji} {winner.house}
                </div>
              )}
              <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: '1.4rem', letterSpacing: 1, textAlign: 'center', lineHeight: 1, color: scoreColor, textShadow: `0 0 12px ${scoreColor}88` }}>
                {winner ? winner.value : '—'}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Race track ─────────────────────────────────────────────────────────────────
function RaceTrack({ weeklyKp }) {
  const max = Math.max(...HOUSES.map(h => weeklyKp?.[h] ?? 0), 1);
  const FILL_BG = {
    Grind:  'linear-gradient(90deg, #7f1d1d, #FF3B3B)',
    Reign:  'linear-gradient(90deg, #1e3a8a, #3B8BFF)',
    Legacy: 'linear-gradient(90deg, #4c1d95, #B03BFF)',
  };
  return (
    <div style={{ background: 'linear-gradient(180deg, rgba(180,100,255,0.07) 0%, rgba(42,10,94,0.5) 100%)', border: '1px solid rgba(180,100,255,0.3)', borderRadius: 12, padding: '12px 16px' }}>
      <div style={{ fontFamily: "'Barlow', sans-serif", fontWeight: 800, fontSize: '0.55rem', letterSpacing: 3, textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)', marginBottom: 10 }}>
        🏇 WEEKLY RACE — KINGDOM POINTS THIS WEEK
      </div>
      {HOUSES.map((house, idx) => {
        const h = HOUSE[house];
        const kp = weeklyKp?.[house] ?? 0;
        const pct = max > 0 ? Math.max((kp / max) * 100, kp > 0 ? 3 : 0) : 0;
        return (
          <div key={house} style={{ display: 'grid', gridTemplateColumns: '150px 1fr 90px', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: idx < HOUSES.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
            <div>
              <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: '0.9rem', letterSpacing: 2, color: h.dim }}>{h.emoji} {house.toUpperCase()}</div>
              <div style={{ fontFamily: "'Barlow', sans-serif", fontSize: '0.48rem', color: 'rgba(255,255,255,0.2)', marginTop: 2, letterSpacing: 0.3 }}>{h.reps}</div>
            </div>
            <div style={{ position: 'relative', height: 32, background: 'rgba(255,255,255,0.04)', borderRadius: 4 }}>
              <div style={{ height: '100%', borderRadius: 4, width: `${pct}%`, background: FILL_BG[house], boxShadow: `4px 0 16px ${h.glow}`, position: 'relative', transition: 'width 1.8s cubic-bezier(0.34,1.1,0.64,1)', minWidth: kp > 0 ? 6 : 0 }}>
                {kp > 0 && (
                  <div style={{ position: 'absolute', right: -28, top: '50%', transform: 'translateY(-60%)', fontSize: '1.6rem', lineHeight: 1, animation: 'hc-ride 1.8s ease-in-out infinite', filter: 'drop-shadow(0 4px 8px rgba(0,0,0,0.6))', pointerEvents: 'none' }}>
                    🐴
                  </div>
                )}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: '1.5rem', color: '#FFE500', textShadow: '0 0 12px rgba(255,229,0,0.4)', lineHeight: 1 }}>{kp}</div>
              <span style={{ fontFamily: "'Barlow', sans-serif", fontWeight: 700, fontSize: '0.44rem', color: 'rgba(255,229,0,0.45)', letterSpacing: 2, textTransform: 'uppercase' }}>This Week</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Fortress panel ─────────────────────────────────────────────────────────────
function FortressPanel({ week, fortressData }) {
  const wc = WEEK_CONFIG[week];
  return (
    <div style={{ background: 'linear-gradient(135deg, rgba(61,20,128,0.6) 0%, rgba(30,6,80,0.8) 100%)', border: '1px solid rgba(180,100,255,0.25)', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontFamily: "'Barlow', sans-serif", fontWeight: 800, fontSize: '0.55rem', letterSpacing: 3, textTransform: 'uppercase', color: '#FFE500', paddingBottom: 6, borderBottom: '1px solid rgba(255,229,0,0.1)' }}>
        🏰 Fortress Battle
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontSize: '1.2rem' }}>⚔️</div>
        <div>
          <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: '1rem', letterSpacing: 2, color: '#fff' }}>{wc.fortressName}</div>
          <div style={{ fontFamily: "'Barlow', sans-serif", fontSize: '0.57rem', color: 'rgba(255,255,255,0.55)' }}>Prize: {wc.prize}</div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {HOUSES.map(house => {
          const h = HOUSE[house];
          const pct = fortressData?.[house];
          const hasPct = pct != null;
          const barPct = hasPct ? Math.min(pct, 100) : 0;
          return (
            <div key={house} style={{ display: 'grid', gridTemplateColumns: '56px 1fr 42px', alignItems: 'center', gap: 8 }}>
              <div style={{ fontFamily: "'Barlow', sans-serif", fontWeight: 800, fontSize: '0.58rem', letterSpacing: 1, color: h.dim }}>{house.toUpperCase()}</div>
              <div style={{ height: 11, background: 'rgba(255,255,255,0.05)', borderRadius: 3, overflow: 'hidden', position: 'relative' }}>
                <div style={{ height: '100%', width: `${barPct}%`, borderRadius: 3, background: h.main, boxShadow: `2px 0 8px ${h.glow}`, transition: 'width 1.3s ease' }} />
                {wc.goal > 0 && (
                  <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${wc.goal}%`, width: 2, background: '#FFE500', opacity: 0.7, animation: 'hc-goal-blink 2s ease-in-out infinite' }} />
                )}
              </div>
              <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: '0.75rem', textAlign: 'right', color: h.dim }}>{hasPct ? `${pct}%` : '—'}</div>
            </div>
          );
        })}
      </div>
      {wc.goal > 0 && (
        <div style={{ fontFamily: "'Barlow', sans-serif", fontWeight: 700, fontSize: '0.44rem', color: 'rgba(255,229,0,0.45)', letterSpacing: 1.5, textTransform: 'uppercase', textAlign: 'right' }}>
          Yellow line = {wc.goal}% goal · Cross it to conquer 🏆
        </div>
      )}
    </div>
  );
}

// ── Attendance panel ───────────────────────────────────────────────────────────
function AttendancePanel({ attendanceData }) {
  return (
    <div style={{ background: 'linear-gradient(135deg, rgba(61,20,128,0.6) 0%, rgba(30,6,80,0.8) 100%)', border: '1px solid rgba(180,100,255,0.25)', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={{ fontFamily: "'Barlow', sans-serif", fontWeight: 800, fontSize: '0.52rem', letterSpacing: 2, textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)' }}>✅ Attendance — Goal 95%</div>
      {HOUSES.map(house => {
        const h = HOUSE[house];
        const pct = attendanceData?.[house];
        const hasPct = pct != null;
        const ok = hasPct && pct >= 95;
        return (
          <div key={house} style={{ display: 'grid', gridTemplateColumns: '54px 1fr 44px', alignItems: 'center', gap: 8 }}>
            <div style={{ fontFamily: "'Barlow', sans-serif", fontWeight: 800, fontSize: '0.58rem', letterSpacing: 1, color: h.dim }}>{house.toUpperCase()}</div>
            <div style={{ height: 9, background: 'rgba(255,255,255,0.05)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${hasPct ? Math.min(pct, 100) : 0}%`, borderRadius: 3, background: ok ? '#22D35A' : '#FF3B3B', boxShadow: ok ? '2px 0 8px rgba(34,211,90,0.4)' : 'none', transition: 'width 1.2s ease' }} />
            </div>
            <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: '0.72rem', textAlign: 'right', color: ok ? '#7EFFA8' : '#FF8080' }}>{hasPct ? `${pct}%` : '—'}</div>
          </div>
        );
      })}
    </div>
  );
}

// ── Bounty panel ───────────────────────────────────────────────────────────────
function BountyPanel({ houses }) {
  const allBounties = (houses ?? []).flatMap(h =>
    (h.bonuses ?? []).filter(b => b.type === 'bounty_win').map(b => ({ ...b, houseName: h.name }))
  );
  const dragon = allBounties.findLast(b => (b.note ?? '').toLowerCase().includes('dragon') || (b.note ?? '').toLowerCase().includes('mrr'));
  const sword  = allBounties.findLast(b => (b.note ?? '').toLowerCase().includes('sword') || (b.note ?? '').toLowerCase().includes('insta'));
  const remaining = allBounties.filter(b => b !== dragon && b !== sword).slice(-1);

  const cards = [
    dragon && { icon: '🐉', type: 'Dragon Bounty · Most Improved MRR',        ...dragon, borderColor: 'rgba(251,146,60,0.2)', bg: 'rgba(251,146,60,0.07)', typeColor: '#FB923C' },
    sword  && { icon: '⚔️', type: 'Sword Bounty · Most Improved Instascore',   ...sword,  borderColor: 'rgba(59,139,255,0.2)', bg: 'rgba(59,139,255,0.07)', typeColor: '#7AB0FF' },
    ...remaining.map(b => ({ icon: '🏆', type: 'Bounty Win', ...b, borderColor: 'rgba(255,229,0,0.2)', bg: 'rgba(255,229,0,0.04)', typeColor: '#FFE500' })),
  ].filter(Boolean);

  return (
    <div style={{ background: 'linear-gradient(135deg, rgba(61,20,128,0.6) 0%, rgba(30,6,80,0.8) 100%)', border: '1px solid rgba(180,100,255,0.25)', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={{ fontFamily: "'Barlow', sans-serif", fontWeight: 800, fontSize: '0.55rem', letterSpacing: 3, textTransform: 'uppercase', color: '#FFE500', paddingBottom: 6, borderBottom: '1px solid rgba(255,229,0,0.1)' }}>
        🏆 Bounty Winners
      </div>
      {cards.length === 0 ? (
        <div style={{ fontFamily: "'Barlow', sans-serif", fontWeight: 700, fontSize: '0.52rem', color: 'rgba(255,255,255,0.18)', letterSpacing: 2, textAlign: 'center', padding: '8px 0', textTransform: 'uppercase' }}>
          Announced Monday · Compete All Week
        </div>
      ) : (
        cards.map((b, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, border: `1px solid ${b.borderColor}`, background: b.bg }}>
            <div style={{ fontSize: '1.3rem', flexShrink: 0 }}>{b.icon}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "'Barlow', sans-serif", fontWeight: 800, fontSize: '0.46rem', letterSpacing: 2, textTransform: 'uppercase', color: b.typeColor }}>{b.type}</div>
              <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: '0.9rem', letterSpacing: 1, color: '#fff' }}>{b.note || '—'}</div>
            </div>
            <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: '0.9rem', color: '#7EFFA8', flexShrink: 0 }}>+{b.amount} KP</div>
          </div>
        ))
      )}
    </div>
  );
}

// ── Monthly standings ──────────────────────────────────────────────────────────
function MonthlyStandings({ houses }) {
  const sorted = [...(houses ?? [])].sort((a, b) => b.grandTotal - a.grandTotal);
  return (
    <div style={{ background: 'linear-gradient(135deg, rgba(61,20,128,0.6) 0%, rgba(30,6,80,0.8) 100%)', border: '1px solid rgba(180,100,255,0.25)', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={{ fontFamily: "'Barlow', sans-serif", fontWeight: 800, fontSize: '0.55rem', letterSpacing: 3, textTransform: 'uppercase', color: '#FFE500', paddingBottom: 6, borderBottom: '1px solid rgba(255,229,0,0.1)' }}>
        👑 Kingdom Standings — Monthly
      </div>
      {sorted.map((h, i) => {
        const hInfo = HOUSE[h.name];
        const isLead = i === 0 && h.grandTotal > 0;
        return (
          <div key={h.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, border: `1px solid ${isLead ? 'rgba(255,229,0,0.2)' : 'rgba(255,255,255,0.05)'}`, background: isLead ? 'rgba(255,229,0,0.04)' : 'rgba(255,255,255,0.02)', animation: isLead ? 'hc-lead-glow 3s ease-in-out infinite' : 'none' }}>
            <div style={{ fontSize: '1.1rem', width: 26, textAlign: 'center', flexShrink: 0 }}>{RANK[i] ?? '🏠'}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: '0.85rem', letterSpacing: 1.5, color: hInfo?.dim }}>{hInfo?.emoji} {h.name.toUpperCase()}</div>
              <div style={{ fontFamily: "'Barlow', sans-serif", fontSize: '0.48rem', color: 'rgba(255,255,255,0.18)', marginTop: 1 }}>{hInfo?.reps}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: '1.3rem', color: '#FFE500', lineHeight: 1 }}>{h.grandTotal}</div>
              <span style={{ fontFamily: "'Barlow', sans-serif", fontWeight: 700, fontSize: '0.4rem', color: 'rgba(255,229,0,0.45)', letterSpacing: 1.5, display: 'block', textTransform: 'uppercase' }}>Total KP</span>
            </div>
          </div>
        );
      })}
      <div style={{ textAlign: 'center', marginTop: 2 }}>
        <div style={{ fontFamily: "'Barlow', sans-serif", fontWeight: 700, fontSize: '0.44rem', color: 'rgba(255,255,255,0.15)', letterSpacing: 2, textTransform: 'uppercase' }}>May 4 – 29, 2026 · 20 Selling Days</div>
      </div>
    </div>
  );
}

// ── Metric breakdown bar chart ────────────────────────────────────────────────
const SEGMENTS = [
  { key: 'upgrades',     label: '💰 Upgrades',     color: '#FFE500' },
  { key: 'productivity', label: '⚡ Productivity',  color: '#3B8BFF' },
  { key: 'instascore',   label: '🎯 Instascore',   color: '#22D35A' },
  { key: 'addons',       label: '➕ Add-ons',       color: '#FB923C' },
  { key: 'attendance',   label: '✅ Attendance',    color: '#a78bfa' },
  { key: 'houseBonus',   label: '🏠 House Bonus',  color: '#FF7070' },
  { key: 'manual',       label: '🎁 Bonuses',       color: '#CF80FF' },
];

function MetricBreakdown({ reps }) {
  if (!reps?.length) return null;

  // Sort: group by house, within each house sort by total desc
  const order = ['Grind', 'Reign', 'Legacy'];
  const sorted = [...reps].sort((a, b) => {
    const hi = order.indexOf(a.house) - order.indexOf(b.house);
    return hi !== 0 ? hi : b.total - a.total;
  });

  const labels = sorted.map(r => {
    const h = HOUSE[r.house];
    return `${h?.emoji ?? ''} ${r.name}`;
  });

  const datasets = SEGMENTS.map(seg => ({
    label: seg.label,
    data: sorted.map(r => r.breakdown?.[seg.key] ?? 0),
    backgroundColor: seg.color + 'cc',
    hoverBackgroundColor: seg.color,
    borderWidth: 0,
    borderRadius: 2,
  }));

  const data = { labels, datasets };

  const options = {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 800 },
    plugins: {
      legend: {
        position: 'top',
        labels: {
          color: 'rgba(255,255,255,0.7)',
          font: { family: "'Barlow', sans-serif", size: 11, weight: '700' },
          boxWidth: 12, boxHeight: 12, padding: 16,
        },
      },
      tooltip: {
        backgroundColor: 'rgba(13,5,32,0.95)',
        borderColor: 'rgba(255,229,0,0.2)',
        borderWidth: 1,
        titleFont: { family: "'Bebas Neue', sans-serif", size: 14 },
        bodyFont: { family: "'Barlow', sans-serif", size: 12 },
        titleColor: '#FFE500',
        bodyColor: 'rgba(255,255,255,0.85)',
        callbacks: {
          title: items => items[0].label,
          label: item => ` ${item.dataset.label}: ${item.parsed.x} KP`,
          footer: items => {
            const rep = sorted[items[0].dataIndex];
            return `Total: ${rep.total} KP`;
          },
        },
      },
    },
    scales: {
      x: {
        stacked: true,
        grid: { color: 'rgba(255,255,255,0.06)', drawBorder: false },
        ticks: { color: 'rgba(255,255,255,0.4)', font: { family: "'Barlow', sans-serif", size: 10 } },
        border: { color: 'transparent' },
      },
      y: {
        stacked: true,
        grid: { display: false },
        ticks: {
          color: 'rgba(255,255,255,0.75)',
          font: { family: "'Barlow', sans-serif", size: 11, weight: '700' },
          padding: 6,
        },
        border: { color: 'transparent' },
      },
    },
  };

  const chartH = Math.max(sorted.length * 34 + 60, 200);

  return (
    <div style={{ background: 'linear-gradient(135deg, rgba(61,20,128,0.5) 0%, rgba(30,6,80,0.7) 100%)', border: '1px solid rgba(180,100,255,0.25)', borderRadius: 12, padding: '14px 18px', marginTop: 12 }}>
      <div style={{ fontFamily: "'Barlow', sans-serif", fontWeight: 800, fontSize: '0.55rem', letterSpacing: 3, textTransform: 'uppercase', color: '#FFE500', paddingBottom: 12, borderBottom: '1px solid rgba(255,229,0,0.1)', marginBottom: 14 }}>
        📊 Individual KP Breakdown — All Time
      </div>
      <div style={{ height: chartH }}>
        <Bar data={data} options={options} />
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export function HomieContest() {
  const [week, setWeek] = useState(1);
  const [contestData, setContestData] = useState(null);
  const [weeklyData, setWeeklyData] = useState(null);
  const [loadingWeekly, setLoadingWeekly] = useState(false);

  useEffect(() => {
    function fetchContest() {
      fetch(`${API}/api/contest`)
        .then(r => r.json())
        .then(d => setContestData(d))
        .catch(err => console.error('[contest]', err));
    }
    fetchContest();
    const t = setInterval(fetchContest, 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    setLoadingWeekly(true);
    fetch(`${API}/api/contest/weekly/${week}`)
      .then(r => r.json())
      .then(d => { setWeeklyData(d); setLoadingWeekly(false); })
      .catch(err => { console.error('[weekly]', err); setLoadingWeekly(false); });
  }, [week]);

  const dailyRaid  = contestData?.dailyRaid ?? null;
  const houses     = contestData?.houses ?? [];
  const reps       = contestData?.reps ?? [];
  const weeklyKp   = weeklyData?.weeklyKp ?? {};
  const fortress   = weeklyData?.fortress ?? {};
  const attendance = weeklyData?.attendance ?? {};

  return (
    <div style={{ minHeight: '100vh', background: '#0D0520', color: '#fff', fontFamily: "'Barlow', sans-serif", position: 'relative' }}>
      <AnimatedBg />
      <div style={{ position: 'relative', zIndex: 10, padding: '16px 20px', maxWidth: 1400, margin: '0 auto' }}>
        <Header week={week} />
        <WeekTabs week={week} setWeek={setWeek} />

        {loadingWeekly && (
          <div style={{ fontFamily: "'Barlow', sans-serif", fontWeight: 700, fontSize: '0.6rem', color: 'rgba(255,229,0,0.5)', letterSpacing: 3, textTransform: 'uppercase', textAlign: 'center', marginBottom: 12 }}>
            Loading week {week}…
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1.55fr 1fr', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <DailyRaidSection dailyRaid={dailyRaid} />
            <RaceTrack weeklyKp={weeklyKp} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <FortressPanel week={week} fortressData={fortress} />
            <AttendancePanel attendanceData={attendance} />
            <BountyPanel houses={houses} />
            <MonthlyStandings houses={houses} />
          </div>
        </div>

        <MetricBreakdown reps={reps} />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, padding: '8px 2px' }}>
          <div style={{ fontFamily: "'Barlow', sans-serif", fontWeight: 700, fontSize: '0.48rem', color: 'rgba(255,255,255,0.18)', letterSpacing: 2, textTransform: 'uppercase' }}>Hustle & Conquer · May 2026</div>
          <div style={{ background: '#FFE500', color: '#1F0A45', fontFamily: "'Bebas Neue', sans-serif", fontSize: '0.75rem', padding: '3px 14px', borderRadius: 4, letterSpacing: 2 }}>homebase</div>
          <div style={{ fontFamily: "'Barlow', sans-serif", fontWeight: 700, fontSize: '0.48rem', color: 'rgba(255,255,255,0.18)', letterSpacing: 1 }}>Show up · Close deals · Stay productive · Apply your coaching</div>
        </div>
      </div>
    </div>
  );
}
