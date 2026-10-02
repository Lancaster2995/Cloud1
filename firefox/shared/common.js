/* Small DOM helpers shared by the dashboard and the session toolbar. */
(function () {
  'use strict';

  /** h('div.card', {onclick}, child, 'text', ...) */
  function h(spec, attrs, ...children) {
    const [tag, ...classes] = spec.split('.');
    const el = document.createElement(tag || 'div');
    if (classes.length) el.className = classes.join(' ');
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
      children.unshift(attrs);
      attrs = null;
    }
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k.startsWith('on')) el.addEventListener(k.substring(2), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'text') el.textContent = v;
        else if (k in el && k !== 'list') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  let toastTimer = null;
  function toast(msg, ms) {
    let t = document.querySelector('.toast');
    if (!t) {
      t = h('div.toast');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || 3200);
  }

  /**
   * Modal dialog. `body` is a node; buttons: [{label, kind, onclick(close) -> false keeps open}].
   * Returns {close}. onOpen/onClose hooks let the toolbar grow over the page while open.
   */
  const hooks = { onOpen: null, onClose: null };
  let openCount = 0;
  function modal(title, body, buttons) {
    const overlay = h('div.overlay');
    const close = () => {
      if (!overlay.isConnected) return;
      overlay.remove();
      openCount--;
      if (openCount === 0 && hooks.onClose) hooks.onClose();
    };
    const actions = h('div.actions');
    for (const b of buttons || [{ label: 'Cerrar' }]) {
      actions.appendChild(h('button.btn' + (b.kind ? '.' + b.kind : ''), {
        type: 'button',
        onclick: async () => {
          try {
            if (b.onclick && (await b.onclick(close)) === false) return;
            close();
          } catch (e) {
            toast(e.message || String(e), 5000);
          }
        }
      }, b.label));
    }
    const dlg = h('div.dialog', { role: 'dialog' }, title ? h('h2', title) : null, body, actions);
    overlay.appendChild(dlg);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    if (openCount === 0 && hooks.onOpen) hooks.onOpen();
    openCount++;
    document.body.appendChild(overlay);
    const first = dlg.querySelector('input, select, textarea');
    setTimeout(() => (first || dlg.querySelector('.actions .btn:last-child')).focus(), 30);
    return { close, element: dlg };
  }

  function field(label, input) {
    return h('label', null, h('span.label', label), input);
  }

  /** "Estado automático" option of a project: {label, input}. */
  function autoStateBox(checked) {
    const input = h('input', { type: 'checkbox', checked: !!checked });
    const label = h('label.check', { title: 'Claude termina cada respuesta con el bloque de estado y Relevo lo guarda solo: si se acaban los mensajes, el progreso ya está guardado. Gasta un poco más de uso por respuesta.' },
      input, 'Estado automático: Claude deja el estado en cada respuesta y Relevo lo guarda solo');
    return { label, input };
  }

  window.UI = { h, toast, modal, field, hooks, autoStateBox };
})();
