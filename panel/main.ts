import { connectHost, HostRequestError } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { readDailyCosts, reportingDay } from './usage';

const host = connectHost();
const notice = document.querySelector<HTMLElement>('#notice');
const button = document.querySelector<HTMLButtonElement>('#refresh');
const codexElement = document.querySelector<HTMLElement>('[data-codex-quota]');
const codexName = codexElement?.querySelector<HTMLElement>('#codex-account');
const codexLabel = codexElement?.querySelector<HTMLElement>('#codex-label');
const codexAmount = codexElement?.querySelector<HTMLOutputElement>('#codex-percent');
const codexStatus = codexElement?.querySelector<HTMLElement>('#codex-status');
if (!notice || !button || !codexElement || !codexName || !codexLabel || !codexAmount || !codexStatus) {
  throw new Error('Missing usage controls');
}
const controls = { notice, button, codexName, codexLabel, codexAmount, codexStatus };
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
let codexSample: number | null = null;
let codexAccountId: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const text = () => locale.startsWith('zh')
  ? { today: '今日用量', refresh: '刷新', loading: '更新中…',
      serviceNeeded: '请检查 .env 文件及设置 → 扩展中的 Service 授权',
      keyRejected: 'API key 无效，请更新本地 .env',
      codexAccountIdMissing: '请在 .env 配置 Codex account ID',
      adminCredentialsMissing: '请在 .env 配置 Codex 管理 access/refresh token',
      adminLoginExpired: '管理登录已过期，请重新登录并更新 .env',
      adminPermissionDenied: '该账号没有查看 Codex 用量的管理权限',
      codexUnavailable: '暂时无法获取 Codex 7d 用量',
      failed: '更新失败', stale: '显示上次结果', missing: '此 key 暂无有效数据', partial: '部分数据更新失败', updated: '更新于' }
  : { today: 'Today', refresh: 'Refresh', loading: 'Updating…',
      serviceNeeded: 'Check the .env file and the Sub2API Service grant in Settings → Extensions',
      keyRejected: 'API key rejected; update the local .env file',
      codexAccountIdMissing: 'Configure the Codex account ID in .env',
      adminCredentialsMissing: 'Configure the Codex admin access/refresh tokens in .env',
      adminLoginExpired: 'Admin login expired; sign in again and update .env',
      adminPermissionDenied: 'This account cannot read Codex usage',
      codexUnavailable: 'Codex 7d usage is unavailable',
      failed: 'Refresh failed', stale: 'Showing the last result', missing: 'No valid data for this key', partial: 'Some readings could not be updated', updated: 'Updated' };

function renderSample() {
  // Yesterday's last successful sample must never be labelled as today.
  for (const row of rows) {
    if (samples.get(row.id)?.day !== reportingDay()) samples.delete(row.id);
    const sample = samples.get(row.id);
    row.amount.textContent = sample ? `$${sample.value.toFixed(4)}` : '—';
  }
  controls.codexAmount.textContent = codexSample === null ? '—' : `${codexSample.toFixed(1)}%`;
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
    const { results: values, codex7d, fetchedAt } = readDailyCosts(response.body, rows.map(row => row.id));
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
    if (codex7d.accountId !== undefined && codex7d.accountId !== codexAccountId) {
      codexAccountId = codex7d.accountId;
      codexSample = null;
    }
    if (codex7d.error === 'account-id-not-configured') {
      codexAccountId = null;
      codexSample = null;
    }
    controls.codexName.textContent = codexAccountId ? `Codex account ${codexAccountId}` : 'Codex account';
    if (codex7d.ok && codex7d.usedPercent !== undefined) {
      codexSample = codex7d.usedPercent;
      controls.codexStatus.textContent = '';
    } else {
      partial = true;
      controls.codexStatus.textContent = codexSample !== null ? text().stale : codexErrorText(codex7d.error);
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
    controls.codexStatus.textContent = codexSample === null ? '' : text().stale;
    controls.notice.textContent = serviceUnavailable ? text().serviceNeeded : text().failed;
    controls.notice.dataset.error = 'true';
  } finally {
    if (owner === generation) {
      inFlight = false;
      controls.button.disabled = !ready;
    }
  }
}

function codexErrorText(error: string | undefined): string {
  switch (error) {
    case 'account-id-not-configured': return text().codexAccountIdMissing;
    case 'admin-credentials-not-configured': return text().adminCredentialsMissing;
    case 'admin-login-expired': return text().adminLoginExpired;
    case 'admin-permission-denied': return text().adminPermissionDenied;
    default: return text().codexUnavailable;
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
  controls.codexLabel.textContent = locale.startsWith('zh') ? 'Codex 7d 已用' : 'Codex 7d used';
  if (initialized) return;
  initialized = true;
  ready = true;
  controls.button.disabled = false;
  void refresh();
  if (!timer) timer = setInterval(() => {
    if (!document.hidden) void refresh();
  }, 600_000);
});
controls.button.addEventListener('click', () => void refresh(true));
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
window.addEventListener('pagehide', () => {
  generation += 1;
  ready = false;
  if (timer) clearInterval(timer);
  host.dispose();
}, { once: true });
