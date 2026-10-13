/* global PM */
(function () {
  const { METRICS, api, esc, timeAgo, toast, firmwareNotice } = PM;
  const $ = (id) => document.getElementById(id);
  let settings = null;

  async function act(btn, fn) {
    if (btn) btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      toast(e.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // --- collector status & settings ---

  function renderCollector() {
    const c = settings.collector;
    let text = 'The collector has not reported yet. Is it running? (pm2 status)';
    if (c) {
      const stale = Date.now() - c.at > (settings.intervalMinutes + 10) * 60000;
      if (c.state === 'scanning') text = `Scanning now (started ${timeAgo(c.cycleStartedAt)}).`;
      else if (c.lastCycle) {
        const l = c.lastCycle;
        text = `Last scan ${timeAgo(c.lastCycleAt)}: heard ${l.heard} sensor(s), ${l.passive} passive and ${l.active} active reading(s)` +
          `${l.failed ? `, ${l.failed} failed` : ''}${l.missing ? `, ${l.missing} not heard` : ''}.`;
      }
      if (c.error) text += ` Error: ${c.error}`;
      if (stale) text += ' ⚠ No update from the collector for a while; check `pm2 logs plant-collector`.';
    }
    $('collector').textContent = text;
  }

  async function loadSettings() {
    settings = await api('/api/settings');
    renderCollector();
    const f = $('settings');
    if (document.activeElement?.form !== f) {
      f.intervalMinutes.value = settings.intervalMinutes;
      f.alertAfterMinutes.value = settings.alertAfterMinutes;
    }
    $('alerts-note').textContent = settings.notifiers.length
      ? `Alerts are sent via ${settings.notifiers.join(' and ')} when a value stays out of range for the time above.`
      : 'Alerts are off. Set NTFY_URL or WEBHOOK_URL in .env and restart (see README).';
    $('test-alert').hidden = !settings.notifiers.length;
  }

  $('settings').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    act(f.querySelector('button'), async () => {
      await api('/api/settings', {
        method: 'PUT',
        body: { intervalMinutes: Number(f.intervalMinutes.value), alertAfterMinutes: Number(f.alertAfterMinutes.value) },
      });
      toast('Settings saved');
      await loadSettings();
    });
  });

  $('scan').addEventListener('click', (e) =>
    act(e.target, async () => {
      await api('/api/scan', { method: 'POST', body: {} });
      $('scan-note').textContent = `Scan requested. It starts within a few seconds and takes up to ${settings.scanSeconds} s; this page refreshes by itself.`;
    }),
  );

  $('test-alert').addEventListener('click', (e) =>
    act(e.target, async () => {
      const r = await api('/api/alerts/test', { method: 'POST', body: {} });
      toast(r.errors.length ? `Partly sent: ${r.errors.join('; ')}` : 'Test alert sent');
    }),
  );

  // --- sensors ---

  function discoveredItem(s) {
    return `<li data-mac="${esc(s.mac)}">
      <div class="row" style="justify-content:space-between">
        <div><span class="mono">${esc(s.mac)}</span><br>
          <span class="subtle">${esc(s.bleName || 'Mi Flora')} · signal ${s.rssi ?? '?'} dBm · seen ${timeAgo(s.lastSeen)}</span></div>
      </div>
      <form class="row adopt" style="margin-top:8px">
        <label class="field" style="flex:1;min-width:180px">Name<input type="text" name="name" maxlength="100" placeholder="e.g. Monstera in the living room" required></label>
        <button class="btn primary" type="submit">Add</button>
      </form>
    </li>`;
  }

  function rangesTable(s) {
    const rows = Object.entries(METRICS)
      .map(([m, meta]) => {
        const r = s.ranges[m];
        return `<tr><th scope="row">${meta.label} <span class="subtle">${meta.unit}</span></th>
          <td><input type="number" step="any" name="${m}.min" value="${r.min ?? ''}" aria-label="${meta.label} min" placeholder="min"></td>
          <td><input type="number" step="any" name="${m}.max" value="${r.max ?? ''}" aria-label="${meta.label} max" placeholder="max"></td></tr>`;
      })
      .join('');
    return `<table class="ranges-table"><thead><tr><th></th><th>Min</th><th>Max</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function adoptedItem(s) {
    const source =
      s.rangesSource === 'plantbook' ? 'from Open Plant Book' : s.rangesSource === 'custom' ? 'custom' : 'not set (generic defaults are used)';
    const error = s.lastError ? `<div class="notice error"><strong>Last read problem</strong>${esc(s.lastError)} <span class="subtle">(${timeAgo(s.lastErrorAt)})</span></div>` : '';
    return `<li data-mac="${esc(s.mac)}">
      <form class="row rename">
        <label class="field" style="flex:1;min-width:180px">Name<input type="text" name="name" maxlength="100" value="${esc(s.name || '')}" required></label>
        <button class="btn" type="submit">Rename</button>
      </form>
      <p class="subtle"><span class="mono">${esc(s.mac)}</span> · firmware ${esc(s.firmware.version || 'unknown (read on first connection)')}
        · battery ${s.battery == null ? '–' : s.battery + '%'} · ${s.mode || 'no data yet'} · seen ${timeAgo(s.lastSeen)}</p>
      ${firmwareNotice(s.firmware)}${error}

      <h3 style="font-size:1rem;margin:14px 0 4px">Species</h3>
      <p style="margin:0">${s.species ? `<i>${esc(s.species)}</i>` : '<span class="subtle">Not set</span>'}</p>
      <form class="row species-search" style="margin-top:8px">
        <label class="field" style="flex:1;min-width:180px">Search Open Plant Book<input type="search" name="q" placeholder="e.g. monstera" minlength="2" required></label>
        <button class="btn" type="submit">Search</button>
      </form>
      <ul class="results"></ul>

      <h3 style="font-size:1rem;margin:14px 0 4px">Ideal ranges <span class="subtle" style="font-weight:400">(${source})</span></h3>
      <form class="ranges">${rangesTable(s)}
        <div class="row" style="margin-top:8px"><button class="btn" type="submit">Save ranges</button></div>
      </form>

      <div class="row" style="margin-top:14px;justify-content:flex-end">
        <button class="btn danger small" data-action="remove">Remove plant</button>
      </div>
    </li>`;
  }

  async function loadSensors({ adopted = true } = {}) {
    const data = await api('/api/sensors');
    const disc = $('discovered');
    // Don't wipe a half-typed name.
    if (!disc.contains(document.activeElement)) {
      disc.innerHTML = data.discovered.length
        ? data.discovered.map(discoveredItem).join('')
        : '<li class="subtle">No new sensors found yet.</li>';
    }
    if (adopted) {
      $('adopted').innerHTML = data.adopted.length
        ? data.adopted.map(adoptedItem).join('')
        : '<li class="subtle">No plants yet. Add a sensor above.</li>';
    }
  }

  const macOf = (el) => el.closest('li[data-mac]').dataset.mac;
  const sensorUrl = (mac) => `/api/sensors/${encodeURIComponent(mac)}`;

  $('discovered').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    act(f.querySelector('button'), async () => {
      await api(sensorUrl(macOf(f)), { method: 'PUT', body: { adopted: true, name: f.elements.namedItem('name').value } });
      toast('Plant added. Readings appear after the next scan.');
      f.closest('li').remove();
      await loadSensors();
    });
  });

  $('adopted').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const mac = macOf(f);
    const btn = f.querySelector('button[type=submit]');
    if (f.classList.contains('rename')) {
      act(btn, async () => {
        await api(sensorUrl(mac), { method: 'PUT', body: { name: f.elements.namedItem('name').value } });
        toast('Name saved');
      });
    } else if (f.classList.contains('ranges')) {
      const ranges = {};
      for (const m of Object.keys(METRICS)) {
        ranges[m] = { min: f.elements.namedItem(`${m}.min`).value || null, max: f.elements.namedItem(`${m}.max`).value || null };
      }
      act(btn, async () => {
        await api(sensorUrl(mac), { method: 'PUT', body: { ranges } });
        toast('Ranges saved');
        await loadSensors();
      });
    } else if (f.classList.contains('species-search')) {
      const list = f.nextElementSibling;
      act(btn, async () => {
        list.innerHTML = '<li class="subtle">Searching…</li>';
        try {
          const { results } = await api(`/api/species/search?q=${encodeURIComponent(f.elements.namedItem('q').value)}`);
          list.innerHTML = results.length
            ? results
                .map((r) => `<li><button class="btn" type="button" data-pid="${esc(r.pid)}"><i>${esc(r.display_pid)}</i>
                  ${r.category ? `<span class="subtle">${esc(r.category)}</span>` : ''}</button></li>`)
                .join('')
            : '<li class="subtle">No matches. Try the botanical name, e.g. "monstera deliciosa".</li>';
        } catch (err) {
          list.innerHTML = `<li class="notice error">${esc(err.message)}</li>`;
        }
      });
    }
  });

  $('adopted').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.pid) {
      act(b, async () => {
        await api(`${sensorUrl(macOf(b))}/species`, { method: 'POST', body: { pid: b.dataset.pid } });
        toast('Species set and ideal ranges updated');
        await loadSensors();
      });
    } else if (b.dataset.action === 'remove') {
      if (!confirm('Remove this plant? The sensor goes back to "New sensors"; its history is kept.')) return;
      act(b, async () => {
        await api(sensorUrl(macOf(b)), { method: 'DELETE' });
        await loadSensors();
      });
    }
  });

  async function init() {
    try {
      await Promise.all([loadSettings(), loadSensors()]);
    } catch (e) {
      toast(e.message);
    }
    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      loadSettings().catch(() => {});
      loadSensors({ adopted: false }).catch(() => {});
    }, 10000);
  }
  init();
})();
