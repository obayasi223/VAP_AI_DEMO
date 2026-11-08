'use client';

/**
 * 調整画面の時系列の図（canvas）。段（lane）に系列と閾値の線、帯（band）に区間と印を描く。
 * 色だけに頼らない: AI は実線、利用者は破線、閾値は点線に名前を添える。ポインタの位置の値は図の下に文字で出す。
 * 描き直すのは props か幅が変わったときだけ（rAF で回し続けない。MaAI と CPU を取り合わないため）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import styles from './tune.module.css';
import { CHART_COLORS } from './chart_spec';

export { CHART_COLORS };

export interface ChartSeries {
  label: string;
  points: readonly (readonly [number, number])[];
  color: string;
  dash?: boolean;
  /** 階段状に描く（状態の値）。 */
  step?: boolean;
}

export interface ChartThreshold {
  label: string;
  value: number;
  color: string;
}

export interface ChartLane {
  name: string;
  height: number;
  min: number;
  max: number;
  unit?: string;
  series: ChartSeries[];
  thresholds: ChartThreshold[];
}

export interface ChartSpan {
  start: number;
  end: number;
  color: string;
  label?: string;
}

export interface ChartMark {
  t: number;
  color: string;
  label: string;
}

export interface ChartBand {
  name: string;
  spans: ChartSpan[];
  marks: ChartMark[];
}

export interface ChartSpec {
  t0: number;
  t1: number;
  /** 時刻の目盛りの原点（セッションの始まり）。表示は秒。 */
  origin: number;
  lanes: ChartLane[];
  bands: ChartBand[];
}

const LEFT = 150;
const RIGHT = 12;
const GAP = 12;
const BAND_H = 14;
const BAND_GAP = 5;
const AXIS_H = 20;


function resolveColor(el: HTMLElement, color: string): string {
  const m = /^var\((--[\w-]+)\)$/.exec(color);
  if (!m) return color;
  return getComputedStyle(el).getPropertyValue(m[1] as string).trim() || '#888';
}

interface Layout {
  lanes: { top: number; lane: ChartLane }[];
  bandsTop: number;
  height: number;
}

function layoutOf(spec: ChartSpec): Layout {
  let y = 6;
  const lanes = spec.lanes.map((lane) => {
    const top = y;
    y += lane.height + GAP;
    return { top, lane };
  });
  const bandsTop = y;
  y += spec.bands.length * (BAND_H + BAND_GAP);
  return { lanes, bandsTop, height: y + AXIS_H };
}

function valueAt(points: ChartSeries['points'], t: number): number | null {
  let best: number | null = null;
  for (const [pt, v] of points) {
    if (pt > t) break;
    best = v;
  }
  return best;
}

