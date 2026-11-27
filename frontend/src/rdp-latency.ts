import { RDP_WINDOW } from '../../src/rdp-schema';
import { t, type TranslationKey } from './i18n';

const candidateKinds = new Set(['host', 'srflx', 'prflx']);
const bounded = (value: unknown, max: number) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : null;
const ms = (value: unknown, max = 60000) => {
  const number = bounded(value, max);
  return number === null ? '—' : `${number} ms`;
};
const setText = (element: HTMLElement, value: string) => {
  if (element.textContent !== value) element.textContent = value;
};

/** A one-line readout with a native disclosure for touch and keyboard. No live-region chatter. */
export function createRdpLatencyMeter() {
  const element = document.createElement('details');
  element.className = 'rdp-latency';
  element.hidden = true;
  const summary = document.createElement('summary');
  const label = document.createElement('span');
  summary.append(label);
  const panel = document.createElement('div');
  panel.className = 'rdp-latency-panel';
  const title = document.createElement('p');
  title.className = 'rdp-latency-title';
  title.textContent = t('rdp.latencyTitle');
  const rows = document.createElement('dl');
  const row = (key: TranslationKey, name: string) => {
    const item = document.createElement('div');
    item.dataset.metric = name;
    const term = document.createElement('dt');
    term.textContent = t(key);
    const value = document.createElement('dd');
    item.append(term, value);
    rows.append(item);
    return { item, term, value };
  };
  const link = row('rdp.latencyLink', 'link');
  const channel = row('rdp.latencyChannel', 'channel');
  const peak = row('rdp.latencyPeak', 'peak');
  const windows = row('rdp.latencyRdp', 'rdp');
  const receive = row('rdp.latencyReceive', 'receive');
  const kinds = row('rdp.latencyIcePath', 'ice');
  const hint = document.createElement('p');
  hint.className = 'rdp-latency-hint';
  panel.append(title, rows, hint);
  element.append(summary, panel);
  const close = () => { element.open = false; };
  element.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !element.open) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  return {
    element,
    close,
    update(value: unknown) {
      if (value === null) {
        close();
        element.hidden = true;
        return;
      }
      if (!value || typeof value !== 'object') return;
      const data = value as Record<string, unknown>;
      if (data.path !== 'webrtc' && data.path !== 'relay') return;
      const peer = data.path === 'webrtc';
      const relay = t('rdp.latencyRelay');
      const iceMs = bounded(data.iceMs, 60000);
      const channelMs = bounded(data.channelMs, 5000);
      const summaryText = peer
        ? iceMs !== null || channelMs === null
          ? `WebRTC ${ms(iceMs)}`
          : `WebRTC · ${t('rdp.latencyChannelShort')} ${ms(channelMs)}`
        : `${relay} ${ms(channelMs)}`;
      setText(label, summaryText);
      const accessibleLabel = `${t('rdp.latencyTitle')}: ${summaryText}`;
      if (summary.getAttribute('aria-label') !== accessibleLabel) summary.setAttribute('aria-label', accessibleLabel);
      link.item.hidden = !peer;
      setText(link.value, ms(iceMs));
      setText(channel.term, peer ? t('rdp.latencyChannel') : relay);
      setText(channel.value, ms(channelMs));
      setText(peak.value, ms(data.channelPeakMs, 5000));
      setText(windows.value, ms(data.rdpMs));
      const bytes = bounded(data.receiveBytes, RDP_WINDOW);
      setText(receive.value, bytes === null ? '—' : bytes >= 1024 ? `${Math.round(bytes / 1024)} KiB` : `${bytes} B`);
      const types = Array.isArray(data.candidateTypes) && data.candidateTypes.length === 2 ? data.candidateTypes : null;
      const validTypes = types && candidateKinds.has(types[0]) && candidateKinds.has(types[1]);
      kinds.item.hidden = !peer || !validTypes;
      if (peer && validTypes) setText(kinds.value, `${types[0]} / ${types[1]}`);
      setText(hint, t(peer ? 'rdp.latencyPeerHint' : 'rdp.latencyRelayHint'));
      element.hidden = false;
    },
  };
}
