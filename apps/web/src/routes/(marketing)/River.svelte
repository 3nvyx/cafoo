<script lang="ts">
	// A river of brushstrokes winding down the page behind the content. It rises where the
	// element matched by `from` ends and fades out before `to`. Scrolling carries the strokes
	// downstream a little faster than the page moves, so it reads as current; nothing moves
	// while the page is still. Under reduced motion the river stays painted on the page.
	// One viewport-sized canvas redraws only the visible stretch, once per frame at most.
	import { prefersReducedMotion } from 'svelte/motion';

	let { from = '', to = '', alpha = 0.3, seed = 5 }: { from?: string; to?: string; alpha?: number; seed?: number } = $props();

	const ROW = 14; // strokes per row along the river, rows this far apart
	const FLOW = 0.55; // how far the current runs per pixel scrolled

	// Stable pseudo-random value for a (row, column) pair, so strokes keep their identity as they flow.
	function hash(a: number, b: number) {
		let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + seed, 0xc2b2ae35);
		h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
		h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
		return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
	}

	function paint(canvas: HTMLCanvasElement) {
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
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, w, vh);

			const scroll = window.scrollY;
			const fromEl = from ? document.querySelector(from) : null;
			const toEl = to ? document.querySelector(to) : null;
			const start = fromEl ? fromEl.getBoundingClientRect().bottom + scroll - 120 : 0;
			const end = toEl ? toEl.getBoundingClientRect().top + scroll : document.documentElement.scrollHeight;

			// The riverbed in page coordinates: a slow meander with a faster wobble, swelling and narrowing.
			const centre = (y: number) => w * 0.5 + w * 0.3 * Math.sin(y / 560 + 1.1) + w * 0.06 * Math.sin(y / 170);
			const breadth = (y: number) => Math.min(280, Math.max(120, w * 0.2)) * (1 + 0.3 * Math.sin(y / 430 + 0.6));
			const fade = (y: number) => Math.max(0, Math.min(1, (y - start) / 320, (end - y) / 320));

			const css = getComputedStyle(canvas);
			const tone = ['--accent-deep', '--accent-ink', '--accent'].map((v) => css.getPropertyValue(v).trim());
			const buckets = new Map<string, Path2D>();
			const bucket = (key: string) => buckets.get(key) ?? buckets.set(key, new Path2D()).get(key)!;

			// The current: rows slide downstream by `offset`; each row keeps its strokes as it travels.
			const offset = prefersReducedMotion.current ? 0 : scroll * FLOW;
			const shift = Math.floor(offset / ROW);
			const frac = offset - shift * ROW;
			const top = Math.max(start, scroll - 40);
			const bottom = Math.min(end, scroll + vh + 40);

			for (let j = Math.floor((top - frac) / ROW); j * ROW + frac < bottom; j++) {
				const y = j * ROW + frac;
				const f = fade(y);
				if (f <= 0) continue;
				const id = j - shift;
				const cx = centre(y);
				const half = breadth(y) / 2;
				const slope = (centre(y + 1) - centre(y - 1)) / 2;
				const cols = Math.max(6, Math.round((half * 2) / 12));
				for (let k = 0; k < cols; k++) {
					const u = (k + hash(id, k)) / cols * 2 - 1; // -1 at one bank, 1 at the other
					if (hash(id, k + 97) > f) continue; // thin out where the river rises and ends
					let x = cx + u * half + (hash(id, k + 31) - 0.5) * 6;
					let py = y + (hash(id, k + 53) - 0.5) * ROW - scroll;
					// Downstream along the bed, with eddies that curl harder near the banks.
					const eddy = 0.7 * u * Math.sin(y / 85 + u * 3 + id * 0.15);
					const a = Math.atan2(1, slope) + eddy;
					const edge = Math.abs(u);
					const t = edge < 0.3 ? (hash(id, k + 7) < 0.55 ? 2 : 1) : edge < 0.7 ? (hash(id, k + 7) < 0.5 ? 1 : 0) : 0;
					const strength = edge < 0.45 ? 'a' : edge < 0.8 ? 'b' : 'c';
					const p = bucket(`${t}${hash(id, k + 11) < 0.4 ? 'w' : 'n'}${strength}`);
					p.moveTo(x, py);
					const steps = 2 + Math.floor(hash(id, k + 3) * 2);
					for (let i = 0; i < steps; i++) {
						x += Math.cos(a) * 5;
						py += Math.sin(a) * 5;
						p.lineTo(x, py);
					}
				}
			}

			ctx.lineCap = 'round';
			const bank = { a: 1, b: 0.6, c: 0.3 } as const;
			for (const [key, p] of buckets) {
				ctx.strokeStyle = tone[Number(key[0])];
				ctx.lineWidth = key[1] === 'w' ? 3.6 : 2.2;
				ctx.globalAlpha = alpha * bank[key[2] as keyof typeof bank];
				ctx.stroke(p);
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
