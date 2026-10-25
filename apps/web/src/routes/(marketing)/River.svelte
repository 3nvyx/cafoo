<script lang="ts">
	// A river winding down the page behind the content. It rises under the lower half of the
	// element matched by `from` (the hero, whose painted sky paints the same current, so the
	// hairlines pour out of the brushwork), meanders, and narrows away before `to`. Its currents are
	// evenly spaced hairlines (flow.ts); scrolling slides a glint along each one downstream, a
	// little faster than the page moves. The lines themselves never move, so nothing pops.
	// Under reduced motion the glints stay put. One viewport-sized canvas draws the visible part.
	import { prefersReducedMotion } from 'svelte/motion';
	import { drawLines, noise2, riverPath, streamlines, type Line } from './flow';

	let {
		from = '',
		to = '',
		seed = 5,
		sep = 11,
		lineAlpha = 0.18,
		glintAlpha = 0.6
	}: { from?: string; to?: string; seed?: number; sep?: number; lineAlpha?: number; glintAlpha?: number } = $props();

	const FLOW = 0.6; // glint travel per pixel scrolled

	function river(w: number, start: number, end: number): Line[] {
		const n = noise2(seed);
		const { centre, breadth } = riverPath(w, seed);
		// Full width soon after the source, which sits under the paint; narrow to a point at the mouth.
		const taper = (y: number) => Math.max(0, Math.min(1, (y - start) / 120, (end - y) / 420));
		const slope = (y: number) => (centre(y + 2) - centre(y - 2)) / 4;
		const field = (x: number, y: number) => Math.atan2(1, slope(y)) + 0.32 * n(x * 0.006, y * 0.0035);
		const inside = (x: number, y: number) => Math.abs(x - centre(y)) < (breadth(y) / 2) * taper(y);
		return streamlines(field, { x0: 0, y0: start, x1: w, y1: end, sep, seed, inside, minLength: sep * 8 });
	}

	function paint(canvas: HTMLCanvasElement) {
		let lines: Line[] = [];
		let built = '';
		let raf = 0;

		const draw = () => {
			raf = 0;
			const w = window.innerWidth;
			const vh = window.innerHeight;
			const ctx = canvas.getContext('2d');
			if (!ctx) return;
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(vh * dpr)) {
				canvas.width = Math.round(w * dpr);
				canvas.height = Math.round(vh * dpr);
			}

			const scroll = window.scrollY;
			const fromEl = from ? document.querySelector(from) : null;
			const toEl = to ? document.querySelector(to) : null;
			const fromBox = fromEl?.getBoundingClientRect();
			// The source sits under the hero's paint; the lines fade in across its lower part, where
			// the painted current runs, so they come out of the brushwork rather than out of nothing.
			const start = Math.round(fromBox ? fromBox.top + fromBox.height * 0.55 + scroll : 0);
			const emerged = Math.round(fromBox ? fromBox.top + fromBox.height * 0.92 + scroll : 0);
			const end = Math.round(toEl ? toEl.getBoundingClientRect().top + scroll : document.documentElement.scrollHeight);
			// Lay the river out again only when the page's width or length changes.
			const key = `${w}:${start}:${end}`;
			if (key !== built) {
				built = key;
				lines = river(w, start, end);
			}

			ctx.setTransform(dpr, 0, 0, dpr, 0, -scroll * dpr);
			ctx.clearRect(0, scroll, w, vh);
			const css = getComputedStyle(canvas);
			drawLines(ctx, lines, {
				line: css.getPropertyValue('--ink-3').trim(),
				glint: css.getPropertyValue('--accent').trim(),
				lineAlpha,
				glintAlpha,
				offset: prefersReducedMotion.current ? 0 : scroll * FLOW,
				top: scroll - 40,
				bottom: scroll + vh + 40
			});
			if (emerged > scroll) {
				const fade = ctx.createLinearGradient(0, start, 0, emerged);
				fade.addColorStop(0, 'rgb(0 0 0 / 0)');
				fade.addColorStop(1, 'rgb(0 0 0 / 1)');
				ctx.globalCompositeOperation = 'destination-in';
				ctx.fillStyle = fade;
				ctx.fillRect(0, scroll, w, vh);
				ctx.globalCompositeOperation = 'source-over';
			}
		};

		const request = () => (raf ||= requestAnimationFrame(draw));
		request();
		window.addEventListener('scroll', request, { passive: true });
		window.addEventListener('resize', request);
		const media = matchMedia('(prefers-color-scheme: dark)');
		media.addEventListener('change', request);
		const mo = new MutationObserver(request);
		mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
		return {
			destroy() {
				cancelAnimationFrame(raf);
				window.removeEventListener('scroll', request);
				window.removeEventListener('resize', request);
				media.removeEventListener('change', request);
				mo.disconnect();
			}
		};
	}
</script>

<canvas use:paint class="pointer-events-none fixed inset-0 -z-10 size-full" aria-hidden="true"></canvas>
