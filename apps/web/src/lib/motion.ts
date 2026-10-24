// Live-data motion only: rows arriving, state flips. Every helper collapses to
// zero duration when the viewer prefers reduced motion.
import { fade, fly, slide, type FadeParams, type FlyParams, type SlideParams } from 'svelte/transition';
import { cubicOut } from 'svelte/easing';
import { prefersReducedMotion } from 'svelte/motion';

// A hidden or backgrounded page can freeze an animation mid-way, which leaves rows
// half transparent. Skip motion there, and never start from below 35% opacity.
const still = () => prefersReducedMotion.current || (typeof document !== 'undefined' && document.hidden);

/** A row or message arriving from the data source. */
export function arrive(node: Element, p: FlyParams = {}) {
	return fly(node, still() ? { duration: 0 } : { y: 8, duration: 220, easing: cubicOut, opacity: 0.35, ...p });
}

export function appear(node: Element, p: FadeParams = {}) {
	return fade(node, still() ? { duration: 0 } : { duration: 160, ...p });
}

export function reveal(node: Element, p: SlideParams = {}) {
	return slide(node, still() ? { duration: 0 } : { duration: 180, easing: cubicOut, ...p });
}
