// Shared drawing for the landing page's brushwork. A smooth noise flow field, evenly spaced
// streamlines through it (after Jobard & Lefer, "Creating Evenly-Spaced Streamlines of
// Arbitrary Density", 1997), and a renderer that draws each line as a faint hairline with a
// brighter glint running along it. Moving only the glints with scroll makes the lines read as
// current: no line ever appears, vanishes or jumps.

export interface Line {
	path: Path2D;
	top: number;
	bottom: number;
	/** Glint dash and gap lengths, and where along the line the first glint starts. */
	dash: number;
	gap: number;
	phase: number;
}

export function rng(seed: number) {
	let a = seed | 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** 2D gradient (Perlin) noise in roughly [-1, 1]: smooth, so the field has no kinks. */
export function noise2(seed: number) {
	const r = rng(seed);
	const p = Array.from({ length: 256 }, (_, i) => i);
	for (let i = 255; i > 0; i--) {
		const j = Math.floor(r() * (i + 1));
		[p[i], p[j]] = [p[j], p[i]];
	}
	const perm = new Uint8Array(512);
	for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
	const grad = (h: number, x: number, y: number) => (h & 1 ? -x : x) + (h & 2 ? -y : y);
	const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
	const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
	return (x: number, y: number) => {
		const fx = Math.floor(x);
		const fy = Math.floor(y);
		const xi = fx & 255;
		const yi = fy & 255;
		const xf = x - fx;
		const yf = y - fy;
		const u = fade(xf);
		const v = fade(yf);
		const aa = perm[perm[xi] + yi];
		const ab = perm[perm[xi] + yi + 1];
		const ba = perm[perm[xi + 1] + yi];
		const bb = perm[perm[xi + 1] + yi + 1];
		return lerp(lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u), lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u), v);
	};
}

export interface StreamOptions {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	/** Distance between neighbouring lines. */
	sep: number;
	seed: number;
	step?: number;
	minLength?: number;
	maxSteps?: number;
	/** Extra region test, for example the banks of a river. */
	inside?: (x: number, y: number) => boolean;
}

