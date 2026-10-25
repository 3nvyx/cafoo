<script lang="ts">
	// "Signals for a person, not a decision": what a logged-out visitor can see about a Customer or Vendor, one
	// block per public source, each compared with the previous fetch of the same source. Read-only; never proposes.
	import { db } from '#lib/data/index.js';
	import type { FootprintSubject, Listings, PublicFootprint } from '#lib/data/types.js';
	import {
		SOURCE_LABEL,
		boardName,
		bySource,
		deltas,
		factString,
		fmtInt,
		fmtRating,
		hasListing,
		listingCount,
		relTime,
		reviewsSinceYear,
		rowsFor
	} from '#lib/footprint.js';
	import { dateTime, shortDate } from '#lib/labels.js';
	import { attempt, toasts } from '#lib/toast.svelte.js';
	import Icon from './Icon.svelte';
	import Pill from './Pill.svelte';

	let { kind, id, listings }: { kind: FootprintSubject; id: string; listings: Listings } = $props();

	const COLLECT_TIMEOUT_MS = 45_000;

	const rows = $derived(rowsFor(db.publicFootprints(), kind, id));
	const views = $derived(bySource(rows));
	const latestAt = $derived(rows.length ? rows[rows.length - 1].fetchedAt : undefined);
	const listed = $derived(hasListing(listings));

	// Relative times follow the data source's clock; refresh them every 30 s and whenever rows arrive.
	let tick = $state(0);
	const now = $derived.by(() => {
		void tick;
		void rows.length;
		return db.now();
	});
	$effect(() => {
		const t = setInterval(() => (tick += 1), 30_000);
		return () => clearInterval(t);
	});

	// Collecting: disabled until a row has arrived for every listing on file, or 45 s pass.
	let collecting = $state(false);
	let offline = $state(false);
	/** Row ids on screen when the last collection started; null until one starts in this view. */
	let before = $state<Set<string> | null>(null);
	let expected = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const fresh = $derived(new Set(before ? rows.filter((r) => !before!.has(r.id)).map((r) => r.id) : []));
	const arrived = $derived(fresh.size);

	function stop() {
		collecting = false;
		clearTimeout(timer);
		timer = undefined;
	}

	$effect(() => {
		if (collecting && arrived >= Math.max(1, expected)) stop();
	});
	$effect(() => () => clearTimeout(timer));

	async function collect() {
		if (collecting) return;
		offline = false;
		before = new Set(rows.map((r) => r.id));
		expected = listingCount(listings);
		collecting = true;
		timer = setTimeout(stop, COLLECT_TIMEOUT_MS);
		try {
			await db.collectFootprint(kind, id);
		} catch (err) {
			stop();
			if (db.kind === 'live' && db.connection().agents === 'offline') offline = true;
			else toasts.error(err);
		}
	}

	// Where this business is listed publicly.
	let yelp = $state('');
	let jobs = $state('');
	let linkedin = $state('');
	let saving = $state(false);
	$effect(() => {
		yelp = listings.yelpUrl ?? '';
		jobs = listings.jobBoard ?? '';
		linkedin = listings.linkedinUrl ?? '';
	});
	const isUrl = (v: string) => !v.trim() || /^https?:\/\/\S+$/i.test(v.trim());
	const yelpErr = $derived(isUrl(yelp) ? '' : 'Paste the full page address, starting with https://');
	const jobsErr = $derived(!jobs.trim() || /^[a-z]+:[\w.-]+$/i.test(jobs.trim()) ? '' : 'Write it as board:company, for example greenhouse:stripe');
	const linkedinErr = $derived(isUrl(linkedin) ? '' : 'Paste the full page address, starting with https://');
	const dirty = $derived(yelp.trim() !== (listings.yelpUrl ?? '') || jobs.trim() !== (listings.jobBoard ?? '') || linkedin.trim() !== (listings.linkedinUrl ?? ''));

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (yelpErr || jobsErr || linkedinErr || saving) return;
		saving = true;
		await attempt(() => db.setListings(kind, id, { yelpUrl: yelp, jobBoard: jobs, linkedinUrl: linkedin }), 'Public listings saved.');
		saving = false;
	}

	const host = (url: string) => {
		try {
			return new URL(url).hostname.replace(/^www\./, '');
		} catch {
			return url;
		}
	};
	const listedNames = $derived(
		[listings.yelpUrl && 'Yelp', listings.jobBoard && (boardName(listings.jobBoard) ?? 'the job board'), listings.linkedinUrl && 'LinkedIn'].filter(Boolean).join(', ')
	);
	const fieldId = (name: string) => `fp-${kind}-${id}-${name}`;
