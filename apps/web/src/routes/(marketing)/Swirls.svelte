<script lang="ts">
	// Brushwork in the manner of Van Gogh's night skies: short curved strokes that follow a flow
	// field turning around a few vortices, with ringed "stars" at their cores. Drawn on a canvas
	// so thousands of strokes cost nothing in the HTML. Seeded, so every redraw (resize, theme
	// change) repaints the same composition. Static: nothing animates.
	let { seed = 7, spacing = 15, alpha = 1 }: { seed?: number; spacing?: number; alpha?: number } = $props();

	function rng(a: number) {
		return () => {
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	function draw(canvas: HTMLCanvasElement) {
		const { width: w, height: h } = canvas.getBoundingClientRect();
		const ctx = canvas.getContext('2d');
		if (!ctx || !w || !h) return;
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		canvas.width = Math.round(w * dpr);
		canvas.height = Math.round(h * dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);

		// Deep ocean, mid blue, neon, and a little ink for the darkest strokes.
		const css = getComputedStyle(canvas);
		const tone = ['--accent-deep', '--accent-ink', '--accent', '--ink'].map((v) => css.getPropertyValue(v).trim());

		const r = rng(seed);
		const vortices = Array.from({ length: 4 }, () => ({
			x: r() * w,
			y: r() * h,
			rad: (0.1 + r() * 0.12) * Math.max(w, h * 1.6),
			dir: r() < 0.5 ? 1 : -1
		}));
		const pull = (x: number, y: number) => Math.max(...vortices.map((v) => Math.exp(-((x - v.x) ** 2 + (y - v.y) ** 2) / (2 * v.rad * v.rad))));
		const angle = (x: number, y: number) => {
			// A slow rolling drift, mostly left to right, bent hard around each vortex.
			const base = 0.45 * Math.sin(y * 0.006 + x * 0.002) + 0.3 * Math.cos(x * 0.005);
			let vx = Math.cos(base);
			let vy = Math.sin(base);
			for (const v of vortices) {
				const dx = x - v.x;
				const dy = y - v.y;
				const k = 3.4 * Math.exp(-(dx * dx + dy * dy) / (2 * v.rad * v.rad));
				const t = Math.atan2(dy, dx) + (v.dir * Math.PI) / 2;
				vx += k * Math.cos(t);
				vy += k * Math.sin(t);
			}
			return Math.atan2(vy, vx);
		};

		// Bucket strokes by tone and width so the whole field is a handful of stroke() calls.
		const buckets = new Map<string, Path2D>();
		const path = (t: number, wide: boolean) => {
			const key = `${t}${wide ? 'w' : 'n'}`;
			if (!buckets.has(key)) buckets.set(key, new Path2D());
			return buckets.get(key)!;
		};

		for (let gy = -spacing; gy < h + spacing; gy += spacing) {
			for (let gx = -spacing; gx < w + spacing; gx += spacing) {
				let x = gx + (r() - 0.5) * spacing;
				let y = gy + (r() - 0.5) * spacing;
				const near = pull(x, y);
				const pick = r();
				// Cores glow neon; the open sky is mostly deep and mid blue with a few dark strokes.
				const t = near > 0.55 ? (pick < 0.6 ? 2 : 1) : pick < 0.45 ? 0 : pick < 0.8 ? 1 : pick < 0.93 ? 2 : 3;
				const p = path(t, r() < 0.4);
				p.moveTo(x, y);
				const steps = 2 + Math.floor(r() * 3);
				for (let i = 0; i < steps; i++) {
					const a = angle(x, y);
					x += Math.cos(a) * 5;
					y += Math.sin(a) * 5;
					p.lineTo(x, y);
				}
			}
		}

		// Ringed stars at two of the cores: broken concentric arcs, like layered dabs of paint.
		for (const v of vortices.slice(0, 2)) {
			for (let ring = 8; ring < 46; ring += 7) {
				const p = path(ring < 22 ? 2 : 1, ring < 22);
				for (let a = r() * Math.PI; a < Math.PI * 2 + 0.2; a += 0.5 + r() * 0.35) {
					const arc = 0.25 + r() * 0.2;
					p.moveTo(v.x + Math.cos(a) * ring, v.y + Math.sin(a) * ring);
					p.arc(v.x, v.y, ring, a, a + arc);
				}
			}
		}

		ctx.lineCap = 'round';
		ctx.globalAlpha = alpha;
		for (const [key, p] of buckets) {
			ctx.strokeStyle = tone[Number(key[0])];
			// Short, thick strokes read as dabs of paint rather than hairlines.
			ctx.lineWidth = key.endsWith('w') ? 4 : 2.4;
			ctx.stroke(p);
		}
	}

	function paint(canvas: HTMLCanvasElement) {
		let raf = 0;
		const redraw = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => draw(canvas));
		};
		redraw();
		const ro = new ResizeObserver(redraw);
		ro.observe(canvas);
		// Repaint when the theme flips, by system setting or by the data-theme attribute.
		const media = matchMedia('(prefers-color-scheme: dark)');
		media.addEventListener('change', redraw);
		const mo = new MutationObserver(redraw);
		mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
		return {
			destroy() {
				cancelAnimationFrame(raf);
				ro.disconnect();
				media.removeEventListener('change', redraw);
				mo.disconnect();
			}
		};
	}
</script>

<canvas use:paint class="pointer-events-none absolute inset-0 size-full" aria-hidden="true"></canvas>
