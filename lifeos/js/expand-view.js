/* "View large" for any card whose content gets cramped — moves a chunk of
   the page into a big modal and back again, rather than cloning it.
   Reparenting (not cloning) is essential here: several of the things this
   gets used on — the Quill rich-text editors in meeting minutes, most
   importantly — are live, stateful widgets tied to a specific DOM node.
   Cloning would either duplicate the editor instance or leave the clone
   inert; moving the real node keeps it exactly one, exactly live, in
   whichever spot it currently belongs. */

let originalParent = null, originalNextSibling = null, movedEl = null;

export function expandView(elId, title) {
  const el = document.getElementById(elId);
  const modalBg = document.getElementById("expandModalBg");
  const modalContent = document.getElementById("expandModalContent");
  const modalTitle = document.getElementById("expandModalTitle");
  if (!el || !modalBg || !modalContent) return;

  originalParent = el.parentNode;
  originalNextSibling = el.nextSibling;
  movedEl = el;

  modalTitle.textContent = title || "";
  modalContent.appendChild(el);
  modalBg.classList.add("open");
}

export function closeExpandView() {
  const modalBg = document.getElementById("expandModalBg");
  if (movedEl && originalParent) {
    originalParent.insertBefore(movedEl, originalNextSibling);
  }
  movedEl = originalParent = originalNextSibling = null;
  if (modalBg) modalBg.classList.remove("open");
}
