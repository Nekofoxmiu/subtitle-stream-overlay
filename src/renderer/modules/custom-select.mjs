const customSelectRegistry = new Map();

export function setupCustomSelects(root = document) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const selects = Array.from(root.querySelectorAll('select'));
  selects.forEach((select) => {
    if (!select || customSelectRegistry.has(select)) return;
    const controller = enhanceCustomSelect(select);
    if (controller) {
      customSelectRegistry.set(select, controller);
      controller.refresh({ rebuildOptions: true });
    }
  });
}

export function refreshCustomSelect(select, { rebuildOptions = false } = {}) {
  if (!select) return;
  const controller = customSelectRegistry.get(select);
  if (controller) {
    controller.refresh({ rebuildOptions });
  }
}

function enhanceCustomSelect(select) {
  if (!select || select.dataset?.customSelect === 'enhanced') return null;
  const parent = select.parentElement;
  if (!parent) return null;

  const wrapper = document.createElement('div');
  wrapper.className = 'custom-select';
  const inlineStyle = select.getAttribute('style');
  if (inlineStyle) wrapper.setAttribute('style', inlineStyle);
  parent.insertBefore(wrapper, select);
  wrapper.appendChild(select);

  if (select.dataset.customSelectPlacement === 'dropup') {
    wrapper.classList.add('custom-select--dropup');
  }

  select.classList.add('custom-select__native');
  select.dataset.customSelect = 'enhanced';
  select.setAttribute('aria-hidden', 'true');
  select.tabIndex = -1;

  const uniqueKey = select.id || select.name || `custom-select-${customSelectRegistry.size + 1}`;
  const listId = `${uniqueKey}-listbox`;
  const displayId = `${uniqueKey}-value`;
  const triggerId = `${uniqueKey}-trigger`;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'custom-select__trigger';
  trigger.id = triggerId;
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', listId);

  const display = document.createElement('span');
  display.className = 'custom-select__display';
  const marquee = document.createElement('span');
  marquee.className = 'custom-select__marquee';
  marquee.dataset.paused = 'true';
  marquee.dataset.interacting = 'false';
  const primaryText = document.createElement('span');
  primaryText.className = 'custom-select__text';
  primaryText.id = displayId;
  const cloneText = document.createElement('span');
  cloneText.className = 'custom-select__text custom-select__text--clone';
  marquee.append(primaryText, cloneText);
  display.appendChild(marquee);
  trigger.appendChild(display);

  const icon = document.createElement('span');
  icon.className = 'custom-select__icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="6 9 12 15 18 9"></polyline>
    </svg>
  `;
  trigger.appendChild(icon);

  const list = document.createElement('ul');
  list.className = 'custom-select__list';
  list.id = listId;
  list.setAttribute('role', 'listbox');
  list.tabIndex = -1;
  list.hidden = true;

  wrapper.appendChild(trigger);
  wrapper.appendChild(list);

  const labelIds = [];
  if (select.id) {
    const labels = document.querySelectorAll(`label[for="${select.id}"]`);
    labels.forEach((label, idx) => {
      if (!label.id) {
        label.id = `${uniqueKey}-label${idx ? `-${idx}` : ''}`;
      }
      label.addEventListener('click', (ev) => {
        ev.preventDefault();
        trigger.focus();
        openMenu();
      });
      labelIds.push(label.id);
    });
  }
  if (labelIds.length) {
    trigger.setAttribute('aria-labelledby', `${labelIds.join(' ')} ${displayId}`.trim());
  } else {
    trigger.setAttribute('aria-labelledby', displayId);
  }

  let optionButtons = [];
  const optionMarquees = new WeakMap();
  let activeIndex = -1;
  let isOpen = false;
  let mirroredClasses = new Set();

  const restartAnimation = (element) => {
    if (!element) return;
    element.classList.remove('is-animating');
    void element.offsetWidth;
    element.classList.add('is-animating');
  };

  const startMarqueeAnimation = (element) => {
    if (!element) return;
    element.dataset.interacting = 'true';
    if (!element.classList.contains('is-marquee')) {
      element.dataset.paused = 'true';
      element.classList.remove('is-animating');
      return;
    }
    element.dataset.paused = 'false';
    restartAnimation(element);
  };

  const stopMarqueeAnimation = (element) => {
    if (!element) return;
    element.dataset.interacting = 'false';
    element.dataset.paused = 'true';
    element.classList.remove('is-animating');
  };

  const hasResizeObserver = typeof ResizeObserver === 'function';
  const resizeObserver = hasResizeObserver
    ? new ResizeObserver(() => {
        updateMarquee();
      })
    : null;
  if (resizeObserver) {
    resizeObserver.observe(display);
    resizeObserver.observe(primaryText);
  } else {
    window.addEventListener('resize', updateMarquee, { passive: true });
  }

  const observer = new MutationObserver((mutations) => {
    let shouldRebuild = false;
    let shouldRefreshSelection = false;
    let shouldSyncMeta = false;
    for (const mutation of mutations) {
      if (mutation.type === 'childList' || mutation.type === 'characterData') {
        shouldRebuild = true;
        continue;
      }
      if (mutation.type === 'attributes') {
        const target = mutation.target;
        if (target === select) {
          if (mutation.attributeName === 'style') shouldSyncMeta = true;
          if (mutation.attributeName === 'class') shouldSyncMeta = true;
          if (mutation.attributeName === 'disabled') shouldSyncMeta = true;
        } else if (target instanceof HTMLOptionElement || target instanceof HTMLOptGroupElement) {
          if (mutation.attributeName === 'label' || mutation.attributeName === 'value') shouldRebuild = true;
          if (mutation.attributeName === 'disabled') shouldRebuild = true;
          if (mutation.attributeName === 'selected') shouldRefreshSelection = true;
        }
      }
    }
    if (shouldRebuild) {
      rebuildOptions();
      shouldRefreshSelection = false;
    }
    if (shouldRefreshSelection) {
      updateSelection({ preserveActive: isOpen });
    }
    if (shouldSyncMeta || shouldRebuild) {
      syncDisabledState();
      syncMirroredClasses();
      syncInlineStyle();
      updateMarquee();
    }
  });
  observer.observe(select, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true
  });

  const handleDocumentPointerDown = (event) => {
    if (!wrapper.contains(event.target)) {
      closeMenu();
    }
  };

  function findNextEnabledIndex(startIndex, step) {
    const options = select.options;
    if (!options.length) return -1;
    let index = startIndex;
    for (let i = 0; i < options.length; i += 1) {
      if (index < 0) index = options.length - 1;
      if (index >= options.length) index = 0;
      const option = options[index];
      if (option && !option.disabled) return index;
      index += step;
    }
    return -1;
  }

  function highlightActive({ scrollIntoView = false } = {}) {
    const options = select.options;
    optionButtons.forEach((btn, idx) => {
      const option = options[idx];
      const isActive = idx === activeIndex && option && !option.disabled;
      btn.classList.toggle('is-active', isActive);
    });
    if (isOpen && optionButtons[activeIndex]) {
      trigger.setAttribute('aria-activedescendant', optionButtons[activeIndex].id);
      if (scrollIntoView) {
        optionButtons[activeIndex].scrollIntoView({ block: 'nearest' });
      }
    } else {
      trigger.removeAttribute('aria-activedescendant');
    }
  }

  function setActiveIndex(index, { scrollIntoView = false } = {}) {
    const options = select.options;
    if (!options.length) {
      activeIndex = -1;
      highlightActive({ scrollIntoView: false });
      return;
    }
    let target = index;
    if (target < 0 || target >= options.length || options[target]?.disabled) {
      target = findNextEnabledIndex(index, 1);
      if (target === -1) target = findNextEnabledIndex(index, -1);
    }
    activeIndex = target;
    highlightActive({ scrollIntoView });
  }

  function updateSelection({ preserveActive = false } = {}) {
    const options = Array.from(select.options);
    let selectedIndex = select.selectedIndex;
    if (selectedIndex < 0) {
      selectedIndex = options.findIndex((option) => option?.selected);
    }
    optionButtons.forEach((btn, idx) => {
      const option = options[idx];
      const isSelected = option ? option.selected : false;
      btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    });
    const selectedOption = options[selectedIndex] || options.find((option) => option && !option.disabled) || null;
    const label = selectedOption ? (selectedOption.textContent || selectedOption.label || '') : '';
    if (primaryText.textContent !== label) {
      primaryText.textContent = label;
    }
    if (cloneText.textContent !== label) {
      cloneText.textContent = label;
    }
    if (selectedOption?.title) trigger.title = selectedOption.title;
    else trigger.removeAttribute('title');
    if (!preserveActive) {
      if (selectedIndex != null && selectedIndex >= 0 && options[selectedIndex] && !options[selectedIndex].disabled) {
        activeIndex = selectedIndex;
      } else {
        activeIndex = findNextEnabledIndex(0, 1);
      }
    }
    highlightActive({ scrollIntoView: false });
    updateMarquee();
  }

  function stopOptionMarquee(optionEl) {
    const marqueeParts = optionMarquees.get(optionEl);
    if (!marqueeParts) return;
    const { marquee, clone } = marqueeParts;
    stopMarqueeAnimation(marquee);
    marquee.classList.remove('is-marquee');
    if (clone.textContent !== '') {
      clone.textContent = '';
    }
    marquee.style.removeProperty('--marquee-distance');
    marquee.style.removeProperty('--marquee-duration');
  }

  function startOptionMarquee(optionEl) {
    const marqueeParts = optionMarquees.get(optionEl);
    if (!marqueeParts) return;
    const { container, marquee, primary, clone } = marqueeParts;
    const containerWidth = container.offsetWidth;
    const textWidth = primary.scrollWidth;
    if (!containerWidth || !textWidth || textWidth <= containerWidth + 2) {
      stopOptionMarquee(optionEl);
      return;
    }
    const cloneLabel = primary.textContent || '';
    if (clone.textContent !== cloneLabel) {
      clone.textContent = cloneLabel;
    }
    const gapValue = (() => {
      const style = window.getComputedStyle(marquee);
      const gap = parseFloat(style.columnGap || style.gap || '0');
      return Number.isFinite(gap) ? gap : 0;
    })();
    const distance = textWidth + gapValue;
    const duration = Math.max(6, Math.min(30, distance / 36));
    marquee.style.setProperty('--marquee-distance', `${distance}px`);
    marquee.style.setProperty('--marquee-duration', `${duration}s`);
    marquee.classList.add('is-marquee');
    startMarqueeAnimation(marquee);
  }

  function stopAllOptionMarquees() {
    optionButtons.forEach((btn) => stopOptionMarquee(btn));
  }

  function rebuildOptions() {
    optionButtons = [];
    list.innerHTML = '';
    Array.from(select.options).forEach((option, index) => {
      const optionEl = document.createElement('li');
      optionEl.className = 'custom-select__option';
      optionEl.setAttribute('role', 'option');
      optionEl.id = `${listId}-option-${index}`;
      const optionLabel = option?.textContent || option?.label || '';
      optionEl.dataset.index = String(index);
      optionEl.dataset.value = option?.value ?? '';
      if (option?.title) optionEl.title = option.title;
      if (option?.disabled) optionEl.setAttribute('aria-disabled', 'true');
      optionEl.setAttribute('aria-selected', option?.selected ? 'true' : 'false');

      const label = document.createElement('span');
      label.className = 'custom-select__option-label';
      const marqueeEl = document.createElement('span');
      marqueeEl.className = 'custom-select__marquee';
      marqueeEl.dataset.paused = 'true';
      marqueeEl.dataset.interacting = 'false';
      const primaryEl = document.createElement('span');
      primaryEl.className = 'custom-select__text';
      primaryEl.textContent = optionLabel;
      const cloneEl = document.createElement('span');
      cloneEl.className = 'custom-select__text custom-select__text--clone';
      marqueeEl.append(primaryEl, cloneEl);
      label.appendChild(marqueeEl);
      optionEl.appendChild(label);
      optionMarquees.set(optionEl, {
        container: label,
        marquee: marqueeEl,
        primary: primaryEl,
        clone: cloneEl
      });

      optionEl.addEventListener('click', () => {
        if (option?.disabled) return;
        setActiveIndex(index, { scrollIntoView: false });
        commitIndex(index);
      });
      optionEl.addEventListener('pointerenter', () => {
        if (!isOpen || option?.disabled) return;
        setActiveIndex(index, { scrollIntoView: false });
        startOptionMarquee(optionEl);
      });
      optionEl.addEventListener('pointerleave', () => {
        stopOptionMarquee(optionEl);
      });
      optionButtons.push(optionEl);
      list.appendChild(optionEl);
    });
    updateSelection({ preserveActive: isOpen });
  }

  function syncDisabledState() {
    const disabled = select.disabled;
    trigger.disabled = disabled;
    trigger.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    wrapper.classList.toggle('is-disabled', disabled);
    if (disabled && isOpen) {
      closeMenu();
    }
  }

  function syncMirroredClasses() {
    const classes = Array.from(select.classList || []).filter((cls) => cls !== 'custom-select__native');
    const next = new Set(classes);
    Array.from(mirroredClasses).forEach((cls) => {
      if (!next.has(cls)) {
        wrapper.classList.remove(cls);
        mirroredClasses.delete(cls);
      }
    });
    next.forEach((cls) => {
      if (cls && !mirroredClasses.has(cls)) {
        wrapper.classList.add(cls);
        mirroredClasses.add(cls);
      }
    });
  }

  function syncInlineStyle() {
    const style = select.getAttribute('style');
    if (style) wrapper.setAttribute('style', style);
    else wrapper.removeAttribute('style');
  }

  function updateMarquee() {
    const containerWidth = display.offsetWidth;
    const textWidth = primaryText.scrollWidth;
    if (!containerWidth || !textWidth) {
      stopMarqueeAnimation(marquee);
      marquee.classList.remove('is-marquee');
      if (cloneText.textContent !== '') {
        cloneText.textContent = '';
      }
      marquee.style.removeProperty('--marquee-distance');
      marquee.style.removeProperty('--marquee-duration');
      delete marquee.dataset.marqueeLabel;
      delete marquee.dataset.marqueeDistance;
      delete marquee.dataset.marqueeDuration;
      return;
    }
    if (textWidth > containerWidth + 2) {
      const primaryLabel = primaryText.textContent || '';
      if (cloneText.textContent !== primaryLabel) {
        cloneText.textContent = primaryLabel;
      }
      const previousLabel = marquee.dataset.marqueeLabel || '';
      const gapValue = (() => {
        const style = window.getComputedStyle(marquee);
        const gap = parseFloat(style.columnGap || style.gap || '0');
        return Number.isFinite(gap) ? gap : 0;
      })();
      const distance = textWidth + gapValue;
      const duration = Math.max(6, Math.min(30, distance / 36));
      const distanceValue = `${distance}px`;
      const durationValue = `${duration}s`;
      const previousDistance = marquee.dataset.marqueeDistance || '';
      const previousDuration = marquee.dataset.marqueeDuration || '';
      const distanceChanged = previousDistance !== distanceValue;
      const durationChanged = previousDuration !== durationValue;
      const labelChanged = previousLabel !== primaryLabel;
      marquee.dataset.marqueeLabel = primaryLabel;
      marquee.dataset.marqueeDistance = distanceValue;
      marquee.dataset.marqueeDuration = durationValue;
      if (marquee.style.getPropertyValue('--marquee-distance') !== distanceValue) {
        marquee.style.setProperty('--marquee-distance', distanceValue);
      }
      if (marquee.style.getPropertyValue('--marquee-duration') !== durationValue) {
        marquee.style.setProperty('--marquee-duration', durationValue);
      }
      const wasMarquee = marquee.classList.contains('is-marquee');
      if (!wasMarquee) {
        marquee.classList.add('is-marquee');
      }
      const interacting = marquee.dataset.interacting === 'true';
      const shouldRestart = interacting && (!wasMarquee || labelChanged || distanceChanged || durationChanged);
      if (shouldRestart) {
        startMarqueeAnimation(marquee);
      } else if (!interacting) {
        marquee.dataset.paused = 'true';
        marquee.classList.remove('is-animating');
      }
    } else {
      stopMarqueeAnimation(marquee);
      marquee.classList.remove('is-marquee');
      if (cloneText.textContent !== '') {
        cloneText.textContent = '';
      }
      marquee.style.removeProperty('--marquee-distance');
      marquee.style.removeProperty('--marquee-duration');
      delete marquee.dataset.marqueeLabel;
      delete marquee.dataset.marqueeDistance;
      delete marquee.dataset.marqueeDuration;
    }
  }

  function moveActive(step) {
    const options = select.options;
    if (!options.length) return;
    if (activeIndex < 0) {
      setActiveIndex(findNextEnabledIndex(step > 0 ? 0 : options.length - 1, step), { scrollIntoView: true });
      return;
    }
    let index = activeIndex;
    for (let i = 0; i < options.length; i += 1) {
      index = (index + step + options.length) % options.length;
      const option = options[index];
      if (option && !option.disabled) {
        setActiveIndex(index, { scrollIntoView: true });
        return;
      }
    }
  }

  function commitIndex(index) {
    const options = select.options;
    const option = options[index];
    if (!option || option.disabled) return;
    const previousValue = select.value;
    select.selectedIndex = index;
    const changed = select.value !== previousValue;
    updateSelection({ preserveActive: false });
    if (changed) {
      const inputEvent = new Event('input', { bubbles: true });
      select.dispatchEvent(inputEvent);
      const changeEvent = new Event('change', { bubbles: true });
      select.dispatchEvent(changeEvent);
    }
    closeMenu({ focusTrigger: true });
  }

  function openMenu() {
    if (isOpen || select.disabled) return;
    isOpen = true;
    wrapper.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    list.hidden = false;
    const initialIndex = select.selectedIndex >= 0 ? select.selectedIndex : findNextEnabledIndex(0, 1);
    setActiveIndex(initialIndex >= 0 ? initialIndex : 0, { scrollIntoView: true });
    document.addEventListener('pointerdown', handleDocumentPointerDown, true);
  }

  function closeMenu({ focusTrigger = false } = {}) {
    if (!isOpen) return;
    isOpen = false;
    wrapper.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
    list.hidden = true;
    document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
    stopAllOptionMarquees();
    if (focusTrigger) {
      trigger.focus();
    }
  }

  trigger.addEventListener('click', () => {
    if (select.disabled) return;
    if (isOpen) closeMenu();
    else openMenu();
  });

  trigger.addEventListener('keydown', (event) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'Down':
        event.preventDefault();
        if (!isOpen) openMenu();
        moveActive(1);
        break;
      case 'ArrowUp':
      case 'Up':
        event.preventDefault();
        if (!isOpen) openMenu();
        moveActive(-1);
        break;
      case 'Home':
        event.preventDefault();
        if (!isOpen) openMenu();
        setActiveIndex(findNextEnabledIndex(0, 1), { scrollIntoView: true });
        break;
      case 'End':
        event.preventDefault();
        if (!isOpen) openMenu();
        setActiveIndex(findNextEnabledIndex(select.options.length - 1, -1), { scrollIntoView: true });
        break;
      case ' ': // Space
      case 'Spacebar':
      case 'Enter':
        event.preventDefault();
        if (isOpen) {
          commitIndex(activeIndex >= 0 ? activeIndex : select.selectedIndex);
        } else {
          openMenu();
        }
        break;
      case 'Escape':
      case 'Esc':
        if (isOpen) {
          event.preventDefault();
          closeMenu({ focusTrigger: true });
        }
        break;
      case 'Tab':
        closeMenu();
        break;
      default:
        break;
    }
  });

  wrapper.addEventListener('focusout', (event) => {
    if (!wrapper.contains(event.relatedTarget)) {
      closeMenu();
    }
  });

  const resumeTriggerMarquee = () => {
    startMarqueeAnimation(marquee);
  };
  const pauseTriggerMarquee = () => {
    stopMarqueeAnimation(marquee);
  };

  trigger.addEventListener('mouseenter', resumeTriggerMarquee);
  trigger.addEventListener('mouseleave', pauseTriggerMarquee);
  trigger.addEventListener('focus', resumeTriggerMarquee);
  trigger.addEventListener('blur', pauseTriggerMarquee);

  select.addEventListener('change', () => {
    updateSelection({ preserveActive: isOpen });
    syncDisabledState();
    syncMirroredClasses();
  });
  select.addEventListener('input', () => {
    updateSelection({ preserveActive: isOpen });
    syncDisabledState();
    syncMirroredClasses();
  });

  const refreshController = ({ rebuildOptions: shouldRebuild = false } = {}) => {
    if (shouldRebuild) {
      rebuildOptions();
    } else {
      updateSelection({ preserveActive: isOpen });
    }
    syncDisabledState();
    syncMirroredClasses();
    syncInlineStyle();
    updateMarquee();
  };

  return {
    refresh: refreshController
  };
}
