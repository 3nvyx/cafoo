<script lang="ts">
	// A painted night sky in the manner of Van Gogh, made the way painterly shaders are made:
	// a source image (pass 1) run through an anisotropic, generalized Kuwahara filter (pass 2)
	// whose kernel is stretched along the local flow, so the paint lays down in strokes that
	// follow the wind. The source is generated in the shader, so the flow direction is known
	// exactly and no structure-tensor pass is needed. Low in the frame the wind gathers into the
	// river's current (riverPath, the same course River draws), so the page's hairlines pour out
	// of the paint. Rendered once at reduced resolution, again only on resize or theme change.
	// Without WebGL it falls back to the hairline sky.
	import { riverPath } from './flow';
	import Swirls from './Swirls.svelte';

	let { seed = 11, riverSeed = 5, quality = 0.5 }: { seed?: number; riverSeed?: number; quality?: number } = $props();
	let failed = $state(false);

	const VERT = `attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }`;

	// Shared by both passes: noise, the swirl field, and the palette.
	const COMMON = `
precision highp float;
uniform vec2 uSize;     // css px
uniform vec2 uBuf;      // drawing-buffer px
uniform float uSeed;
uniform vec3 uC0, uC1, uC2, uC3; // page, soft, deep, neon
uniform vec2 uR[24];    // the river down the canvas: centre x and half width (css px) at 23 even steps of y

vec2 hash2(vec2 p) {
	p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
	return -1.0 + 2.0 * fract(sin(p + uSeed) * 43758.5453);
}
float gnoise(vec2 p) {
	vec2 i = floor(p), f = fract(p);
	vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
	return mix(mix(dot(hash2(i), f), dot(hash2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
	           mix(dot(hash2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)), dot(hash2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
	float s = 0.0, a = 0.5;
	for (int i = 0; i < 4; i++) { s += a * gnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
	return s;
}
// The river at height y: centre x, half width, and slope (dx/dy).
vec3 river(float y) {
	float f = clamp(y / uSize.y, 0.0, 1.0) * 23.0;
	float i0 = min(floor(f), 22.0);
	vec2 a = uR[0], b = uR[1];
	for (int i = 0; i < 23; i++) {
		if (float(i) == i0) { a = uR[i]; b = uR[i + 1]; }
	}
	vec2 r = mix(a, b, f - i0);
	return vec3(r, (b.x - a.x) / (uSize.y / 23.0));
}
// How strongly the current holds at height y: nothing up top, all of it by the lower part,
// where River's hairlines fade in along the same course.
float gather(float y) { return smoothstep(0.4, 0.85, y / uSize.y); }
// The wind: slow noise drift that, lower down, leans into the river and runs along it.
vec2 flow(vec2 p) {
	float base = gnoise(p * 0.0014) * 2.4 + 0.5;
	vec2 v = vec2(cos(base), sin(base));
	vec3 r = river(p.y);
	float d = p.x - r.x;
	float g = gather(p.y);
	float core = exp(-d * d / (2.0 * r.y * r.y * 0.4));
	float reach = exp(-d * d / (2.0 * r.y * r.y * 6.0));
	v += g * (3.0 * core * normalize(vec2(r.z, 1.0)) + 1.4 * reach * normalize(vec2(-d / (abs(d) + 1.0), 1.1)));
	return normalize(v);
}
// The river's own paint: a brighter stream along its centre.
float current(vec2 p) {
	vec3 r = river(p.y);
	float d = p.x - r.x;
	return gather(p.y) * exp(-d * d / (2.0 * r.y * r.y * 0.25));
}
vec3 palette(float t) {
	t = clamp(t, 0.0, 1.0);
	if (t < 0.4) return mix(uC0, uC1, t / 0.4);
	if (t < 0.76) return mix(uC1, uC2, (t - 0.4) / 0.36);
	return mix(uC2, uC3, (t - 0.76) / 0.24);
}
// Fragment position in css px, y down.
vec2 cssPos() { return vec2(gl_FragCoord.x, uBuf.y - gl_FragCoord.y) * (uSize / uBuf); }
`;

	// Pass 1, the source painting: colour regions from warped clouds and the river's brighter
	// stream, broken into brushwork by line integral convolution (fine noise smeared
	// along the flow, which is what turns it into streaks).
	const SOURCE = COMMON + `
float regions(vec2 p) {
	vec2 q = p * 0.0032;
	float t = fbm(q + 1.6 * vec2(fbm(q + 3.1), fbm(q + 7.7)));
	return 0.42 + 1.1 * t + 0.75 * current(p);
}
float strokes(vec2 p) {
	float sum = 0.5 + 0.5 * gnoise(p * 0.19);
	float wsum = 1.0;
	vec2 a = p, b = p;
	for (int i = 1; i <= 16; i++) {
		a += flow(a) * 4.0;
		b -= flow(b) * 4.0;
		float w = 1.0 - float(i) / 17.0;
		sum += (1.0 + 0.5 * gnoise(a * 0.19) + 0.5 * gnoise(b * 0.19)) * w;
		wsum += 2.0 * w;
	}
	return smoothstep(0.3, 0.7, sum / wsum);
}
void main() {
	vec2 p = cssPos();
	gl_FragColor = vec4(palette(regions(p) + (strokes(p) - 0.5) * 0.6), 1.0);
}`;

	// Pass 2, the paint: an anisotropic generalized Kuwahara over the source. Eight
	// Gaussian-weighted sectors on an ellipse stretched along the flow; the smoothest sectors
	// win, so streaks settle into flat dabs with clean edges. Then a little canvas grain.
	const PAINT = COMMON + `
uniform sampler2D uSrc;
vec3 src(vec2 css) { return texture2D(uSrc, vec2(css.x / uSize.x, 1.0 - css.y / uSize.y)).rgb; }
void main() {
	vec2 p = cssPos();
	vec2 dir = flow(p);
	vec2 nrm = vec2(-dir.y, dir.x);
	const float R = 9.0;
	vec3 col = vec3(0.0);
	float total = 0.0;
	for (int j = 0; j < 8; j++) {
		vec3 m = vec3(0.0), s = vec3(0.0);
		float w = 0.0;
		for (int r = 1; r <= 3; r++) {
			for (int a = 0; a < 3; a++) {
				float ang = (float(j) + (float(a) + 0.5) / 3.0) * 0.785398;
				float rad = R * float(r) / 3.0;
				vec3 c = src(p + cos(ang) * rad * dir + sin(ang) * rad * 0.35 * nrm);
				float g = exp(-float(r * r) / 4.5);
				m += c * g;
				s += c * c * g;
				w += g;
			}
		}
		m /= w;
		vec3 v = abs(s / w - m * m);
		float k = 1.0 / (1.0 + pow(sqrt(v.r + v.g + v.b) * 14.0, 8.0));
		col += m * k;
		total += k;
	}
	col /= max(total, 1e-4);
	col += (fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * 0.02;
	gl_FragColor = vec4(col, 1.0);
}`;

	const hex = (v: string) => {
		const h = v.trim().replace('#', '');
		const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
		return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
	};

	function paintSky(canvas: HTMLCanvasElement) {
		const gl = canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: true });
		if (!gl) {
			failed = true;
			return;
		}
		const shader = (type: number, src: string) => {
			const s = gl.createShader(type)!;
			gl.shaderSource(s, src);
			gl.compileShader(s);
			return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
		};
		const program = (frag: string) => {
			const vs = shader(gl.VERTEX_SHADER, VERT);
			const fs = shader(gl.FRAGMENT_SHADER, frag);
			if (!vs || !fs) return null;
			const prog = gl.createProgram()!;
			gl.attachShader(prog, vs);
			gl.attachShader(prog, fs);
			gl.bindAttribLocation(prog, 0, 'a');
			gl.linkProgram(prog);
			return gl.getProgramParameter(prog, gl.LINK_STATUS) ? prog : null;
		};
		const source = program(SOURCE);
		const paint = program(PAINT);
		if (!source || !paint) {
			failed = true;
			return;
		}
		gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

		// Pass 1 renders into this texture; pass 2 reads it.
		const tex = gl.createTexture();
		const fbo = gl.createFramebuffer();

		let timer = 0;
		const render = () => {
			const { width: w, height: h } = canvas.getBoundingClientRect();
			if (!w || !h) return;
			const bw = Math.max(1, Math.round(w * quality));
			const bh = Math.max(1, Math.round(h * quality));
			canvas.width = bw;
			canvas.height = bh;

			const css = getComputedStyle(canvas);
			const colors = ['--canvas', '--accent-soft', '--accent-deep', '--accent'].map((t) => hex(css.getPropertyValue(t)));
			// The river's course across this canvas, in page coordinates: River lays it out against the page width.
			const path = riverPath(window.innerWidth, riverSeed);
			const top = canvas.getBoundingClientRect().top + window.scrollY;
			const left = canvas.getBoundingClientRect().left;
			const course: number[] = [];
			for (let i = 0; i < 24; i++) {
				const y = top + (i / 23) * h;
				course.push(path.centre(y) - left, path.breadth(y) / 2);
			}
			const uniforms = (prog: WebGLProgram) => {
				gl.useProgram(prog);
				const u = (name: string) => gl.getUniformLocation(prog, name);
				colors.forEach((c, i) => gl.uniform3fv(u(`uC${i}`), c));
				gl.uniform2fv(u('uR'), course);
				gl.uniform2f(u('uSize'), w, h);
				gl.uniform2f(u('uBuf'), bw, bh);
				gl.uniform1f(u('uSeed'), seed * 0.618);
				return u;
			};

			gl.bindTexture(gl.TEXTURE_2D, tex);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, bw, bh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
			gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
			gl.viewport(0, 0, bw, bh);
			uniforms(source);
			gl.drawArrays(gl.TRIANGLES, 0, 3);

			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			const u = uniforms(paint);
			gl.uniform1i(u('uSrc'), 0);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
		};
		// Debounced: a resize drag should paint once at the end, not on every frame.
		const request = () => {
			clearTimeout(timer);
			timer = window.setTimeout(render, 120);
		};
		render();
		const ro = new ResizeObserver(request);
		ro.observe(canvas);
		const media = matchMedia('(prefers-color-scheme: dark)');
		media.addEventListener('change', request);
		const mo = new MutationObserver(request);
		mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
		return {
			destroy() {
				clearTimeout(timer);
				ro.disconnect();
				media.removeEventListener('change', request);
				mo.disconnect();
			}
		};
	}
</script>

{#if failed}
	<Swirls {seed} />
{:else}
	<canvas use:paintSky class="pointer-events-none absolute inset-0 size-full" aria-hidden="true"></canvas>
{/if}
