import { connectHost, HostRequestError } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { readDailyCosts, reportingDay } from './usage';

const host = connectHost();
const notice = document.querySelector<HTMLElement>('#notice');
const button = document.querySelector<HTMLButtonElement>('#refresh');
if (!notice || !button) throw new Error('Missing usage controls');
const controls = { notice, button };
const rows = [
  { id: 2, fallback: 'API key 2' },
  { id: 1, fallback: 'API key 1' },
].map(definition => {
  const element = document.querySelector<HTMLElement>(`[data-key-id="${definition.id}"]`);
  const amount = element?.querySelector<HTMLOutputElement>('.amount');
  const key = element?.querySelector<HTMLElement>('.key');
  const label = element?.querySelector<HTMLElement>('.label');
  const status = element?.querySelector<HTMLElement>('.row-status');
  if (!element || !amount || !key || !label || !status) throw new Error('Missing usage row');
  return { ...definition, element, amount, key, label, status };
});

let locale = 'zh-CN';
let ready = false;
let initialized = false;
let generation = 0;
let inFlight = false;
const samples = new Map<number, { value: number; day: string }>();
let timer: ReturnType<typeof setInterval> | null = null;
const text = () => locale.startsWith('zh')
  ? { today: '今日用量', refresh: '刷新', loading: '更新中…',
      serviceNeeded: '请检查 .env 文件及设置 → 扩展中的 Service 授权',
      keyRejected: 'API key 无效，请更新本地 .env',
      failed: '更新失败', stale: '显示上次结果', missing: '此 key 暂无有效数据', partial: '部分数据更新失败', updated: '更新于' }
  : { today: 'Today', refresh: 'Refresh', loading: 'Updating…',
      serviceNeeded: 'Check the .env file and the Sub2API Service grant in Settings → Extensions',
      keyRejected: 'API key rejected; update the local .env file',
      failed: 'Refresh failed', stale: 'Showing the last result', missing: 'No valid data for this key', partial: 'Some readings could not be updated', updated: 'Updated' };

function renderSample() {
  // Yesterday's last successful sample must never be labelled as today.
  for (const row of rows) {
    if (samples.get(row.id)?.day !== reportingDay()) samples.delete(row.id);
    const sample = samples.get(row.id);
    row.amount.textContent = sample ? `$${sample.value.toFixed(4)}` : '—';
  }
}

async function refresh(force = false) {
  if (!ready || inFlight) return;
  const owner = generation;
  inFlight = true;
  controls.button.disabled = true;
  renderSample();
  controls.notice.textContent = text().loading;
  controls.notice.dataset.error = 'false';
  const day = reportingDay();
  try {
    const response = await host.serviceRequest({
      method: 'POST', path: '/usage',
      body: JSON.stringify({ keyIds: rows.map(row => row.id), force }),
    });
    if (owner !== generation) return;
    if (response.status !== 200) throw new Error('Usage request failed');
    const { results: values, fetchedAt } = readDailyCosts(response.body, rows.map(row => row.id));
    if (day !== reportingDay()) throw new Error('Reporting day changed');
    let partial = false;
    for (const row of rows) {
      const result = values.get(row.id);
      if (result && 'value' in result) {
        samples.set(row.id, { value: result.value, day });
        row.key.textContent = result.name;
        row.status.textContent = '';
      } else {
        partial = true;
        if (result && 'name' in result && result.name) row.key.textContent = result.name;
        const keyError = result && 'error' in result ? result.error : 'missing-key';
        row.status.textContent = samples.has(row.id) ? text().stale : text().missing;
        if (keyError === 'credential-rejected') row.status.textContent = text().keyRejected;
      }
    }
    renderSample();
    controls.notice.dataset.error = String(partial);
    controls.notice.textContent = partial ? text().partial : `${text().updated} ${new Date(fetchedAt).toLocaleTimeString(locale, {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })}`;
  } catch (error) {
    if (owner !== generation) return;
    renderSample();
    const serviceUnavailable = error instanceof HostRequestError
      && ['NO_SERVICE', 'NOT_GRANTED', 'SERVICE_FAILED'].includes(error.code);
    for (const row of rows) row.status.textContent = samples.has(row.id) ? text().stale : '';
    controls.notice.textContent = serviceUnavailable ? text().serviceNeeded : text().failed;
    controls.notice.dataset.error = 'true';
  } finally {
    if (owner === generation) {
      inFlight = false;
      controls.button.disabled = !ready;
    }
  }
}

host.onReady(context => {
  applyHostReady(context, document.documentElement);
  locale = context.locale;
  for (const row of rows) {
    row.label.textContent = text().today;
    if (!initialized) row.key.textContent = row.fallback;
  }
  controls.button.textContent = text().refresh;
  if (initialized) return;
  initialized = true;
  ready = true;
  controls.button.disabled = false;
  void refresh();
  if (!timer) timer = setInterval(() => {
    if (!document.hidden) void refresh();
  }, 300_000);
});
controls.button.addEventListener('click', () => void refresh(true));
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
window.addEventListener('pagehide', () => {
  generation += 1;
  ready = false;
  if (timer) clearInterval(timer);
  host.dispose();
}, { once: true });
