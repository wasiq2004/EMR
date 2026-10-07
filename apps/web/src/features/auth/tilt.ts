'use client';

import * as React from 'react';

/**
 * A card that leans very slightly toward the pointer.
 *
 * WHY THIS IS SAFE TO PUT ON A SIGN-IN SCREEN, which is the one page that must
 * never feel heavy:
 *
 *   - It writes ONE `transform`. A 3D rotation is a composited property, so the
 *     browser hands it to the GPU and never re-lays-out the page. The cost is
 *     the same as nudging a box sideways.
 *   - It reads `getBoundingClientRect` ONCE PER ENTER, not per move. Reading
 *     layout inside a mousemove is what makes tilt effects stutter: every read
 *     after a write forces a synchronous reflow, sixty times a second.
 *   - It writes inside `requestAnimationFrame`, so several moves between two
 *     frames collapse into one write.
 *   - It does nothing at all for a coarse pointer or for reduced motion. A
 *     phone never runs it, and neither does anybody who has asked the system to
 *     stop moving things.
 *
 * The angle is deliberately small. Six degrees reads as the surface catching
 * the light; fifteen reads as a gimmick, and on a product somebody signs into
 * at eight in the morning before a clinic opens, a gimmick wears out in a week.
 */
const MAX_DEGREES = 6;

export function useTilt<T extends HTMLElement>() {
  const ref = React.useRef<T>(null);

  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;

    /*
     * Both conditions, not just reduced motion. A touch device has no hovering
     * pointer to follow, so the handler would only ever fire on a tap and snap
     * the card to an angle — worse than not having it.
     */
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    if (reduced.matches || !fine.matches) return;

    let frame = 0;
    let bounds: DOMRect | null = null;

    const onEnter = () => {
      bounds = node.getBoundingClientRect();
    };

    const onMove = (event: PointerEvent) => {
      if (!bounds) bounds = node.getBoundingClientRect();
      const rect = bounds;

      // -0.5 … 0.5 from the centre of the card.
      const x = (event.clientX - rect.left) / rect.width - 0.5;
      const y = (event.clientY - rect.top) / rect.height - 0.5;

      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        /*
         * Y drives rotateX and X drives rotateY — a pointer ABOVE the centre
         * should tip the top of the card away, which is a rotation about the
         * horizontal axis. Swapping them is the usual way this ends up feeling
         * subtly wrong without anyone being able to say why.
         */
        node.style.transform =
          `rotateX(${(-y * MAX_DEGREES).toFixed(2)}deg) ` +
          `rotateY(${(x * MAX_DEGREES).toFixed(2)}deg)`;
      });
    };

    const onLeave = () => {
      bounds = null;
      if (frame) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      // Back to flat. The CSS transition on `.tilt` carries it, so releasing
      // the card eases rather than snapping.
      node.style.transform = '';
    };

    node.addEventListener('pointerenter', onEnter);
    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerleave', onLeave);

    return () => {
      node.removeEventListener('pointerenter', onEnter);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerleave', onLeave);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return ref;
}
