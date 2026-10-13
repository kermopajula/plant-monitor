/* global Chart, PM */
(function () {
  const { METRICS, api, esc, fmt, timeAgo, firmwareNotice } = PM;
  const DAY = 86400000;
  const root = document.getElementById('plants');
  const cards = new Map(); // mac -> { el, plant, chart, metric, days }
  const historyCache = new Map(); // `${mac}:${days}` -> { at, data }

  function levelBadge(level) {
    if (level === 'low') return '<span class="level low">▼ Low</span>';
    if (level === 'high') return '<span class="level high">▲ High</span>';
    if (level === 'ok') return '<span class="level ok">✓</span>';
    return '';
  }

  function gauge(value, range, log) {
    if (value == null || range.min == null || range.max == null) return '';
    const f = log ? (x) => Math.log10(Math.max(1, x)) : (x) => x;
    const lo = log ? 1 : Math.min(0, value, range.min);
    const hi = log ? Math.max(range.max * 3, value * 1.5, 10) : Math.max(range.max * 1.4, value * 1.1, 1);
    const pos = (x) => Math.min(100, Math.max(0, ((f(x) - f(lo)) / (f(hi) - f(lo))) * 100));
    const a = pos(range.min);
    const b = pos(range.max);
    return `<div class="gauge" aria-hidden="true"><div class="zone" style="left:${a}%;width:${b - a}%"></div>
      <div class="marker" style="left:${pos(value)}%"></div></div>`;
  }

  function rangeText(r, unit) {
    if (r.min == null && r.max == null) return 'no ideal range';
    return `ideal ${r.min == null ? '…' : fmt(r.min)}–${r.max == null ? '…' : fmt(r.max)} ${unit}`;
  }

  function metricRow(p, m) {
    const meta = METRICS[m];
    const r = p.ranges[m];
    const judged = m === 'lux' && p.lightPeak24h != null ? p.lightPeak24h : p.values[m];
    let sub = rangeText(r, meta.unit);
    let name = meta.label;
    if (m === 'lux') {
      name = 'Light <span class="subtle">(24 h peak)</span>';
      sub = `now ${fmt(p.values.lux)} lx · ${sub}`;
    }
    return `<li>
      <div class="metric-top"><span class="metric-name">${name}</span>
        <span><span class="metric-value">${fmt(judged, m)}<span class="unit">${meta.unit}</span></span>${levelBadge(p.status.levels[m])}</span></div>
      ${gauge(judged, r, meta.log)}
      <div class="metric-sub"><span>${sub}</span></div>
    </li>`;
  }

  function statusPills(st) {
    if (st.status === 'ok') return '<span class="pill ok"><span class="dot"></span>✓ OK</span>';
    if (st.status === 'offline') return '<span class="pill offline"><span class="dot"></span>— No recent data</span>';
    if (st.status === 'unknown') return '<span class="pill unknown"><span class="dot"></span>? Unknown</span>';
    return st.label
      .split(', ')
      .map((l) => `<span class="pill problem"><span class="dot"></span>! ${esc(l)}</span>`)
      .join('');
  }

  function summaryHtml(p, now) {
    const fw = p.firmware;
    const battery = p.battery == null ? '–' : `${p.battery}%`;
    const rangesNote =
      p.rangesSource === 'default'
        ? '<div class="notice info">Using generic ranges. Set a species on the <a href="/setup">setup page</a> for plant-specific ones.</div>'
        : '';
    const err =
      p.lastError && (!p.lastReadingAt || p.lastErrorAt > p.lastReadingAt)
        ? `<div class="notice error"><strong>Last read problem</strong>${esc(p.lastError)} <span class="subtle">(${timeAgo(p.lastErrorAt, now)})</span></div>`
        : '';
    return `
      <div class="card-head">
        ${p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
        <div class="titles"><h2>${esc(p.name)}</h2>${p.species ? `<p class="species">${esc(p.species)}</p>` : ''}</div>
      </div>
      <div class="problems">${statusPills(p.status)}</div>
      <ul class="metrics">${['moisture', 'conductivity', 'lux', 'temperature'].map((m) => metricRow(p, m)).join('')}</ul>
      <div class="meta">
        <span>Last reading <b>${timeAgo(p.lastReadingAt, now)}</b></span>
        <span>Battery <b>${battery}</b></span>
        <span>Firmware <b>${esc(fw.version || 'unknown')}</b></span>
        ${p.mode ? `<span>Mode <b>${p.mode}</b></span>` : ''}
      </div>
      ${firmwareNotice(fw)}${rangesNote}${err}`;
  }

  function historyHtml() {
    const metricBtns = Object.entries(METRICS)
      .map(([k, v], i) => `<button type="button" data-metric="${k}" aria-pressed="${i === 0}">${v.label}</button>`)
      .join('');
    return `<details class="history"><summary>History</summary>
      <div class="chart-controls">
        <div class="seg" role="group" aria-label="Metric">${metricBtns}</div>
        <div class="seg" role="group" aria-label="Period">
          <button type="button" data-days="7" aria-pressed="true">7 days</button>
          <button type="button" data-days="30" aria-pressed="false">30 days</button>
        </div>
      </div>
      <div class="chart-box"><canvas role="img"></canvas></div>
      <div class="chart-note"></div>
    </details>`;
  }

  async function getHistory(mac, days) {
    const key = `${mac}:${days}`;
    const hit = historyCache.get(key);
    if (hit && Date.now() - hit.at < 5 * 60000) return hit.data;
    const data = await api(`/api/plants/${encodeURIComponent(mac)}/history?days=${days}`);
    historyCache.set(key, { at: Date.now(), data });
    return data;
  }

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function midnightTicks(min, max, stepDays) {
    const d = new Date(min);
    d.setHours(24, 0, 0, 0); // next local midnight
    const ticks = [];
    for (; d.getTime() <= max; d.setDate(d.getDate() + stepDays)) ticks.push({ value: d.getTime() });
    return ticks;
  }

  async function drawChart(state) {
    const { el, plant, metric, days } = state;
    const canvas = el.querySelector('canvas');
    const note = el.querySelector('.chart-note');
    const meta = METRICS[metric];
    let data;
    try {
      data = await getHistory(plant.mac, days);
    } catch (e) {
      note.textContent = `Could not load history: ${e.message}`;
      return;
    }
    if (state.metric !== metric || state.days !== days) return; // a newer request superseded this one

    // Break the line where readings are missing for more than 3 buckets.
    const pts = [];
    let prev = null;
    for (const p of data.points) {
      if (p[metric] == null) continue;
      if (prev != null && p.ts - prev > data.bucketMs * 3) pts.push({ x: (prev + p.ts) / 2, y: null });
      pts.push({ x: p.ts, y: p[metric] });
      prev = p.ts;
    }
    const min = data.now - days * DAY;
    const max = data.now;
    const r = plant.ranges[metric];
    const band = [];
    if (r.min != null || r.max != null) {
      const lo = r.min ?? 0;
      const hi = r.max ?? Math.max(lo, ...pts.map((p) => p.y ?? 0));
      band.push(
        { data: [{ x: min, y: lo }, { x: max, y: lo }], borderColor: css('--band-line'), borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false },
        { data: [{ x: min, y: hi }, { x: max, y: hi }], borderColor: css('--band-line'), borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: '-1', backgroundColor: css('--band') },
      );
    }
    const series = {
      data: pts,
      borderColor: css('--series'),
      backgroundColor: css('--series'),
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 5,
      pointHoverBorderWidth: 2,
      pointHoverBorderColor: css('--surface'),
      tension: 0.25,
      spanGaps: false,
    };
    const datasets = [...band, series];
    const seriesIndex = datasets.length - 1;
    const grid = css('--grid');
    const tick = css('--text-3');

    if (state.chart) state.chart.destroy();
    state.chart = new Chart(canvas, {
      type: 'line',
      data: { datasets },
      options: {
        animation: false,
        maintainAspectRatio: false,
        parsing: false,
        normalized: true,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: (item) => item.datasetIndex === seriesIndex,
            displayColors: false,
            callbacks: {
              title: (items) =>
                items.length
                  ? new Date(items[0].parsed.x).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
                  : '',
              label: (item) => `${meta.label}: ${fmt(item.parsed.y, metric)} ${meta.unit}`,
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            min,
            max,
            grid: { color: grid, drawTicks: false },
            border: { display: false },
            afterBuildTicks: (axis) => (axis.ticks = midnightTicks(min, max, days === 7 ? 1 : 7)),
            ticks: {
              color: tick,
              maxRotation: 0,
              autoSkip: true,
              callback: (v) => new Date(v).toLocaleDateString(undefined, days === 7 ? { weekday: 'short' } : { day: 'numeric', month: 'short' }),
            },
          },
          y: {
            beginAtZero: metric !== 'temperature',
            grid: { color: grid, drawTicks: false },
            border: { display: false },
            ticks: { color: tick, maxTicksLimit: 5, callback: (v) => Number(v).toLocaleString() },
            title: { display: true, text: meta.unit, color: tick },
          },
        },
      },
    });
    canvas.setAttribute('aria-label', `${meta.label} over the last ${days} days`);
    const agg = metric === 'lux' ? 'highest' : 'average';
    const bucket = data.bucketMs >= 3600000 ? `${data.bucketMs / 3600000} h` : `${data.bucketMs / 60000} min`;
    note.textContent = pts.length
      ? `${meta.label} (${meta.unit}), ${agg} per ${bucket}. Shaded band = ideal range.`
      : `No ${meta.label.toLowerCase()} readings in the last ${days} days yet.`;
  }

  function wireHistory(state) {
    const det = state.el.querySelector('details.history');
    det.addEventListener('toggle', () => det.open && drawChart(state));
    det.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const group = b.parentElement;
      group.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      if (b.dataset.metric) state.metric = b.dataset.metric;
      if (b.dataset.days) state.days = Number(b.dataset.days);
      drawChart(state);
    });
  }

  function render(data) {
    const { plants, now } = data;
    document.getElementById('updated').textContent = `Updated ${new Date(now).toLocaleTimeString()} · reads every ${data.intervalMinutes} min`;

    if (!plants.length) {
      root.innerHTML = `<div class="card empty" style="grid-column:1/-1">No plants yet.<br><br>
        <a class="btn primary" href="/setup">Add a sensor</a></div>`;
      cards.clear();
      return;
    }
    if (root.querySelector('.empty')) root.innerHTML = '';

    const seen = new Set();
    for (const p of plants) {
      seen.add(p.mac);
      let state = cards.get(p.mac);
      if (!state) {
        const el = document.createElement('article');
        el.className = 'card';
        el.innerHTML = `<div class="summary"></div>${historyHtml()}`;
        state = { el, plant: p, chart: null, metric: 'moisture', days: 7 };
        cards.set(p.mac, state);
        wireHistory(state);
      }
      state.plant = p;
      state.el.querySelector('.summary').innerHTML = summaryHtml(p, now);
      root.appendChild(state.el); // keeps server order (by name)
      if (state.el.querySelector('details.history').open) {
        historyCache.delete(`${p.mac}:${state.days}`);
        drawChart(state);
      }
    }
    for (const [mac, state] of cards) {
      if (!seen.has(mac)) {
        if (state.chart) state.chart.destroy();
        state.el.remove();
        cards.delete(mac);
      }
    }

    const help = data.firmwareHelp;
    document.getElementById('fw-steps').innerHTML = help.steps.map((s) => `<li>${esc(s)}</li>`).join('');
    document.getElementById('fw-warnings').innerHTML =
      '<strong>Before you update</strong>' + help.warnings.map((w) => `<p>${esc(w)}</p>`).join('');
  }

  async function refresh() {
    try {
      render(await api('/api/plants'));
    } catch (e) {
      document.getElementById('updated').textContent = `Could not load data: ${e.message}`;
    }
  }

  refresh();
  setInterval(() => document.visibilityState === 'visible' && refresh(), 60000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh());
})();
