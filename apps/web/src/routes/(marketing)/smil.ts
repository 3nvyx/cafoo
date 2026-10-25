// Runs an SVG's SMIL animations only while the drawing is on screen and the visitor has not
// paused it. A drawing hidden with display:none never intersects, so it stays paused too.
export function smil(node: SVGSVGElement, paused = false) {
	let onScreen = false;
	const apply = () => (onScreen && !paused ? node.unpauseAnimations() : node.pauseAnimations());
	const io = new IntersectionObserver(([e]) => {
		onScreen = e.isIntersecting;
		apply();
	});
	io.observe(node);
	apply();
	return {
		update(next: boolean) {
			paused = next;
			apply();
		},
		destroy: () => io.disconnect()
	};
}
