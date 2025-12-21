import { dom } from './dom.mjs';
import state from './state.mjs';

export function setControlCollapsed(collapsed) {
  state.controlCollapsed = Boolean(collapsed);
  applyControlVisibility();
}

export function applyControlVisibility() {
  const collapsed = state.controlCollapsed;
  const toggle = dom.controlToggle;
  const minimizeLabel = toggle?.dataset?.labelMinimize || '縮小控制面板';
  const restoreLabel = toggle?.dataset?.labelRestore || '恢復控制面板';
  if (dom.controlCard) {
    dom.controlCard.classList.toggle('card-collapsed', collapsed);
    dom.controlCard.style.display = collapsed ? 'none' : '';
  }
  dom.mainArea?.classList.toggle('controls-collapsed', collapsed);
  if (dom.controlRestore) {
    dom.controlRestore.textContent = restoreLabel;
    dom.controlRestore.setAttribute('aria-label', restoreLabel);
    dom.controlRestore.setAttribute('aria-controls', 'controlCard');
    dom.controlRestore.classList.toggle('visible', collapsed);
    dom.controlRestore.setAttribute('aria-hidden', collapsed ? 'false' : 'true');
    dom.controlRestore.title = restoreLabel;
    dom.controlRestore.disabled = !collapsed;
    dom.controlRestore.setAttribute('tabindex', collapsed ? '0' : '-1');
  }
  if (toggle) {
    const label = collapsed ? restoreLabel : minimizeLabel;
    toggle.textContent = label;
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('aria-controls', 'controlCard');
    toggle.setAttribute('aria-expanded', String(!collapsed));
  }
}

export function setPreviewMaximized(maximized) {
  state.previewMaximized = Boolean(maximized);
  applyPreviewMaximized();
}

export function applyPreviewMaximized() {
  const maximized = Boolean(state.previewMaximized);
  dom.appShell?.classList.toggle('preview-maximized', maximized);
  document.body.classList.toggle('preview-maximized', maximized);
  const btn = dom.previewExpand;
  if (btn) {
    const expandLabel = btn.dataset?.labelExpand || '放大預覽';
    const collapseLabel = btn.dataset?.labelCollapse || '還原預覽大小';
    const label = maximized ? collapseLabel : expandLabel;
    btn.textContent = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', String(maximized));
    btn.setAttribute('title', label);
  }
}

export function setSidebarOpen(open) {
  const action = open ? 'add' : 'remove';
  dom.advancedSidebar?.classList[action]('open');
  dom.sidebarOverlay?.classList[action]('visible');
  document.body.classList[action]('sidebar-open');
}
