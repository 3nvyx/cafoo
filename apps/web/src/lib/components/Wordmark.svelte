<script lang="ts">
	// The Luyten wordmark: the word set tight in Space Grotesk 600 in one ocean blue, bevelled by an
	// SVG filter that runs specular lighting over a blurred copy of the letter shapes. An aria-hidden
	// copy sits on top, clipped to the letters and filled with a narrow diagonal band of light that
	// crosses every few seconds. Under reduced motion the band never shows. Screen readers get the
	// base text only. `size` is the font size in px.
	let { size = 20, class: cls = '' }: { size?: number; class?: string } = $props();
	const id = $props.id();
</script>

<span class="wordmark {cls}" style="font-size: {size}px">
	<!-- The filter sits on a wrapper, not on the background-clip:text node, which WebKit can drop. -->
	<span class="base" style="filter: url(#{id}-bevel)"><span class="fill">Luyten</span></span>
	<span class="fill light" aria-hidden="true">Luyten</span>
	<svg aria-hidden="true" width="0" height="0" focusable="false">
		<filter id="{id}-bevel" x="-10%" y="-30%" width="120%" height="160%" color-interpolation-filters="sRGB">
			<feGaussianBlur in="SourceAlpha" stdDeviation="0.8" result="blur" />
			<feSpecularLighting in="blur" surfaceScale="2.5" specularConstant="0.75" specularExponent="26" class="spec" result="spec">
				<fePointLight x="-120" y="-220" z="260" />
			</feSpecularLighting>
			<feComposite in="spec" in2="SourceAlpha" operator="in" result="specIn" />
			<feComposite in="SourceGraphic" in2="specIn" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="lit" />
			<feDropShadow dx="0" dy="0.6" stdDeviation="0.4" class="drop" />
		</filter>
	</svg>
</span>

<style>
	/* Light theme: ocean blue on milk. */
	.wordmark {
		--wm-blue: #6aa9d6;
		--wm-band: rgb(255 255 255 / 0.9);
		--wm-spec: #ffffff;
		--wm-drop: rgb(0 0 0 / 0.22);
		position: relative;
		display: inline-block;
		/* Cancels the fill's end padding so the mark keeps its natural width in layout. */
		margin-inline-end: -0.06em;
		font-family: var(--font-display);
		font-weight: 600;
		line-height: 1;
		letter-spacing: -0.045em;
		white-space: nowrap;
	}
	/* Dark theme: a paler blue so the letters hold up on tar. */
	@media (prefers-color-scheme: dark) {
		:global(:root:not([data-theme='light'])) .wordmark {
			--wm-blue: #c2eaff;
			--wm-band: rgb(110 208 255 / 0.95);
			--wm-drop: rgb(0 0 0 / 0.6);
		}
	}
	:global(:root[data-theme='dark']) .wordmark {
		--wm-blue: #c2eaff;
		--wm-band: rgb(110 208 255 / 0.95);
		--wm-drop: rgb(0 0 0 / 0.6);
	}
	.base {
		display: block;
	}
	/* background-clip:text paints only inside the box, and the negative tracking leaves the last
	   "o" wider than it; the end padding keeps that glyph whole. */
	.fill {
		display: block;
		padding-inline-end: 0.06em;
		color: transparent;
		-webkit-background-clip: text;
		background-clip: text;
		background-color: var(--wm-blue);
	}
	/* The band lives in the middle third of a background three times the word's width, so at either
	   end of the sweep it sits fully outside the letters and the overlay shows nothing. */
	.light {
		position: absolute;
		inset: 0;
		display: none;
		pointer-events: none;
		user-select: none;
		/* Only the band paints here; the base layer underneath carries the blue. */
		background-color: transparent;
		background-image: linear-gradient(112deg, transparent 47.5%, var(--wm-band) 50%, transparent 52.5%);
		background-size: 300% 100%;
		background-repeat: no-repeat;
		background-position: 100% 0;
	}
	svg {
		position: absolute;
		width: 0;
		height: 0;
		overflow: hidden;
	}
	.spec {
		lighting-color: var(--wm-spec);
	}
	.drop {
		flood-color: var(--wm-drop);
	}
	/* One 1.1s pass at the start of each 6.5s cycle; the first lands just after load. */
	@media (prefers-reduced-motion: no-preference) {
		.light {
			display: block;
			opacity: 0;
			animation: wordmark-sweep 6500ms linear 400ms infinite;
		}
	}
	@keyframes wordmark-sweep {
		0% {
			background-position: 100% 0;
			opacity: 0;
			animation-timing-function: cubic-bezier(0.45, 0, 0.2, 1);
		}
		3%,
		14% {
			opacity: 1;
		}
		17%,
		100% {
			background-position: 0 0;
			opacity: 0;
		}
	}
	/* Without backgrounds (forced colors, print) the clipped fill would vanish; fall back to text. */
	@media (forced-colors: active), print {
		.base {
			filter: none !important;
		}
		.fill {
			color: CanvasText;
			background: none;
		}
		.light {
			display: none;
		}
	}
</style>
