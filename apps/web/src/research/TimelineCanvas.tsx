'use client';

/**
 * p の時系列のライブ図（I2）。canvas に軽く描く。
 *  - 描き直すのは props（表示内容。useResearchFeed が 500ms ごと、タブが見えている間だけ作る）が変わったときと、
 *    幅が変わったときだけ。requestAnimationFrame で回し続けない（MaAI と CPU を取り合わないため）。
 *  - p の添字は direction.p_ai_index で選ぶ。vad は契約どおり [0]=利用者（mic）、[1]=AI（sys）。
 *  - 色だけに頼らない: AI は実線、利用者は破線。帯にも行の名前を書く。
 */
import { useEffect, useRef, useState } from 'react';
import styles from './research.module.css';
import { splitByAiIndex, splitVad, type TimelineView, type VapSample } from './timeline';
import type { DirectionInfo } from './view_store';

const LEFT = 104;
const RIGHT = 12;
const LANE_P = 74;
const LANE_VAD = 56;
const LANE_GAP = 14;
const BAND_H = 14;
const BAND_GAP = 6;
const AXIS_H = 22;

const BANDS = ['AI の発話', '利用者の発話', '発話の許可', '出来事'] as const;

interface Layout {
  width: number;
  height: number;
  lanes: { name: string; top: number; height: number; key: 'p_now' | 'p_future' | 'vad' }[];
  bandsTop: number;
  axisTop: number;
}

function layout(width: number): Layout {
  let y = 8;
  const lanes: Layout['lanes'] = [];
  for (const [key, name, h] of [
    ['p_now', 'p_now', LANE_P],
    ['p_future', 'p_future', LANE_P],
    ['vad', 'vad', LANE_VAD],
  ] as const) {
    lanes.push({ key, name, top: y, height: h });
    y += h + LANE_GAP;
  }
  const bandsTop = y;
  y += BANDS.length * (BAND_H + BAND_GAP);
  return { width, height: y + AXIS_H, lanes, bandsTop, axisTop: y };
}

function readColors(el: HTMLElement) {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    surface: v('--card', '#ffffff'),
    text: v('--muted', '#646a73'),
    grid: v('--line', '#dcdedf'),
    ai: v('--series-ai', '#2a78d6'),
    user: v('--series-user', '#eb6834'),
    allowed: v('--series-allowed', '#1baf7a'),
    gaze: v('--series-gaze', '#6250d6'),
    initiative: v('--series-initiative', '#eda100'),
    interrupt: v('--series-interrupt', '#e34948'),
  };
}

function sampleValues(s: VapSample, key: 'p_now' | 'p_future' | 'vad', direction: DirectionInfo): { ai: number | null; user: number } {
  if (s.layout === '1ch') return { ai: null, user: s[key] };
  return key === 'vad' ? splitVad(s.vad) : splitByAiIndex(s[key], direction.p_ai_index);
}

