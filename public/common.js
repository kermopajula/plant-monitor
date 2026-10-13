// Shared helpers for the dashboard and setup pages.
(function () {
  const METRICS = {
    moisture: { label: 'Moisture', unit: '%', digits: 0 },
    conductivity: { label: 'Fertility', unit: 'µS/cm', digits: 0 },
    lux: { label: 'Light', unit: 'lx', digits: 0, log: true },
    temperature: { label: 'Temperature', unit: '°C', digits: 1 },
  };

  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {} };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

  function fmt(v, metric) {
    if (v == null) return '–';
    const d = METRICS[metric] ? METRICS[metric].digits : 0;
    return Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
  }

  function timeAgo(ts, now = Date.now()) {
    if (!ts) return 'never';
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 36) return `${h} h ago`;
    return `${Math.round(h / 24)} days ago`;
  }

  let toastTimer;
  function toast(msg) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3500);
  }

  function firmwareNotice(fw) {
    if (!fw || !fw.advice) return '';
    const cls = fw.advice.level === 'update-recommended' ? 'info' : 'warn';
    return `<div class="notice ${cls}"><strong>${esc(fw.advice.title)}</strong>${esc(fw.advice.message)}
      <a href="/#firmware-help">${fw.advice.level === 'caution' ? 'Firmware notes' : 'How to update'}</a></div>`;
  }

  window.PM = { METRICS, api, esc, fmt, timeAgo, toast, firmwareNotice };
})();
