// App-wide view state: Simple/Expert mode, the selected Period, nav and palette.
// Persisted bits go through localStorage, always wrapped: storage can be blocked.

export type Mode = 'simple' | 'expert';

const KEY_MODE = 'cafoo.mode';
const KEY_NAV = 'cafoo.navCollapsed';

function read(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string) {
	try {
		localStorage.setItem(key, value);
	} catch {
		/* storage unavailable: keep the in-memory value */
	}
}

class UiState {
	mode: Mode = $state('simple');
	periodId = $state('2026-09');
	navCollapsed = $state(false);
	navOpenMobile = $state(false);
	paletteOpen = $state(false);

	get expert() {
		return this.mode === 'expert';
	}

	init() {
		const m = read(KEY_MODE);
		if (m === 'simple' || m === 'expert') this.mode = m;
		this.navCollapsed = read(KEY_NAV) === '1';
	}

	setMode(m: Mode) {
		this.mode = m;
		write(KEY_MODE, m);
	}

	toggleMode() {
		this.setMode(this.expert ? 'simple' : 'expert');
	}

	toggleNav() {
		this.navCollapsed = !this.navCollapsed;
		write(KEY_NAV, this.navCollapsed ? '1' : '0');
	}
}

export const ui = new UiState();

/** True when a keystroke is meant for a text field, not a shortcut. */
export function isTyping(e: KeyboardEvent): boolean {
	const el = e.target as HTMLElement | null;
	if (!el) return false;
	const tag = el.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