</script>

{#snippet stat(label: string, value: string, sub?: string)}
	<div class="min-w-0">
		<dt class="eyebrow">{label}</dt>
		<dd class="num mt-0.5 text-xl">{value}</dd>
		{#if sub}<dd class="text-sm text-ink-3">{sub}</dd>{/if}
	</div>
{/snippet}

{#snippet numbers(r: PublicFootprint)}
	{#if r.source === 'yelp'}
		<dl class="mt-3 flex flex-wrap gap-x-8 gap-y-3">
			{@render stat('Rating', r.ratingTenths ? fmtRating(r.ratingTenths) : '–', r.ratingTenths ? 'out of 5' : 'no rating')}
			{@render stat('Reviews', fmtInt(r.reviewCount))}
		</dl>
		<p class="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-2">
			{#if r.isClosed}<Pill tone="neg">Closed</Pill>{:else}<Pill tone="pos">Open</Pill>{/if}
			{#if r.isClaimed}<Pill>Claimed by owner</Pill>{:else}<Pill tone="warn">Not claimed</Pill>{/if}
			{#if reviewsSinceYear(r)}<span>Reviews since at least <span class="num">{reviewsSinceYear(r)}</span></span>{/if}
		</p>
	{:else if r.source === 'jobs'}
		<dl class="mt-3 flex flex-wrap gap-x-8 gap-y-3">
			{@render stat('Open roles', fmtInt(r.openRoles), boardName(listings.jobBoard, r) ? `on ${boardName(listings.jobBoard, r)}` : undefined)}
		</dl>
	{:else if r.source === 'linkedin'}
		<dl class="mt-3 grid grid-cols-2 gap-x-8 gap-y-3 sm:flex sm:flex-wrap">
			{@render stat('Employees on LinkedIn', fmtInt(r.employees))}
			{@render stat('Followers', fmtInt(r.followers))}
			{#if factString(r, 'company_size')}{@render stat('Company size', (factString(r, 'company_size') ?? '').replace(/ employees$/, ''), 'employees')}{/if}
			{#if r.yearEstablished || factString(r, 'founded')}{@render stat('Founded', String(r.yearEstablished || factString(r, 'founded')))}{/if}
		</dl>
	{/if}
{/snippet}

<section aria-labelledby="fp-h-{kind}-{id}">
	<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
		<div class="min-w-0">
			<h2 id="fp-h-{kind}-{id}" class="text-2xl">Signals for a person, not a decision</h2>
			<p class="mt-1 max-w-[52ch] text-ink-2">Public web data about this business, collected on request. Nothing here changes the books.</p>
			<p class="mt-1 text-sm text-ink-3">
				{#if latestAt}Last fetched <time datetime={latestAt}>{dateTime(latestAt)}</time>{:else}Not collected yet{/if}
			</p>
		</div>
		<div class="flex shrink-0 flex-col gap-1 sm:items-end">
			<button class="btn" type="button" onclick={collect} disabled={collecting || !listed} aria-describedby="fp-status-{kind}-{id}">
				<Icon name="globe" size={18} />{collecting ? 'Collecting…' : 'Collect now'}
			</button>
			<p id="fp-status-{kind}-{id}" class="text-sm sm:text-right {offline ? 'text-warn' : 'text-ink-3'}" role="status">
				{#if offline}Agents offline. Start the agent gateway, then try again.{:else if collecting}Looking up {listedNames}…{:else if !listed}Needs a public listing first.{/if}
			</p>
		</div>
	</div>

	{#if views.length}
		<ul class="mt-4 divide-y divide-line border-y border-line">
			{#each views as v (v.source)}
				{@const shown = v.good ?? v.latest}
				{@const failed = v.latest.status === 'failed'}
				{@const change = v.good && v.previous ? deltas(v.good, v.previous) : []}
				<li>
				{#key v.latest.id}
				<div class="py-5 {fresh.has(v.latest.id) ? 'fp-fresh' : ''}">
					<div class="flex flex-wrap items-center gap-2">
						<h3 class="text-lg">{SOURCE_LABEL[v.source]}</h3>
						{#if v.latest.live}<Pill tone="accent">Live</Pill>{:else}<Pill tone="muted">Recorded</Pill>{/if}
						{#if failed}<Pill tone="neg">Could not fetch</Pill>{/if}
					</div>

					{#if failed}
						<p class="mt-2 max-w-[60ch] text-[15px] text-ink">
							{v.latest.error || 'The page could not be read.'}
							<span class="text-ink-3">Tried {relTime(v.latest.fetchedAt, now)}.</span>
							{#if v.good}<span class="text-ink-3">Showing the last good fetch below.</span>{/if}
						</p>
					{/if}

					{#if v.good}
						{@render numbers(v.good)}
						<p class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2">
							{#if !v.previous}
								<span>First run</span>
							{:else if change.length}
								<span class="text-ink-3">Since {shortDate(v.previous.fetchedAt)}:</span>
								{#each change as d (d.label)}
									<span class="num inline-flex items-center gap-0.5 text-ink">
										<Icon name={d.dir === 'up' ? 'arrowUp' : 'arrowDown'} size={14} class="text-ink-3" />{d.label}
									</span>
								{/each}
							{:else}
								<span>No change since {shortDate(v.previous.fetchedAt)}</span>
							{/if}
						</p>
						{#if v.good.summaryPlain}<p class="mt-3 max-w-[60ch] text-[15px]">{v.good.summaryPlain}</p>{/if}
					{/if}

					<p class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-3">
						{#if shown.sourceUrl}
							<a class="drill inline-flex min-h-[44px] items-center gap-1 text-ink-2 sm:min-h-0" href={shown.sourceUrl} target="_blank" rel="noopener noreferrer" title={shown.sourceUrl}>
								{host(shown.sourceUrl)}<Icon name="external" size={14} /><span class="sr-only">(opens in a new tab)</span>
							</a>
							<span aria-hidden="true">·</span>
						{/if}
						<span>fetched <time datetime={shown.fetchedAt} title={dateTime(shown.fetchedAt)}>{relTime(shown.fetchedAt, now)}</time></span>
						{#if v.runs > 1}<span aria-hidden="true">·</span><span>{v.runs} runs on file</span>{/if}
					</p>

				</div>
				{/key}
				</li>
			{/each}
		</ul>
	{:else if listed}
		<p class="mt-4 border-y border-line py-5 text-ink-2">Nothing collected yet. Collect now to see what a visitor finds on {listedNames}.</p>
	{:else}
		<div class="mt-4 border-y border-line py-5">
			<p class="font-medium">No public listing on file</p>
			<p class="mt-1 max-w-[60ch] text-[15px] text-ink-2">
				Add a Yelp page, a job board or a LinkedIn page below, then collect.
			</p>
		</div>
	{/if}

	<form class="mt-6" onsubmit={save} novalidate>
		<h3 class="text-lg">Public listings</h3>
		<p class="mt-1 text-sm text-ink-3">Where a visitor would look this business up. Leave a field blank to remove it.</p>
		<div class="mt-3 grid gap-3">
			<label class="flex flex-col gap-1 text-sm text-ink-2" for={fieldId('yelp')}>
				Yelp page
				<input id={fieldId('yelp')} class="field text-[15px] text-ink" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://www.yelp.com/biz/…" bind:value={yelp} aria-invalid={!!yelpErr} aria-describedby={yelpErr ? fieldId('yelp-err') : undefined} />
				{#if yelpErr}<span id={fieldId('yelp-err')} class="text-neg">{yelpErr}</span>{/if}
			</label>
			<label class="flex flex-col gap-1 text-sm text-ink-2" for={fieldId('jobs')}>
				Job board
				<input id={fieldId('jobs')} class="field num text-[15px] text-ink" type="text" autocomplete="off" spellcheck="false" placeholder="greenhouse:company or ashby:company" bind:value={jobs} aria-invalid={!!jobsErr} aria-describedby={jobsErr ? fieldId('jobs-err') : undefined} />
				{#if jobsErr}<span id={fieldId('jobs-err')} class="text-neg">{jobsErr}</span>{/if}
			</label>
			<label class="flex flex-col gap-1 text-sm text-ink-2" for={fieldId('linkedin')}>
				LinkedIn page
				<input id={fieldId('linkedin')} class="field text-[15px] text-ink" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://www.linkedin.com/company/…" bind:value={linkedin} aria-invalid={!!linkedinErr} aria-describedby={linkedinErr ? fieldId('linkedin-err') : undefined} />
				{#if linkedinErr}<span id={fieldId('linkedin-err')} class="text-neg">{linkedinErr}</span>{/if}
			</label>
		</div>
		<button class="btn mt-3" type="submit" disabled={saving || !dirty || !!(yelpErr || jobsErr || linkedinErr)}>{saving ? 'Saving…' : 'Save listings'}</button>
	</form>
</section>

<style>
	/* The one motion moment: a fetch that arrived while you watched washes in, then settles. */
	.fp-fresh {
		animation: fp-arrive 1600ms ease-out;
	}
	@keyframes fp-arrive {
		from {
			background-color: var(--accent-soft);
		}
		to {
			background-color: transparent;
		}
	}
</style>
