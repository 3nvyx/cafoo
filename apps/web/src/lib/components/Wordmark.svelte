<script lang="ts">
	// The Cafoo wordmark: the word itself, set tight in Space Grotesk 600 and finished as polished
	// blue chrome. A sky-to-horizon gradient gives the chrome its hard dark line across the letters,
	// specular lighting over a blurred copy of the letter shapes bevels their edges, and a faint
	// ocean-blue glow sits underneath. On hover a sheen crosses it once (not under reduced motion).
	// `size` is the font size in px; the mark is as tall as the word's capitals plus a little air.
	let { size = 20, class: cls = '' }: { size?: number; class?: string } = $props();
	const id = $props.id();
</script>

<svg class="wordmark {cls}" viewBox="0 -80 268 90" style="height: {size * 0.9}px" role="img" aria-label="Cafoo">
	<defs>
		<linearGradient id="{id}-chrome" gradientUnits="userSpaceOnUse" x1="0" y1="-74" x2="0" y2="2">
			<stop offset="0" class="s0" />
			<stop offset="0.3" class="s1" />
			<stop offset="0.52" class="s2" />
			<stop offset="0.555" class="s3" />
			<stop offset="0.63" class="s4" />
			<stop offset="0.82" class="s5" />
			<stop offset="1" class="s6" />
		</linearGradient>
		<linearGradient id="{id}-sheen" x1="0" y1="0" x2="1" y2="0">
			<stop offset="0" stop-color="#fff" stop-opacity="0" />
			<stop offset="0.5" stop-color="#fff" stop-opacity="0.75" />
			<stop offset="1" stop-color="#fff" stop-opacity="0" />
		</linearGradient>
		<filter id="{id}-metal" x="-8%" y="-20%" width="116%" height="145%" color-interpolation-filters="sRGB">
			<feGaussianBlur in="SourceAlpha" stdDeviation="1.6" result="bump" />
			<feSpecularLighting in="bump" surfaceScale="4" specularConstant="0.85" specularExponent="24" lighting-color="#eaf8ff" result="spec">
				<feDistantLight azimuth="225" elevation="52" />
			</feSpecularLighting>
			<feComposite in="spec" in2="SourceAlpha" operator="in" result="bevel" />
			<feComposite in="SourceGraphic" in2="bevel" operator="arithmetic" k2="1" k3="0.7" result="lit" />
			<feGaussianBlur in="SourceAlpha" stdDeviation="5" result="soft" />
			<feFlood class="glow" />
			<feComposite in2="soft" operator="in" result="glow" />
			<feOffset in="SourceAlpha" dy="1.4" result="drop" />
			<feFlood class="edge" />
			<feComposite in2="drop" operator="in" result="edge" />
			<feMerge>
				<feMergeNode in="glow" />
				<feMergeNode in="edge" />
				<feMergeNode in="lit" />
			</feMerge>
		</filter>
		<clipPath id="{id}-letters">
			<text x="-1" y="0">Cafoo</text>
		</clipPath>
	</defs>
	<text x="-1" y="0" fill="url(#{id}-chrome)" filter="url(#{id}-metal)">Cafoo</text>
	<g clip-path="url(#{id}-letters)">
		<rect class="sheen" x="-120" y="-80" width="110" height="90" fill="url(#{id}-sheen)" />
	</g>
</svg>

<style>
	.wordmark {
		--s0: #f6fcff;
		--s1: #bfeaff;
		--s2: #5cc4fa;
		--s3: #06345a;
		--s4: #0a5f9c;
		--s5: #3cb4f2;
		--s6: #d9f3ff;
		--glow: rgb(0 180 255 / 0.22);
		--edge: rgb(0 0 0 / 0.65);
		display: block;
		width: auto;
		overflow: visible;
	}
	/* Light theme: deeper steel, with a pale engraved edge in place of the shadow. */
	@media (prefers-color-scheme: light) {
		:global(:root:not([data-theme='dark'])) .wordmark {
			--s0: #5aa0d2;
			--s1: #14659f;
			--s2: #0a4778;
			--s3: #021f3a;
			--s4: #0089cf;
			--s5: #0a6cae;
			--s6: #04294a;
			--glow: rgb(0 120 200 / 0.12);
			--edge: rgb(255 255 255 / 0.9);
		}
	}
	:global(:root[data-theme='light']) .wordmark {
		--s0: #5aa0d2;
		--s1: #14659f;
		--s2: #0a4778;
		--s3: #021f3a;
		--s4: #0089cf;
		--s5: #0a6cae;
		--s6: #04294a;
		--glow: rgb(0 120 200 / 0.12);
		--edge: rgb(255 255 255 / 0.9);
	}
	text {
		font-family: var(--font-display);
		font-size: 100px;
		font-weight: 600;
		letter-spacing: -4.5px;
	}
	.s0 { stop-color: var(--s0); }
	.s1 { stop-color: var(--s1); }
	.s2 { stop-color: var(--s2); }
	.s3 { stop-color: var(--s3); }
	.s4 { stop-color: var(--s4); }
	.s5 { stop-color: var(--s5); }
	.s6 { stop-color: var(--s6); }
	.glow { flood-color: var(--glow); }
	.edge { flood-color: var(--edge); }
	.sheen {
		transform: translateX(0);
	}
	@media (prefers-reduced-motion: no-preference) {
		:global(a:hover) > .wordmark .sheen,
		.wordmark:hover .sheen {
			transform: translateX(400px);
			transition: transform 1100ms cubic-bezier(0.23, 1, 0.32, 1);
		}
	}
</style>
