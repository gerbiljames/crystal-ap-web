// Click-outside dismissal for a modal backdrop. A click's target is the
// common ancestor of where the press and release happened, so a drag that
// starts inside the dialog (selecting text in a field) and ends past its
// edge also "clicks" the backdrop. Only dismiss when both ends were on it.
export function backdropDismiss(close: () => void) {
  let pressedOnBackdrop = false;
  return {
    onPointerDown: (ev: PointerEvent) => { pressedOnBackdrop = ev.target === ev.currentTarget; },
    onClick: (ev: MouseEvent) => {
      if (pressedOnBackdrop && ev.target === ev.currentTarget) close();
      pressedOnBackdrop = false;
    },
  };
}
