const DEFAULT_PORT = 59837;
const storage = chrome?.storage?.local;

const dom = {
  toggle: document.getElementById('pluginToggle'),
  statusBadge: document.getElementById('statusBadge'),
  portForm: document.getElementById('portForm'),
  portInput: document.getElementById('portInput'),
  portPreview: document.getElementById('portPreview'),
  message: document.getElementById('message')
};

function sanitizePort(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PORT;
  return Math.min(65535, Math.max(1, parsed));
}

function updateStatusBadge(enabled) {
  dom.statusBadge.dataset.enabled = String(Boolean(enabled));
  dom.statusBadge.textContent = enabled ? '已啟用' : '已停用';
}

function updatePortPreview(port) {
  dom.portPreview.textContent = `http://localhost:${port}/overlay`;
}

function showMessage(text, type = '') {
  dom.message.textContent = text || '';
  dom.message.classList.remove('success', 'error');
  if (type) {
    dom.message.classList.add(type);
  }
  if (text) {
    setTimeout(() => {
      dom.message.textContent = '';
      dom.message.classList.remove('success', 'error');
    }, 2800);
  }
}

function applyInitialState({ pluginEnabled = true, pluginPort = DEFAULT_PORT } = {}) {
  const enabled = pluginEnabled !== false;
  const port = sanitizePort(pluginPort);
  dom.toggle.checked = enabled;
  dom.portInput.value = String(port);
  updateStatusBadge(enabled);
  updatePortPreview(port);
}

function persist(values) {
  if (!storage) return;
  storage.set(values, () => {
    if (chrome.runtime.lastError) {
      console.error('[popup] failed to persist', chrome.runtime.lastError);
      showMessage('儲存失敗，請稍後再試。', 'error');
      return;
    }
    const keys = Object.keys(values);
    if (keys.includes('pluginPort')) {
      showMessage('連接埠已更新。', 'success');
    }
  });
}

if (storage) {
  storage.get({ pluginEnabled: true, pluginPort: DEFAULT_PORT }, (items) => {
    applyInitialState(items);
  });
}

updateStatusBadge(dom.toggle.checked);
updatePortPreview(sanitizePort(dom.portInput.value || DEFAULT_PORT));

dom.toggle.addEventListener('change', () => {
  const enabled = dom.toggle.checked;
  updateStatusBadge(enabled);
  showMessage(enabled ? '插件已啟用。' : '插件已停用。', 'success');
  persist({ pluginEnabled: enabled });
});

dom.portInput.addEventListener('input', () => {
  const port = sanitizePort(dom.portInput.value);
  updatePortPreview(port);
});

dom.portForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const port = sanitizePort(dom.portInput.value);
  dom.portInput.value = String(port);
  updatePortPreview(port);
  persist({ pluginPort: port });
});

if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.pluginEnabled) {
      const enabled = changes.pluginEnabled.newValue !== false;
      dom.toggle.checked = enabled;
      updateStatusBadge(enabled);
    }
    if (changes.pluginPort) {
      const port = sanitizePort(changes.pluginPort.newValue);
      dom.portInput.value = String(port);
      updatePortPreview(port);
    }
  });
}
