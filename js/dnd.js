// dnd.js — pointer-based drag and drop for cards, columns, and sidebar rows.
//
// Built on Pointer Events rather than HTML5 drag-and-drop, which never fires on
// touch devices. One consequence shapes the design: on touch we cannot both
// scroll a column and drag from anywhere inside it, so touch drags must start
// on an explicit grip ([data-drag-handle], touch-action:none) while mouse drags
// can start anywhere on the element.

const DRAG_THRESHOLD = 5;      // px of movement before a mouse press becomes a drag
const TOUCH_HOLD_MS = 320;     // long-press before a touch becomes a drag
const EDGE = 60;               // auto-scroll hot zone at container edges
const EDGE_SPEED = 14;

let controller = null;

export function initDnd(options) {
  controller?.destroy();
  controller = new DragController(options);
  return controller;
}

export function isDragging() {
  return Boolean(controller?.active);
}

class DragController {
  /**
   * @param {object} o
   * @param {(drag: object) => void} o.onDrop  called with {type, id, ids, targetZone, index}
   * @param {() => string[]} o.getSelection    ids currently multi-selected
   * @param {HTMLElement} o.root
   */
  constructor(o) {
    this.o = o;
    this.root = o.root || document.body;
    this.active = null;
    this.pending = null;
    this.ghost = null;
    this.placeholder = null;
    this.holdTimer = null;
    this.scrollRaf = null;
    this.lastPoint = { x: 0, y: 0 };

    this.onPointerDown = this.handlePointerDown.bind(this);
    this.onPointerMove = this.handlePointerMove.bind(this);
    this.onPointerUp = this.handlePointerUp.bind(this);
    this.onKeyDown = (e) => {
      if (e.key === 'Escape' && this.active) this.cancel();
    };

    // A drag ends with a pointerup on the item, which the browser then turns
    // into a click — opening the book you just dragged, or switching project.
    // Swallow exactly one click after a real drag.
    this.swallowNextClick = false;
    this.onClickCapture = (e) => {
      if (!this.swallowNextClick) return;
      this.swallowNextClick = false;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('click', this.onClickCapture, true);

    this.root.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove, { passive: false });
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
  }

  destroy() {
    this.cancel();
    this.root.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('click', this.onClickCapture, true);
  }

  handlePointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;

    const el = e.target.closest('[data-drag]');
    if (!el || !this.root.contains(el)) return;

    const handle = e.target.closest('[data-drag-handle]');

    // Never hijack a press meant to operate a control. The draggable item may
    // itself be a button (sidebar project rows are), so only an interactive
    // element *inside* it blocks the drag — and the grip always wins.
    if (!handle) {
      const control = e.target.closest('input, textarea, select, button, a, [contenteditable="true"], [data-no-drag]');
      if (control && control !== el) return;
    }

    const isTouch = e.pointerType === 'touch' || e.pointerType === 'pen';
    if (isTouch && !handle) return;

    this.pending = {
      el,
      type: el.dataset.drag,
      id: el.dataset.dragId,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      isTouch,
    };

