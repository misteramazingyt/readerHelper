// ui.js — toasts, modals, context menus, and a small declarative form builder.
//
// Every dialog in the app (add book, DOI import, Todoist task, move/copy
// pickers, settings) is described as a field list and rendered by openForm, so
// they share focus handling, Esc/Enter behaviour, and mobile layout.

const toastHost = () => document.getElementById('toasts');
const modalHost = () => document.getElementById('modal-root');
const menuHost = () => document.getElementById('menu-root');

// -------------------------------------------------------------------- toast

let toastSeq = 0;

export function toast(message, { type = 'info', timeout = 3200, action } = {}) {
  const host = toastHost();
  if (!host) return null;
  const id = `toast_${(toastSeq += 1)}`;
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.id = id;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const text = document.createElement('span');
  text.className = 'toast__text';
  text.textContent = message;
  el.appendChild(text);

  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast__action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      action.onClick?.();
      el.remove();
    });
    el.appendChild(btn);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast__close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => el.remove());
  el.appendChild(close);

  host.appendChild(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}

export function errorToast(err, prefix = '') {
  const msg = err?.message || String(err);
  console.error(prefix, err);
  return toast(prefix ? `${prefix}: ${msg}` : msg, { type: 'error', timeout: 6000 });
}

// -------------------------------------------------------------------- modal

let openModalCount = 0;

/**
 * Low-level modal. `render(body, close)` fills the content; the returned promise
 * resolves with whatever `close(value)` is called with (null when dismissed).
 */
export function openModal({ title, render, width = 'normal', dismissable = true, onOpen }) {
  const host = modalHost();
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const dialog = document.createElement('div');
    dialog.className = `modal modal--${width}`;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    if (title) dialog.setAttribute('aria-label', title);

    const previousFocus = document.activeElement;
    let settled = false;
    const close = (value = null) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      openModalCount -= 1;
      if (openModalCount === 0) document.body.classList.remove('modal-open');
      document.removeEventListener('keydown', onKey, true);
      if (previousFocus?.focus) setTimeout(() => previousFocus.focus(), 0);
      resolve(value);
    };

    const onKey = (e) => {
      if (e.key === 'Escape' && dismissable) {
        e.stopPropagation();
        close(null);
      } else if (e.key === 'Tab') {
        trapFocus(dialog, e);
      }
    };

    if (title) {
      const header = document.createElement('header');
      header.className = 'modal__header';
      const h = document.createElement('h2');
      h.className = 'modal__title';
      h.textContent = title;
      header.appendChild(h);
      if (dismissable) {
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'modal__close';
        x.setAttribute('aria-label', 'Close');
        x.textContent = '×';
        x.addEventListener('click', () => close(null));
        header.appendChild(x);
      }
      dialog.appendChild(header);
    }

    const body = document.createElement('div');
    body.className = 'modal__body';
    dialog.appendChild(body);

    overlay.appendChild(dialog);
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay && dismissable) close(null);
    });

    host.appendChild(overlay);
    openModalCount += 1;
    document.body.classList.add('modal-open');
    document.addEventListener('keydown', onKey, true);

    render(body, close, dialog);
    onOpen?.(dialog, close);

    const first = dialog.querySelector('input, textarea, select, button:not(.modal__close)');
    setTimeout(() => first?.focus(), 30);
  });
}