function draw(canvas: HTMLCanvasElement, spec: ChartSpec, width: number, hoverT: number | null): void {
  const L = layoutOf(spec);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(L.height * dpr);
  canvas.style.height = `${L.height}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const col = (c: string) => resolveColor(canvas, c);
  const text = col('var(--muted)');
  const grid = col('var(--line)');
  ctx.clearRect(0, 0, width, L.height);
  ctx.font = '11px system-ui, sans-serif';
  const plotW = Math.max(10, width - LEFT - RIGHT);
  const span = Math.max(1, spec.t1 - spec.t0);
  const x = (t: number) => LEFT + ((t - spec.t0) / span) * plotW;

  for (const { top, lane } of L.lanes) {
    const y = (v: number) => top + lane.height - ((Math.min(lane.max, Math.max(lane.min, v)) - lane.min) / (lane.max - lane.min)) * lane.height;
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeRect(LEFT, top, plotW, lane.height);
    ctx.fillStyle = text;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(lane.name, LEFT - 6, top + lane.height / 2);
    ctx.fillText(`${lane.max}${lane.unit ?? ''}`, LEFT - 6, top + 6);
    ctx.fillText(`${lane.min}`, LEFT - 6, top + lane.height - 6);
    // 閾値（点線と名前）
    ctx.textAlign = 'left';
    // 名前が重ならないように、線ごとに横へずらす。
    const labelStep = Math.max(120, plotW / Math.max(1, lane.thresholds.length));
    lane.thresholds.forEach((th, i) => {
      const yy = y(th.value);
      ctx.strokeStyle = col(th.color);
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(LEFT, yy);
      ctx.lineTo(LEFT + plotW, yy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col(th.color);
      ctx.fillText(`${th.label} ${th.value}`, LEFT + 4 + i * labelStep, Math.max(top + 6, yy - 6));
    });
    for (const s of lane.series) {
      ctx.strokeStyle = col(s.color);
      ctx.lineWidth = 1.5;
      ctx.setLineDash(s.dash ? [5, 3] : []);
      ctx.beginPath();
      let started = false;
      let prevY = 0;
      for (const [t, v] of s.points) {
        if (t < spec.t0 - span * 0.05 || t > spec.t1 + span * 0.05) continue;
        const px = x(t);
        const py = y(v);
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else if (s.step) {
          ctx.lineTo(px, prevY);
          ctx.lineTo(px, py);
        } else ctx.lineTo(px, py);
        prevY = py;
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  spec.bands.forEach((band, i) => {
    const top = L.bandsTop + i * (BAND_H + BAND_GAP);
    ctx.fillStyle = text;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(band.name, LEFT - 6, top + BAND_H / 2);
    ctx.strokeStyle = grid;
    ctx.strokeRect(LEFT, top, plotW, BAND_H);
    for (const s of band.spans) {
      if (s.end < spec.t0 || s.start > spec.t1) continue;
      const x0 = Math.max(LEFT, x(s.start));
      const x1 = Math.min(LEFT + plotW, x(s.end));
      ctx.fillStyle = col(s.color);
      ctx.globalAlpha = 0.75;
      ctx.fillRect(x0, top + 2, Math.max(1.5, x1 - x0), BAND_H - 4);
      ctx.globalAlpha = 1;
    }
    for (const m of band.marks) {
      if (m.t < spec.t0 || m.t > spec.t1) continue;
      ctx.fillStyle = col(m.color);
      const px = x(m.t);
      ctx.beginPath();
      ctx.moveTo(px, top + 1);
      ctx.lineTo(px + 4, top + BAND_H / 2);
      ctx.lineTo(px, top + BAND_H - 1);
      ctx.lineTo(px - 4, top + BAND_H / 2);
      ctx.closePath();
      ctx.fill();
    }
  });

  // 時刻の目盛り（セッションの始まりからの秒）
  const axisTop = L.height - AXIS_H;
  ctx.fillStyle = text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const stepS = span > 60_000 ? 10 : span > 20_000 ? 5 : span > 8_000 ? 2 : 1;
  const first = Math.ceil((spec.t0 - spec.origin) / 1000 / stepS) * stepS;
  for (let s = first; spec.origin + s * 1000 <= spec.t1; s += stepS) {
    const px = x(spec.origin + s * 1000);
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(px, axisTop - 3);
    ctx.lineTo(px, axisTop);
    ctx.stroke();
    ctx.fillText(`${s}s`, px, axisTop + 2);
  }
  if (hoverT !== null && hoverT >= spec.t0 && hoverT <= spec.t1) {
    ctx.strokeStyle = text;
    ctx.setLineDash([1, 2]);
    ctx.beginPath();
    ctx.moveTo(x(hoverT), 0);
    ctx.lineTo(x(hoverT), axisTop);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

export function TuneChart({ spec, onHover, testId }: { spec: ChartSpec; onHover?: (t: number | null) => void; testId?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(900);
  const [hoverT, setHoverT] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 900);
      if (w > 0) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (canvasRef.current) draw(canvasRef.current, spec, width, hoverT);
  }, [spec, width, hoverT]);

  const readout = useMemo(() => {
    if (hoverT === null) return null;
    const parts: string[] = [`${((hoverT - spec.origin) / 1000).toFixed(2)}s`];
    for (const lane of spec.lanes) {
      for (const s of lane.series) {
        const v = valueAt(s.points, hoverT);
        if (v !== null) parts.push(`${lane.name}/${s.label}=${Math.abs(v) >= 10 ? Math.round(v) : v.toFixed(3)}`);
      }
    }
    for (const band of spec.bands) {
      const on = band.spans.filter((s) => s.start <= hoverT && hoverT <= s.end).map((s) => s.label ?? '●');
      if (on.length > 0) parts.push(`${band.name}: ${on.join(',')}`);
    }
    return parts.join('  ');
  }, [hoverT, spec]);

  return (
    <div ref={wrapRef} className={styles.chartWrap}>
      <canvas
        ref={canvasRef}
        className={styles.chart}
        data-testid={testId}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = e.clientX - rect.left;
          const plotW = Math.max(10, rect.width - LEFT - RIGHT);
          if (px < LEFT) {
            setHoverT(null);
            onHover?.(null);
            return;
          }
          const t = spec.t0 + ((px - LEFT) / plotW) * (spec.t1 - spec.t0);
          setHoverT(t);
          onHover?.(t);
        }}
        onPointerLeave={() => {
          setHoverT(null);
          onHover?.(null);
        }}
      />
      <div className={styles.readout}>{readout ?? 'ポインタを図に置くと、その時刻の値が出ます'}</div>
    </div>
  );
}
