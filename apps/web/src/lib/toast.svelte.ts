// Tiny toast queue for action results and plain-English errors from the data source.
export interface Toast {
	id: number;
	text: string;
	tone: 'info' | 'error' | 'success';
}

class Toasts {
	items: Toast[] = $state([]);
	#n = 0;

	push(text: string, tone: Toast['tone'] = 'info', ms = 4200): number {
		const id = ++this.#n;
		this.items.push({ id, text, tone });
		if (ms > 0) setTimeout(() => this.dismiss(id), ms);
		return id;
	}

	/** Change a toast in place (progress), optionally scheduling its dismissal. */
	update(id: number, text: string, tone?: Toast['tone'], dismissAfterMs?: number) {
		const t = this.items.find((x) => x.id === id);
		if (!t) return;
		t.text = text;
		if (tone) t.tone = tone;
		if (dismissAfterMs) setTimeout(() => this.dismiss(id), dismissAfterMs);
	}

	error(err: unknown) {
		this.push(err instanceof Error ? err.message : String(err), 'error', 6000);
	}

	dismiss(id: number) {
		this.items = this.items.filter((t) => t.id !== id);
	}
}

export const toasts = new Toasts();

/** Run a data-source action and surface any failure as a toast. Returns true on success. */
export async function attempt(fn: () => Promise<unknown>, success?: string): Promise<boolean> {
	try {
		await fn();
		if (success) toasts.push(success, 'success');
		return true;
	} catch (err) {
		toasts.error(err);
		return false;
	}
}