function trapFocus(container, e) {
  const focusables = [...container.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((el) => el.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// ------------------------------------------------------------- form builder

/**
 * Render a form from a field spec and resolve with an object of values, or null
 * if dismissed.
 *
 * field: { name, label, type, value, placeholder, options, hint, required,
 *          rows, min, max, step, autofocus }
 * type: text | textarea | number | select | checkbox | tags | static | password
 */
export function openForm({ title, fields, submitLabel = 'Save', cancelLabel = 'Cancel', width, intro, validate, extraActions }) {
  return openModal({
    title,
    width,
    render: (body, close) => {
      const form = document.createElement('form');
      form.className = 'form';
      form.noValidate = true;

      if (intro) {
        const p = document.createElement('p');
        p.className = 'form__intro';
        p.textContent = intro;
        form.appendChild(p);
      }

      const controls = new Map();
      for (const field of fields) {
        if (field.type === 'static') {
          const row = document.createElement('div');
          row.className = 'form__static';
          row.innerHTML = '';
          const label = document.createElement('span');
          label.className = 'form__static-label';
          label.textContent = field.label;
          const val = document.createElement('span');
          val.className = 'form__static-value';
          val.textContent = field.value ?? '';
          row.append(label, val);
          form.appendChild(row);
          continue;
        }

        const row = document.createElement('div');
        row.className = `form__row form__row--${field.type || 'text'}`;
        const id = `f_${field.name}`;

        let input;
        if (field.type === 'textarea') {
          input = document.createElement('textarea');
          input.rows = field.rows || 4;
        } else if (field.type === 'select') {
          input = document.createElement('select');
          for (const opt of field.options || []) {
            const o = document.createElement('option');
            o.value = opt.value;
            o.textContent = opt.label;
            if (String(opt.value) === String(field.value)) o.selected = true;
            input.appendChild(o);
          }
        } else {
          input = document.createElement('input');
          input.type = field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text';
          if (field.min !== undefined) input.min = field.min;
          if (field.max !== undefined) input.max = field.max;
          if (field.step !== undefined) input.step = field.step;
          if (field.type === 'checkbox') input.type = 'checkbox';
        }

        input.id = id;
        input.name = field.name;
        if (field.placeholder) input.placeholder = field.placeholder;
        if (field.autocomplete) input.autocomplete = field.autocomplete;
        if (field.type === 'checkbox') input.checked = Boolean(field.value);
        else if (field.type !== 'select') input.value = field.value ?? '';

        const label = document.createElement('label');
        label.className = 'form__label';
        label.htmlFor = id;
        label.textContent = field.label;

        if (field.type === 'checkbox') {
          row.classList.add('form__row--inline');
          row.append(input, label);
        } else {
          row.append(label, input);
        }

        if (field.hint) {
          const hint = document.createElement('small');
          hint.className = 'form__hint';
          hint.textContent = field.hint;
          row.appendChild(hint);
        }

        const err = document.createElement('small');
        err.className = 'form__error';
        err.hidden = true;
        row.appendChild(err);

        form.appendChild(row);
        controls.set(field.name, { input, field, err });
        if (field.autofocus) setTimeout(() => input.focus(), 40);
      }

      const readValues = () => {
        const out = {};
        for (const [name, { input, field }] of controls) {
          if (field.type === 'checkbox') out[name] = input.checked;
          else if (field.type === 'number') out[name] = input.value === '' ? null : Number(input.value);
          else out[name] = input.value.trim();
        }
        return out;
      };

      const footer = document.createElement('div');
      footer.className = 'form__actions';

      for (const extra of extraActions || []) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn--ghost';
        btn.textContent = extra.label;
        btn.addEventListener('click', () => extra.onClick(readValues, close, controls));
        footer.appendChild(btn);
      }

      const spacer = document.createElement('div');
      spacer.className = 'form__spacer';
      footer.appendChild(spacer);

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn btn--ghost';
      cancel.textContent = cancelLabel;
      cancel.addEventListener('click', () => close(null));

      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.className = 'btn btn--primary';
      submit.textContent = submitLabel;

      footer.append(cancel, submit);
      form.appendChild(footer);

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        for (const { err } of controls.values()) err.hidden = true;
        const values = readValues();

        for (const [name, { field, err }] of controls) {
          if (field.required && (values[name] === '' || values[name] == null)) {
            err.textContent = `${field.label} is required.`;
            err.hidden = false;
            controls.get(name).input.focus();
            return;
          }
        }
        const problems = validate?.(values) || null;
        if (problems) {
          for (const [name, message] of Object.entries(problems)) {
            const c = controls.get(name);
            if (c) {
              c.err.textContent = message;
              c.err.hidden = false;
            }
          }
          return;
        }
        close(values);
      });

      // Ctrl/Cmd+Enter submits from a textarea, where Enter inserts a newline.
      form.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          form.requestSubmit();
        }
      });

      body.appendChild(form);
    },
  });
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, checkboxes = [] }) {
  return openModal({
    title,
    render: (body, close) => {
      const p = document.createElement('p');
      p.className = 'confirm__message';
      p.textContent = message;
      body.appendChild(p);

      const boxes = new Map();
      for (const cb of checkboxes) {
        const row = document.createElement('label');
        row.className = 'confirm__checkbox';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = Boolean(cb.value);
        const span = document.createElement('span');
        span.textContent = cb.label;
        row.append(input, span);
        body.appendChild(row);
        boxes.set(cb.name, input);
      }

      const actions = document.createElement('div');
      actions.className = 'form__actions';
      const spacer = document.createElement('div');
      spacer.className = 'form__spacer';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn btn--ghost';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => close(null));
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = `btn ${danger ? 'btn--danger' : 'btn--primary'}`;
      ok.textContent = confirmLabel;
      ok.addEventListener('click', () => {
        const out = { confirmed: true };
        for (const [name, input] of boxes) out[name] = input.checked;
        close(out);
      });
      actions.append(spacer, cancel, ok);
      body.appendChild(actions);
      setTimeout(() => ok.focus(), 30);
    },
  });
}

