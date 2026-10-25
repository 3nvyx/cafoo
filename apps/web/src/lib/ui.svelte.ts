// App-wide view state: the theme, the selected Period, nav and palette.
// Persisted bits go through localStorage, always wrapped: storage can be blocked.

/** 'system' follows the device; 'light' and 'dark' pin one. app.html applies a pinned theme before first paint. */
export type Theme = 'system' | 'light' | 'dark';

const KEY_NAV = 'cafoo.navCollapsed';
const KEY_THEME = 'cafoo.theme';

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
	theme: Theme = $state('system');
	periodId = $state('2026-09');
	navCollapsed = $state(false);
	navOpenMobile = $state(false);
	paletteOpen = $state(false);

	init() {
		this.navCollapsed = read(KEY_NAV) === '1';
		const t = read(KEY_THEME);
		if (t === 'light' || t === 'dark') this.theme = t;
	}

	setTheme(t: Theme) {
		this.theme = t;
		write(KEY_THEME, t);
		if (t === 'system') delete document.documentElement.dataset.theme;
		else document.documentElement.dataset.theme = t;
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
