// App-wide view state: the theme, the selected Period, nav and palette.
// Persisted bits go through localStorage, always wrapped: storage can be blocked.
import { MediaQuery } from 'svelte/reactivity';

const prefersDark = new MediaQuery('prefers-color-scheme: dark', false);

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

	/** The theme on screen: the pinned one, or the device's while following the system. */
	get resolvedTheme(): 'light' | 'dark' {
		if (this.theme !== 'system') return this.theme;
		return prefersDark.current ? 'dark' : 'light';
	}

	setTheme(t: Theme) {
		this.theme = t;
		write(KEY_THEME, t);
		const root = document.documentElement;
		root.classList.add('theme-switching');
		if (t === 'system') delete root.dataset.theme;
		else root.dataset.theme = t;
		requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
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