/** Evenly spaced streamlines through `field` (an angle per point), as drawable lines. */
export function streamlines(field: (x: number, y: number) => number, o: StreamOptions): Line[] {
	const step = o.step ?? 2;
	const test = o.sep * 0.5; // a growing line stops this close to another line
	const minLength = o.minLength ?? o.sep * 4;
	const maxSteps = o.maxSteps ?? 4000;
	const r = rng(o.seed + 101);
	const cols = Math.ceil((o.x1 - o.x0) / o.sep) + 2;
	const cell = (x: number, y: number) => Math.floor((y - o.y0) / o.sep) * cols + Math.floor((x - o.x0) / o.sep);

	// Points of finished lines, bucketed by cell, for the "too close to another line" test.
	const done = new Map<number, number[]>();
	const near = (x: number, y: number, d: number) => {
		const c = cell(x, y);
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				const pts = done.get(c + dy * cols + dx);
				if (!pts) continue;
				for (let i = 0; i < pts.length; i += 2) if ((pts[i] - x) ** 2 + (pts[i + 1] - y) ** 2 < d * d) return true;
			}
		}
		return false;
	};
	const inside = (x: number, y: number) => x >= o.x0 && x <= o.x1 && y >= o.y0 && y <= o.y1 && (!o.inside || o.inside(x, y));

	const lines: Line[] = [];
	const seeds: number[] = [];

	const grow = (sx: number, sy: number) => {
		// The line's own points, with their arc position, so a spiral stops before it overlaps itself.
		const own = new Map<number, number[]>();
		const ownNear = (x: number, y: number, s: number) => {
			const c = cell(x, y);
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const pts = own.get(c + dy * cols + dx);
					if (!pts) continue;
					for (let i = 0; i < pts.length; i += 3) {
						if (Math.abs(pts[i + 2] - s) > o.sep * 3 && (pts[i] - x) ** 2 + (pts[i + 1] - y) ** 2 < test * test) return true;
					}
				}
			}
			return false;
		};
		const keep = (x: number, y: number, s: number) => {
			const c = cell(x, y);
			const pts = own.get(c);
			if (pts) pts.push(x, y, s);
			else own.set(c, [x, y, s]);
		};

		const trace = (dir: 1 | -1) => {
			const out: number[] = [];
			let x = sx;
			let y = sy;
			for (let i = 1; i <= maxSteps; i++) {
				const a = field(x, y);
				const mx = x + Math.cos(a) * step * 0.5 * dir;
				const my = y + Math.sin(a) * step * 0.5 * dir;
				const b = field(mx, my);
				const nx = x + Math.cos(b) * step * dir;
				const ny = y + Math.sin(b) * step * dir;
				const s = i * step * dir;
				if (!inside(nx, ny) || near(nx, ny, test) || ownNear(nx, ny, s)) break;
				keep(nx, ny, s);
				out.push(nx, ny);
				x = nx;
				y = ny;
			}
			return out;
		};

		keep(sx, sy, 0);
		const back = trace(-1);
		const fwd = trace(1);
		const n = back.length / 2 + 1 + fwd.length / 2;
		if (n * step < minLength) return;

		// Upstream to downstream, so a dash offset that grows moves the glint with the current.
		const pts: number[] = [];
		for (let i = back.length - 2; i >= 0; i -= 2) pts.push(back[i], back[i + 1]);
		pts.push(sx, sy, ...fwd);

		const path = new Path2D();
		let top = Infinity;
		let bottom = -Infinity;
		for (let i = 0; i < pts.length; i += 2) {
			if (i === 0) path.moveTo(pts[0], pts[1]);
			else path.lineTo(pts[i], pts[i + 1]);
			top = Math.min(top, pts[i + 1]);
			bottom = Math.max(bottom, pts[i + 1]);
			const c = cell(pts[i], pts[i + 1]);
			const bucket = done.get(c);
			if (bucket) bucket.push(pts[i], pts[i + 1]);
			else done.set(c, [pts[i], pts[i + 1]]);
		}
		lines.push({ path, top, bottom, dash: 28 + r() * 44, gap: 180 + r() * 220, phase: r() * 400 });

		// Jobard–Lefer seeding: new candidates one spacing to either side of the new line.
		for (let i = 2; i < pts.length - 2; i += 8) {
			const tx = pts[i + 2] - pts[i - 2];
			const ty = pts[i + 3] - pts[i - 1];
			const len = Math.hypot(tx, ty) || 1;
			seeds.push(pts[i] - (ty / len) * o.sep, pts[i + 1] + (tx / len) * o.sep, pts[i] + (ty / len) * o.sep, pts[i + 1] - (tx / len) * o.sep);
		}
	};

	// Random starting points across the area, used whenever the neighbour seeds run out.
	const scatter: number[] = [];
	for (let y = o.y0; y < o.y1; y += o.sep * 2) for (let x = o.x0; x < o.x1; x += o.sep * 2) scatter.push(x + r() * o.sep * 2, y + r() * o.sep * 2);
	for (let i = scatter.length / 2 - 1; i > 0; i--) {
		const j = Math.floor(r() * (i + 1));
		[scatter[2 * i], scatter[2 * j]] = [scatter[2 * j], scatter[2 * i]];
		[scatter[2 * i + 1], scatter[2 * j + 1]] = [scatter[2 * j + 1], scatter[2 * i + 1]];
	}

	// Neighbour seeds first (they keep lines parallel), then the next scattered point.
	for (let k = 0; ; ) {
		let x: number;
		let y: number;
		if (seeds.length) {
			y = seeds.pop()!;
			x = seeds.pop()!;
		} else if (k < scatter.length) {
			x = scatter[k];
			y = scatter[k + 1];
			k += 2;
		} else break;
		if (inside(x, y) && !near(x, y, o.sep * 0.9)) grow(x, y);
	}
	return lines;
}

export interface DrawOptions {
	line: string;
	glint: string;
	lineAlpha: number;
	glintAlpha: number;
	/** How far the glints have travelled downstream, in px. */
	offset: number;
	/** Only lines within this vertical range are drawn. */
	top?: number;
	bottom?: number;
}

/** Hairlines first, then a brighter glint dashed along each line. */
export function drawLines(ctx: CanvasRenderingContext2D, lines: Line[], o: DrawOptions) {
	const visible = o.top === undefined ? lines : lines.filter((l) => l.bottom >= o.top! && l.top <= o.bottom!);
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	ctx.setLineDash([]);
	ctx.globalAlpha = o.lineAlpha;
	ctx.strokeStyle = o.line;
	ctx.lineWidth = 1;
	for (const l of visible) ctx.stroke(l.path);

	ctx.globalAlpha = o.glintAlpha;
	ctx.strokeStyle = o.glint;
	ctx.lineWidth = 1.75;
	for (const l of visible) {
		ctx.setLineDash([l.dash, l.gap]);
		ctx.lineDashOffset = l.phase - o.offset;
		ctx.stroke(l.path);
	}
	ctx.setLineDash([]);
	ctx.globalAlpha = 1;
}