function draw(canvas: HTMLCanvasElement, view: TimelineView, direction: DirectionInfo, width: number): void {
  const L = layout(width);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(L.width * dpr);
  canvas.height = Math.round(L.height * dpr);
  canvas.style.height = `${L.height}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const c = readColors(canvas);
  ctx.fillStyle = c.surface;
  ctx.fillRect(0, 0, L.width, L.height);
  ctx.font = '12px system-ui, sans-serif';
  ctx.textBaseline = 'middle';

  const plotW = Math.max(10, L.width - LEFT - RIGHT);
  const now = view.now_ms;
  const from = now === null ? 0 : now - view.window_ms;
  const x = (t: number) => LEFT + ((t - from) / view.window_ms) * plotW;
  const clampX = (t: number) => Math.min(LEFT + plotW, Math.max(LEFT, x(t)));

  // 縦の目盛り（10 秒ごと）
  ctx.strokeStyle = c.grid;
  ctx.lineWidth = 1;
  ctx.fillStyle = c.text;
  ctx.textAlign = 'center';
  for (let s = 0; s <= view.window_ms / 1000; s += 10) {
    const px = LEFT + plotW - (s * 1000 * plotW) / view.window_ms;
    ctx.beginPath();
    ctx.moveTo(px, 4);
    ctx.lineTo(px, L.axisTop);
    ctx.stroke();
    ctx.fillText(s === 0 ? '最新' : `−${s}s`, px, L.axisTop + AXIS_H / 2);
  }

  // 割り込みは全段を貫く細い縦線
  for (const m of view.marks) {
    if (m.kind !== 'interrupt' || now === null) continue;
    ctx.strokeStyle = c.interrupt;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x(m.t), 4);
    ctx.lineTo(x(m.t), L.axisTop);
    ctx.stroke();
  }

  for (const lane of L.lanes) {
    const y = (v: number) => lane.top + (1 - v) * lane.height;
    ctx.textAlign = 'left';
    ctx.fillStyle = c.text;
    ctx.fillText(lane.name, 8, lane.top + lane.height / 2);
    ctx.strokeStyle = c.grid;
    ctx.lineWidth = 1;
    for (const v of [0, 0.5, 1]) {
      ctx.beginPath();
      ctx.setLineDash(v === 0.5 ? [2, 3] : []);
      ctx.moveTo(LEFT, y(v));
      ctx.lineTo(LEFT + plotW, y(v));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.textAlign = 'right';
    ctx.fillText('1', LEFT - 6, y(1));
    ctx.fillText('0', LEFT - 6, y(0));
    if (view.vap.length === 0) continue;
    for (const who of ['user', 'ai'] as const) {
      ctx.strokeStyle = who === 'ai' ? c.ai : c.user;
      ctx.lineWidth = 2;
      ctx.setLineDash(who === 'ai' ? [] : [6, 4]);
      ctx.beginPath();
      let started = false;
      let prevT = -Infinity;
      for (const s of view.vap) {
        const value = sampleValues(s, lane.key, direction)[who];
        if (value === null) continue;
        // 1 秒以上の欠けは線で結ばない（欠損を隠さない）。
        if (!started || s.t - prevT > 1000) ctx.moveTo(x(s.t), y(value));
        else ctx.lineTo(x(s.t), y(value));
        started = true;
        prevT = s.t;
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // 帯
  const bandY = (i: number) => L.bandsTop + i * (BAND_H + BAND_GAP);
  ctx.textAlign = 'left';
  BANDS.forEach((name, i) => {
    ctx.fillStyle = c.text;
    ctx.fillText(name, 8, bandY(i) + BAND_H / 2);
    ctx.strokeStyle = c.grid;
    ctx.strokeRect(LEFT, bandY(i), plotW, BAND_H);
  });
  if (now !== null) {
    const span = (row: number, start: number, end: number | null, color: string) => {
      const a = clampX(start);
      const b = clampX(end ?? now);
      if (b - a < 0.5) return;
      ctx.fillStyle = color;
      ctx.fillRect(a, bandY(row) + 1, Math.max(1, b - a - 2), BAND_H - 2);
    };
    for (const s of view.ai_speech) span(0, s.start, s.end, c.ai);
    for (const s of view.user_speech) span(1, s.start, s.end, c.user);
    for (const s of view.turn_allowed) if (s.allowed) span(2, s.start, s.end, c.allowed);
    for (const m of view.marks) {
      const px = x(m.t);
      if (px < LEFT || px > LEFT + plotW) continue;
      const cy = bandY(3) + BAND_H / 2;
      ctx.fillStyle = m.kind === 'gaze' ? c.gaze : m.kind === 'initiative' ? c.initiative : c.interrupt;
      ctx.beginPath();
      if (m.kind === 'gaze') {
        ctx.arc(px, cy, 4, 0, Math.PI * 2);
      } else if (m.kind === 'initiative') {
        ctx.moveTo(px, cy - 5);
        ctx.lineTo(px + 5, cy);
        ctx.lineTo(px, cy + 5);
        ctx.lineTo(px - 5, cy);
        ctx.closePath();
      } else {
        ctx.rect(px - 1.5, bandY(0), 3, BAND_H * 4 + BAND_GAP * 3);
      }
      ctx.fill();
    }
  }
}

function hoverText(view: TimelineView, direction: DirectionInfo, t: number): string {
  let best: VapSample | null = null;
  for (const s of view.vap) if (best === null || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
  const rel = view.now_ms === null ? 0 : (t - view.now_ms) / 1000;
  const marks = view.marks.filter((m) => Math.abs(m.t - t) < 400).map((m) => m.label);
  const ai = view.ai_speech.find((s) => s.start <= t && (s.end ?? Infinity) >= t);
  const allowed = [...view.turn_allowed].reverse().find((s) => s.start <= t);
  const parts = [`${rel.toFixed(1)}s`];
  if (best === null || Math.abs(best.t - t) > 500) parts.push('VAP なし');
  else if (best.layout === '1ch') parts.push(`1ch p_now ${best.p_now.toFixed(2)} p_future ${best.p_future.toFixed(2)} vad ${best.vad.toFixed(2)}`);
  else {
    const pn = splitByAiIndex(best.p_now, direction.p_ai_index);
    const pf = splitByAiIndex(best.p_future, direction.p_ai_index);
    const vd = splitVad(best.vad);
    parts.push(`p_now AI ${pn.ai.toFixed(2)} / 利用者 ${pn.user.toFixed(2)}`);
    parts.push(`p_future AI ${pf.ai.toFixed(2)} / 利用者 ${pf.user.toFixed(2)}`);
    parts.push(`vad AI ${vd.ai.toFixed(2)} / 利用者 ${vd.user.toFixed(2)}`);
  }
  if (ai) parts.push(`AI 発話中（id ${ai.audio_playback_id}, ${ai.origin}）`);
  if (allowed) parts.push(`許可 ${allowed.allowed ? 'あり' : 'なし'}（${allowed.source}）`);
  parts.push(...marks);
  return parts.join(' · ');
}

export function TimelineCanvas({ view, direction }: { view: TimelineView; direction: DirectionInfo }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(() => setWidth(Math.floor(wrap.clientWidth)));
    observer.observe(wrap);
    setWidth(Math.floor(wrap.clientWidth));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    draw(canvas, view, direction, width);
  }, [view, direction, width]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (view.now_ms === null) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const plotW = Math.max(10, width - LEFT - RIGHT);
    const px = e.clientX - rect.left;
    if (px < LEFT || px > LEFT + plotW) {
      setHover(null);
      return;
    }
    const t = view.now_ms - view.window_ms + ((px - LEFT) / plotW) * view.window_ms;
    setHover(hoverText(view, direction, t));
  };

  return (
    <div ref={wrapRef} className={styles.timelineWrap}>
      <canvas
        ref={canvasRef}
        className={styles.timelineCanvas}
        data-testid="p-timeline"
        role="img"
        aria-label="p_now、p_future、vad と発話区間の時系列"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      />
      <p className={styles.note} data-testid="timeline-hover">
        {hover ?? '図の上にポインタを置くと、その時刻の値が出ます。'}
      </p>
    </div>
  );
}
