// The app's destinations, shared by the navigation rail, the drawer and the phone's bottom bar.
import type { IconName } from './components/Icon.svelte';

export interface NavItem {
	href: string;
	label: string;
	icon: IconName;
	/** Shown in the phone's bottom bar (the rest live behind "More"). */
	primary?: boolean;
}

export const NAV: NavItem[] = [
	{ href: '/dashboard', label: 'Overview', icon: 'home', primary: true },
	{ href: '/proposals', label: 'Proposals', icon: 'inbox', primary: true },
	{ href: '/agents', label: 'Agents', icon: 'chat', primary: true },
	{ href: '/close', label: 'Close', icon: 'checklist', primary: true },
	{ href: '/ledger', label: 'Ledger', icon: 'book' },
	{ href: '/reports', label: 'Board Pack', icon: 'chart' },
	{ href: '/charters', label: 'Charters', icon: 'shield' },
	{ href: '/customers', label: 'Customers', icon: 'users' },
	{ href: '/vendors', label: 'Vendors', icon: 'truck' },
	{ href: '/dash-bar', label: 'Tables', icon: 'database' },
	{ href: '/settings', label: 'Settings', icon: 'sliders' }
];

export const MARKETING: NavItem[] = [
	{ href: '/pitch', label: 'Pitch', icon: 'slides' },
	{ href: '/pricing', label: 'Pricing', icon: 'tag' }
];

export function isActive(pathname: string, href: string): boolean {
	return pathname === href || pathname.startsWith(`${href}/`);
}
