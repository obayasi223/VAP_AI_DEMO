// 詳細画面の音声の欄: 再生の位置と同じ時間軸の上に、マイクと AI の波形、吸気の合図、発話、判定の時刻を並べる。
// ログの文字はすべて textContent で入れる（innerHTML は使わない）。

const LANES = [
  ['desire', '生成段'],
  ['timing', 'タイミング段'],
  ['cue', '合図の送信'],
  ['render', '描画'],
  ['release', 'release'],
  ['speech', '発話'],
];
const LANE_COLOR = { desire: '#8a4b08', timing: '#b3261e', cue: '#1f6f8b', render: '#3f4e91', release: '#6b4fa0', speech: '#2e5e3f' };
const WAVE_HEIGHT = 56;
const LANE_HEIGHT = 18;
const LEFT = 76;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function drawWave(ctx, data, top, height, x0, width, color) {
  ctx.fillStyle = color;
  const middle = top + height / 2;
  const step = width / data.length;
  data.forEach(([min, max], i) => {
    const y1 = middle - max * (height / 2);
    const y2 = middle - min * (height / 2);
    ctx.fillRect(x0 + i * step, y1, Math.max(1, step - 0.2), Math.max(1, y2 - y1));
  });
}

function fmtSec(sec) {
  return `${sec.toFixed(2)} 秒`;
}