    if (isTouch) {
      this.holdTimer = setTimeout(() => {
        if (this.pending) this.begin(this.pending, this.lastPoint.x || this.pending.startX, this.lastPoint.y || this.pending.startY);
      }, TOUCH_HOLD_MS);
    }
  }

  handlePointerMove(e) {
    this.lastPoint = { x: e.clientX, y: e.clientY };

    if (this.pending && !this.active) {
      const dx = Math.abs(e.clientX - this.pending.startX);
      const dy = Math.abs(e.clientY - this.pending.startY);
      if (this.pending.isTouch) {
        // Movement before the hold timer means the user is scrolling, not dragging.
        if (dx > DRAG_THRESHOLD * 2 || dy > DRAG_THRESHOLD * 2) this.clearPending();
      } else if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
        this.begin(this.pending, e.clientX, e.clientY);
      }
    }

    if (!this.active) return;
    e.preventDefault();
    this.moveGhost(e.clientX, e.clientY);
    this.updateDropTarget(e.clientX, e.clientY);
    this.queueEdgeScroll();
  }

  handlePointerUp() {
    this.clearPending();
    if (!this.active) return;
    const drag = this.active;
    const drop = drag.currentDrop;
    this.swallowNextClick = true;
    // If no click follows (a drop onto a different element), clear the latch so
    // it cannot eat an unrelated click later.
    setTimeout(() => { this.swallowNextClick = false; }, 350);
    this.teardown();
    if (drop && drop.zone) {
      this.o.onDrop?.({
        type: drag.type,
        id: drag.id,
        ids: drag.ids,
        zoneType: drop.zone.dataset.dropZone,
        zoneId: drop.zone.dataset.dropId,
        index: drop.index,
      });
    } else {
      this.o.onCancel?.();
    }
  }

  clearPending() {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.pending = null;
  }

  begin(pending, x, y) {
    this.clearPending();
    const { el, type, id } = pending;

    // Dragging a selected card carries the whole selection.
    const selection = this.o.getSelection?.() || [];
    const ids = type === 'card' && selection.includes(id) && selection.length > 1 ? selection : [id];

    const rect = el.getBoundingClientRect();
    this.active = {
      el,
      type,
      id,
      ids,
      offsetX: x - rect.left,
      offsetY: y - rect.top,
      width: rect.width,
      height: rect.height,
      currentDrop: null,
    };

    this.ghost = el.cloneNode(true);
    this.ghost.classList.add('drag-ghost');
    this.ghost.style.width = `${rect.width}px`;
    this.ghost.style.height = `${rect.height}px`;
    if (ids.length > 1) {
      const badge = document.createElement('div');
      badge.className = 'drag-count';
      badge.textContent = String(ids.length);
      this.ghost.appendChild(badge);
    }
    document.body.appendChild(this.ghost);
    this.moveGhost(x, y);

    this.placeholder = document.createElement('div');
    this.placeholder.className = `drop-placeholder drop-placeholder--${type}`;

    for (const dragId of ids) {
      const node = this.root.querySelector(`[data-drag="${type}"][data-drag-id="${cssEscape(dragId)}"]`);
      node?.classList.add('is-dragging');
    }
    document.body.classList.add('is-dnd-active');
  }

  moveGhost(x, y) {
    if (!this.ghost) return;
    this.ghost.style.transform = `translate(${x - this.active.offsetX}px, ${y - this.active.offsetY}px)`;
  }

  /** Find the zone under the pointer and where within it the drop would land. */
  updateDropTarget(x, y) {
    const drag = this.active;
    this.ghost.style.visibility = 'hidden';
    const under = document.elementFromPoint(x, y);
    this.ghost.style.visibility = '';
    if (!under) return;

    const zone = under.closest(`[data-drop-zone][data-accept~="${drag.type}"]`);
    if (!zone) {
      this.placeholder.remove();
      drag.currentDrop = null;
      document.querySelectorAll('.is-drop-target').forEach((n) => n.classList.remove('is-drop-target'));
      return;
    }

    document.querySelectorAll('.is-drop-target').forEach((n) => {
      if (n !== zone) n.classList.remove('is-drop-target');
    });
    zone.classList.add('is-drop-target');

    const horizontal = zone.dataset.axis === 'x';
    const siblings = [...zone.querySelectorAll(`:scope > [data-drag="${drag.type}"]`)].filter(
      (n) => !n.classList.contains('is-dragging'),
    );

    let index = siblings.length;
    for (let i = 0; i < siblings.length; i += 1) {
      const r = siblings[i].getBoundingClientRect();
      const midpoint = horizontal ? r.left + r.width / 2 : r.top + r.height / 2;
      const pos = horizontal ? x : y;
      if (pos < midpoint) {
        index = i;
        break;
      }
    }

    // A trailing "+" button must stay last, so park the placeholder before it.
    const before = siblings[index] || zone.querySelector(':scope > [data-drop-tail]') || null;
    if (before) zone.insertBefore(this.placeholder, before);
    else zone.appendChild(this.placeholder);

    drag.currentDrop = { zone, index };
  }

  /** Scroll the nearest scrollable ancestor when the pointer nears its edge. */
  queueEdgeScroll() {
    if (this.scrollRaf) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = null;
      if (!this.active) return;
      const { x, y } = this.lastPoint;
      this.ghost.style.visibility = 'hidden';
      const under = document.elementFromPoint(x, y);
      this.ghost.style.visibility = '';
      if (!under) return;

      for (const el of scrollableAncestors(under)) {
        const r = el.getBoundingClientRect();
        let did = false;
        if (el.scrollHeight > el.clientHeight) {
          if (y - r.top < EDGE) { el.scrollTop -= EDGE_SPEED; did = true; }
          else if (r.bottom - y < EDGE) { el.scrollTop += EDGE_SPEED; did = true; }
        }
        if (el.scrollWidth > el.clientWidth) {
          if (x - r.left < EDGE) { el.scrollLeft -= EDGE_SPEED; did = true; }
          else if (r.right - x < EDGE) { el.scrollLeft += EDGE_SPEED; did = true; }
        }
        if (did) break;
      }
    });
  }

  cancel() {
    if (!this.active) {
      this.clearPending();
      return;
    }
    this.teardown();
    this.o.onCancel?.();
  }

  teardown() {
    this.ghost?.remove();
    this.placeholder?.remove();
    this.ghost = null;
    this.placeholder = null;
    this.active = null;
    if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
    this.scrollRaf = null;
    document.querySelectorAll('.is-dragging').forEach((n) => n.classList.remove('is-dragging'));
    document.querySelectorAll('.is-drop-target').forEach((n) => n.classList.remove('is-drop-target'));
    document.body.classList.remove('is-dnd-active');
  }
}

function* scrollableAncestors(el) {
  let node = el;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY + style.overflowX)) yield node;
    node = node.parentElement;
  }
}

function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}