// ------------------------------------------------------------- context menu

let activeMenu = null;

export function closeContextMenu() {
  activeMenu?.remove();
  activeMenu = null;
}

/**
 * items: [{ label, onClick, danger, disabled, icon, submenu, separator, hint }]
 * Positioned at (x, y) and flipped to stay on screen; on narrow viewports it
 * becomes a bottom sheet instead, which is far easier to hit with a thumb.
 */
export function openContextMenu(x, y, items) {
  closeContextMenu();
  const host = menuHost();
  const isSheet = window.matchMedia('(max-width: 720px)').matches;

  const wrap = document.createElement('div');
  wrap.className = isSheet ? 'menu-sheet-overlay' : 'menu-overlay';

  const menu = document.createElement('div');
  menu.className = isSheet ? 'context-menu context-menu--sheet' : 'context-menu';
  menu.setAttribute('role', 'menu');

  const build = (list, container) => {
    for (const item of list) {
      if (item.separator) {
        const hr = document.createElement('div');
        hr.className = 'context-menu__sep';
        container.appendChild(hr);
        continue;
      }
      if (item.heading) {
        const h = document.createElement('div');
        h.className = 'context-menu__heading';
        h.textContent = item.heading;
        container.appendChild(h);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'context-menu__item';
      btn.setAttribute('role', 'menuitem');
      if (item.danger) btn.classList.add('is-danger');
      if (item.disabled) btn.disabled = true;
      if (item.submenu) btn.classList.add('has-submenu');

      const label = document.createElement('span');
      label.className = 'context-menu__label';
      label.textContent = item.label;
      btn.appendChild(label);

      if (item.hint) {
        const hint = document.createElement('span');
        hint.className = 'context-menu__hint';
        hint.textContent = item.hint;
        btn.appendChild(hint);
      }
      if (item.submenu) {
        const caret = document.createElement('span');
        caret.className = 'context-menu__caret';
        caret.textContent = '›';
        btn.appendChild(caret);
      }

      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (item.disabled) return;
        if (item.submenu) {
          const entries = typeof item.submenu === 'function' ? await item.submenu() : item.submenu;
          container.replaceChildren();
          build(
            [{ label: '‹ Back', onClick: () => { container.replaceChildren(); build(list, container); } }, { separator: true }, ...entries],
            container,
          );
          return;
        }
        closeContextMenu();
        item.onClick?.();
      });
      container.appendChild(btn);
    }
  };

  build(items, menu);
  wrap.appendChild(menu);
  host.appendChild(wrap);
  activeMenu = wrap;

  if (!isSheet) {
    const r = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - r.width - 8);
    const top = Math.min(y, window.innerHeight - r.height - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
  }

  wrap.addEventListener('pointerdown', (e) => {
    if (!menu.contains(e.target)) closeContextMenu();
  });
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeContextMenu();
      document.removeEventListener('keydown', onKey, true);
    }
  };
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => menu.querySelector('.context-menu__item')?.focus(), 20);
  return menu;
}

// ------------------------------------------------------------------ helpers

/** Turn an element into an inline-editable field; resolves on blur or Enter. */
export function editInline(el, currentValue, onCommit, { multiline = false, selectAll = true } = {}) {
  const input = document.createElement(multiline ? 'textarea' : 'input');
  input.className = 'inline-edit';
  input.value = currentValue ?? '';
  if (!multiline) input.type = 'text';
  el.replaceChildren(input);
  input.focus();
  if (selectAll) input.select();

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    onCommit(commit && value ? value : null);
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  return input;
}

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function showBusy(message) {
  let overlay = document.getElementById('busy-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'busy-overlay';
    overlay.className = 'busy-overlay';
    overlay.innerHTML = '<div class="busy-box"><div class="spinner"></div><div class="busy-text"></div></div>';
    document.body.appendChild(overlay);
  }
  overlay.querySelector('.busy-text').textContent = message;
  overlay.hidden = false;
  return {
    update: (m) => { overlay.querySelector('.busy-text').textContent = m; },
    done: () => { overlay.hidden = true; },
  };
}
