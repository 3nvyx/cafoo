<script lang="ts">
	// A Van Gogh-style sky: evenly spaced hairlines curling around a few slow vortices, each
	// carrying a soft glint that drifts along it as the page scrolls. The lines never move;
	// under reduced motion the glints stay put too. Field and line placement live in flow.ts.
	import { prefersReducedMotion } from 'svelte/motion';
	import { drawLines, noise2, rng, streamlines, type Line } from './flow';

	let {
		seed = 7,
		sep = 15,
		line = '--ink-3',
		glint = '--accent',
		lineAlpha = 0.2,
		glintAlpha = 0.55
	}: { seed?: number; sep?: number; line?: string; glint?: string; lineAlpha?: number; glintAlpha?: number } = $props();

	function sky(w: number, h: number): Line[] {
		const n = noise2(seed);
		const r = rng(seed);
		const vortices = Array.from({ length: 3 }, () => ({
			x: (0.1 + r() * 0.8) * w,
			y: (0.15 + r() * 0.7) * h,
			rad: (0.1 + r() * 0.08) * Math.max(w, h),
			dir: r() < 0.5 ? 1 : -1
		}));
		const field = (x: number, y: number) => {
			const base = n(x * 0.0018, y * 0.0018) * Math.PI;
			let vx = Math.cos(base);
			let vy = Math.sin(base);
			for (const v of vortices) {
				const dx = x - v.x;
				const dy = y - v.y;
				const k = 2.4 * Math.exp(-(dx * dx + dy * dy) / (2 * v.rad * v.rad));
				// Slightly less than a right angle, so the lines spiral in rather than ring.
				const t = Math.atan2(dy, dx) + v.dir * (Math.PI / 2 - 0.22);
				vx += k * Math.cos(t);
				vy += k * Math.sin(t);
			}
			return Math.atan2(vy, vx);
		};
		return streamlines(field, { x0: -10, y0: -10, x1: w + 10, y1: h + 10, sep, seed });
	}

	function paint(canvas: HTMLCanvasElement) {
		let lines: Line[] = [];
		let size = '';
		let raf = 0;

		const draw = () => {
			raf = 0;
			const rect = canvas.getBoundingClientRect();
			const ctx = canvas.getContext('2d');
			if (!ctx || !rect.width || !rect.height) return;
			if (rect.bottom < 0 || rect.top > window.innerHeight) return; // off screen: nothing to update
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			const key = `${rect.width}x${rect.height}`;
			if (key !== size) {
				size = key;
				canvas.width = Math.round(rect.width * dpr);
				canvas.height = Math.round(rect.height * dpr);
				lines = sky(rect.width, rect.height);
			}
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, rect.width, rect.height);
			const css = getComputedStyle(canvas);
			drawLines(ctx, lines, {
				line: css.getPropertyValue(line).trim(),
				glint: css.getPropertyValue(glint).trim(),
				lineAlpha,
				glintAlpha,
				offset: prefersReducedMotion.current ? 0 : window.scrollY * 0.5
			});
		};

		const request = () => (raf ||= requestAnimationFrame(draw));
		request();
		const ro = new ResizeObserver(request);
		ro.observe(canvas);
		window.addEventListener('scroll', request, { passive: true });
		const media = matchMedia('(prefers-color-scheme: dark)');
		media.addEventListener('change', request);
		const mo = new MutationObserver(request);
		mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
		return {
			destroy() {
				cancelAnimationFrame(raf);
				ro.disconnect();
				window.removeEventListener('scroll', request);
				media.removeEventListener('change', request);
				mo.disconnect();
			}
		};
	}
</script>

<canvas use:paint class="pointer-events-none absolute inset-0 size-full" aria-hidden="true"></canvas>