/** host に波形と印を描く。player は同じ音声の <audio>。 */
export async function renderAudioTimeline(host, { sessionId, player, centerSec, fmtT }) {
  host.replaceChildren();
  const spanSelect = document.createElement('select');
  for (const span of [10, 20, 40, 80]) {
    const option = node('option', `${span} 秒`);
    option.value = String(span);
    if (span === 20) option.selected = true;
    spanSelect.append(option);
  }
  const body = node('div');
  host.append(body);

  async function load() {
    body.replaceChildren(node('p', '波形を読み込んでいます…', 'note'));
    let data;
    try {
      const response = await fetch(`/api/sessions/${sessionId}/audio_timeline?center_sec=${centerSec}&span_sec=${spanSelect.value}&bins=1200`);
      data = await response.json();
    } catch {
      body.replaceChildren(node('p', '波形を読み込めませんでした。', 'note'));
      return;
    }
    if (!data.available) {
      body.replaceChildren(node('p', data.reason, 'note'));
      return;
    }
    draw(data);
  }

  let listeners = null;

  function draw(data) {
    // 表示の長さを変えて描き直すとき、前の絵の再生位置の更新を外す。
    listeners?.abort();
    listeners = new AbortController();
    const { signal } = listeners;
    body.replaceChildren();
    const { waveform, marks } = data;
    const lanesTop = WAVE_HEIGHT * 2 + 12;
    const height = lanesTop + LANES.length * LANE_HEIGHT + 4;
    const canvas = document.createElement('canvas');
    const width = Math.max(320, body.clientWidth || host.clientWidth || 640);
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.className = 'audio-timeline';
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    const plotWidth = width - LEFT - 8;
    const secToX = (sec) => LEFT + ((sec - waveform.from_sec) / Math.max(0.001, waveform.to_sec - waveform.from_sec)) * plotWidth;

    function paint(currentSec) {
      ctx.clearRect(0, 0, width, height);
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = '#6b7078';
      ctx.fillText('マイク', 4, WAVE_HEIGHT / 2 + 4);
      ctx.fillText('AI', 4, WAVE_HEIGHT + 6 + WAVE_HEIGHT / 2 + 4);
      drawWave(ctx, waveform.mic, 0, WAVE_HEIGHT, LEFT, plotWidth, '#3a6ea5');
      drawWave(ctx, waveform.sys, WAVE_HEIGHT + 6, WAVE_HEIGHT, LEFT, plotWidth, '#c0533a');
      LANES.forEach(([lane, label], index) => {
        const top = lanesTop + index * LANE_HEIGHT;
        ctx.fillStyle = '#6b7078';
        ctx.fillText(label, 4, top + 13);
        ctx.fillStyle = '#ece9df';
        ctx.fillRect(LEFT, top + 8, plotWidth, 1);
        ctx.fillStyle = LANE_COLOR[lane];
        for (const mark of marks) {
          if (mark.lane !== lane) continue;
          const x = secToX(mark.sec);
          ctx.fillRect(x - 1, top + 2, 2, LANE_HEIGHT - 4);
        }
      });
      for (const gap of data.sync.gaps) {
        const gapSec = gap.wav_sample / 16000;
        if (gapSec < waveform.from_sec || gapSec > waveform.to_sec) continue;
        ctx.fillStyle = 'rgba(179, 38, 30, 0.35)';
        ctx.fillRect(secToX(gapSec), 0, Math.max(2, secToX(gapSec + gap.frames / 16000) - secToX(gapSec)), lanesTop);
      }
      if (currentSec >= waveform.from_sec && currentSec <= waveform.to_sec) {
        ctx.fillStyle = '#23262b';
        ctx.fillRect(secToX(currentSec) - 0.5, 0, 1.5, height);
      }
    }
    paint(player.currentTime);
    canvas.addEventListener('click', (event) => {
      const rect = canvas.getBoundingClientRect();
      const sec = waveform.from_sec + ((event.clientX - rect.left - LEFT) / plotWidth) * (waveform.to_sec - waveform.from_sec);
      player.currentTime = Math.max(0, sec);
      paint(player.currentTime);
    });
    let frame = 0;
    const animate = () => {
      paint(player.currentTime);
      if (!player.paused && canvas.isConnected) frame = requestAnimationFrame(animate);
    };
    player.addEventListener('play', () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(animate);
    }, { signal });
    player.addEventListener('pause', () => paint(player.currentTime), { signal });
    player.addEventListener('seeked', () => paint(player.currentTime), { signal });

    const controls = node('div', undefined, 'audio-row');
    const spanLabel = node('label', '表示の長さ ');
    spanLabel.append(spanSelect);
    controls.append(spanLabel);
    const { clock, sync } = data;
    const clockText =
      clock.browser_samples === 0
        ? 'ブラウザの時計の推定なし（描画と発話の時刻の誤差は不明）'
        : `ブラウザの時計の誤差 中央値 ${clock.browser_error_ms_median.toFixed(1)} ms、最大 ${clock.browser_error_ms_max.toFixed(1)} ms（clock.sync）`;
    const syncText = `音声の対応の幅 中央値 ${sync.spread_ms_median.toFixed(1)} ms、最大 ${sync.spread_ms_max.toFixed(1)} ms（${sync.anchors} 点）`;
    body.append(controls, canvas, node('p', `${clockText}／${syncText}`, 'note'));
    if (sync.gaps.length > 0) {
      const seconds = sync.gaps.reduce((sum, g) => sum + g.frames, 0) / 16000;
      body.append(node('p', `音声に欠落が ${sync.gaps.length} か所あります（合計 ${seconds.toFixed(2)} 秒）。赤い帯の区間です。`, 'warn'));
    }
    if (!sync.ended) body.append(node('p', '音声の記録が正常に閉じられていません（異常終了の可能性があります）。', 'warn'));
    if (sync.stop_reason) body.append(node('p', `音声の保存は途中で止まりました（${sync.stop_reason}）。`, 'warn'));

    const table = node('table', undefined, 'audio-marks');
    const header = node('tr');
    for (const title of ['音声の位置', '時刻', '印', '時計', '']) header.append(node('th', title));
    table.append(header);
    for (const mark of marks) {
      const row = node('tr');
      row.append(node('td', fmtSec(mark.sec)), node('td', fmtT(mark.t_ms)), node('td', mark.label));
      const clockCell = mark.clock === 'browser' ? (mark.clock_error_ms === null ? 'ブラウザ（誤差不明）' : `ブラウザ（±${mark.clock_error_ms.toFixed(1)} ms）`) : 'orchestrator';
      row.append(node('td', clockCell));
      const seekCell = node('td');
      const seek = node('button', 'ここへ', 'linebtn');
      seek.addEventListener('click', () => {
        player.currentTime = Math.max(0, mark.sec - 0.5);
        void player.play();
      });
      seekCell.append(seek);
      row.append(seekCell);
      table.append(row);
    }
    if (marks.length === 0) body.append(node('p', 'この範囲に印はありません。', 'note'));
    else body.append(table);
  }

  spanSelect.addEventListener('change', () => void load());
  await load();
}
