<script lang="ts">
	// Charters: each agent's plain-English rules. The finance team edits one and saves it as a new draft version; a
	// draft changes nothing until the CFO publishes it, which the ledger module allows only after the version's latest
	// eval is a passing full eval. The editor maps every line to the rule or eval scenario that checks it; a custom
	// Charter can only make the gate stricter.
	import { onDestroy } from 'svelte';
	import { db } from '#lib/data/index.js';
	import type { CharterCatalog, CharterEvalMode, CharterEvalRun, CharterMappingEntry, CharterMappingTarget, CharterParamSpec, CharterVersion } from '#lib/data/types.js';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import { CHARTER_ROLES, editorProblems, latestEval, parseCharterLines, parseMapping, publishable, remap, scenariosFor, shippedTargets, showParam, templatesFor, templateTarget } from '#lib/charter.js';
	import { dateTime, roleName, type Tone } from '#lib/labels.js';
	import { attempt } from '#lib/toast.svelte.js';
	import { builtinBody, charterView, toolGroups } from '#lib/charter-view.js';

	// The catalog (templates, scenarios, Built-in Charters) comes from the agent gateway.
	let catalog = $state<CharterCatalog | null>(null);
	let catalogError = $state('');
	async function loadCatalog() {
		catalogError = '';
		try {
			catalog = await db.charterCatalog();
		} catch (err) {
			catalogError = err instanceof Error ? err.message : String(err);
		}
	}
	void loadCatalog();

	const seat = $derived(db.cfoSeat().status);
	const canAct = $derived(seat === 'you');
	let role = $state<string>('bookkeeper');

	const versions = $derived(db.charterVersions());
	const evals = $derived(db.charterEvals());
	const ofRole = (r: string) => versions.filter((v) => v.role === r).sort((a, b) => b.version - a.version);
	const liveOf = (r: string) => versions.find((v) => v.role === r && v.status === 'live');
	const roleVersions = $derived(ofRole(role));
	const live = $derived(liveOf(role));

	const STATUS_PILL: Record<CharterVersion['status'], { label: string; tone: Tone }> = {
		draft: { label: 'Draft', tone: 'neutral' },
		live: { label: 'Live', tone: 'pos' },
		retired: { label: 'Retired', tone: 'muted' }
	};
	const MODE_WORDS: Record<CharterEvalMode, string> = { dry_run: 'Full eval', snapshot: 'Quick check' };

	function evalPill(v: CharterVersion): { label: string; tone: Tone } {
		const e = latestEval(evals, v.id);
		if (!e) return { label: 'Not evaluated', tone: 'muted' };
		return { label: `${MODE_WORDS[e.mode]} ${e.passed ? 'passed' : 'failed'}`, tone: e.passed ? (e.mode === 'dry_run' ? 'pos' : 'accent') : 'neg' };
	}

	// ---------- eval runs ----------
	let runs = $state<Record<string, CharterEvalRun>>({});
	let poll: ReturnType<typeof setTimeout> | undefined;
	onDestroy(() => clearTimeout(poll));
	async function refreshRuns(ids: string[]) {
		clearTimeout(poll);
		for (const id of ids) {
			try {
				const r = await db.charterEvalRun(id);
				if (r.status !== 'idle') runs[id] = r;
			} catch {
				/* the gateway is offline: the recorded evals still show */
			}
		}
		const running = Object.values(runs).filter((r) => r.status === 'running').map((r) => r.versionId!);
		if (running.length) poll = setTimeout(() => void refreshRuns(running), 1500);
	}
	$effect(() => {
		const drafts = roleVersions.filter((v) => v.status !== 'live').map((v) => v.id);
		if (drafts.length) void refreshRuns(drafts);
	});
	const anyRunning = $derived(Object.values(runs).some((r) => r.status === 'running'));

	async function startEval(v: CharterVersion, mode: CharterEvalMode) {
		await attempt(async () => {
			runs[v.id] = await db.startCharterEval(v.id, mode);
			void refreshRuns([v.id]);
		}, mode === 'dry_run' ? `Full eval of version ${v.version} started. It reruns the whole close on a scratch copy of the books, about a minute.` : `Quick check of version ${v.version} started.`);
	}

	// ---------- publish and retire ----------
	let publishing = $state<CharterVersion | null>(null);
	let publishOpen = $state(false);
	let retireOpen = $state(false);

	// ---------- editor ----------
	let editing = $state(false);
	let draftBody = $state('');
	let draftMapping = $state<CharterMappingEntry[]>([]);
	let draftSummary = $state('');
	let basedOn = $state<CharterVersion | undefined>(undefined);
	let saving = $state(false);

	function edit(from?: CharterVersion) {
		if (!catalog) return;
		const builtin = catalog.builtin[role];
		const src = from ?? live;
		draftBody = src?.bodyMd ?? builtin?.bodyMd ?? '';
		draftMapping = remap(catalog, role, draftBody, src ? parseMapping(src.mappingJson) : (builtin?.mapping ?? []));
		draftSummary = '';
		basedOn = src;
		editing = true;
	}
	function onBodyInput(value: string) {
		draftBody = value;
		if (catalog) draftMapping = remap(catalog, role, draftBody, draftMapping);
	}
	const problems = $derived(catalog && editing ? editorProblems(catalog, role, draftBody, draftMapping) : []);
	const summaryOk = $derived(draftSummary.trim().length >= 10);
	const shipped = $derived(catalog ? shippedTargets(catalog, role) : new Map<string, CharterMappingTarget>());

	async function save() {
		if (!catalog || saving) return;
		saving = true;
		const ok = await attempt(
			() => db.saveCharterDraft({ role, bodyMd: draftBody, mapping: $state.snapshot(draftMapping), summaryPlain: draftSummary.trim(), basedOnVersionId: basedOn?.id }),
			'Saved as a new draft. Run the full eval before publishing it.'
		);
		saving = false;
		if (ok) editing = false;
	}

	/** The select value for a target, and back. */
	const targetKey = (t: CharterMappingTarget) => (t.kind === 'rule' ? `rule:${t.template}` : t.kind === 'scenario' ? `scenario:${t.scenario}` : 'custom');
	function setTarget(i: number, key: string) {
		if (!catalog) return;
		const e = draftMapping[i]!;
		if (key.startsWith('rule:')) {
			const t = catalog.templates.find((x) => x.id === key.slice(5));
			if (t) e.target = templateTarget(t);
		} else if (key.startsWith('scenario:')) e.target = { kind: 'scenario', scenario: key.slice(9) };
		else e.target = { kind: 'custom_scenario', yaml: e.target.kind === 'custom_scenario' ? e.target.yaml : '' };
	}
	const templateOf = (t: CharterMappingTarget) => (t.kind === 'rule' && catalog ? catalog.templates.find((x) => x.id === t.template) : undefined);
	/** A bp param shows as a percentage, a minor param as dollars. */
	function paramShown(p: CharterParamSpec, v: unknown): string {
		if (p.type === 'bp') return typeof v === 'number' ? String(v / 100) : '';
		if (p.type === 'minor') return typeof v === 'string' || typeof v === 'number' ? String(Number(v) / 100) : '';
		return v === undefined ? '' : String(v);
	}
	function setParam(i: number, p: CharterParamSpec, raw: string) {
		const t = draftMapping[i]!.target;
		if (t.kind !== 'rule') return;
		const n = Number(raw);
		const v = p.type === 'bp' ? Math.round(n * 100) : p.type === 'minor' ? String(Math.round(n * 100)) : p.type === 'int' ? Math.round(n) : raw;
		t.params = { ...(t.params ?? {}), [p.name]: v };
	}
	function toggleKind(i: number, p: CharterParamSpec, kind: string, on: boolean) {
		const t = draftMapping[i]!.target;
		if (t.kind !== 'rule') return;
		const cur = Array.isArray(t.params?.[p.name]) ? (t.params![p.name] as string[]) : [];
		t.params = { ...(t.params ?? {}), [p.name]: on ? [...new Set([...cur, kind])] : cur.filter((k) => k !== kind) };
	}
	const titleOf = (t: CharterMappingTarget) => {
		if (t.kind === 'rule') return templateOf(t)?.titlePlain ?? t.template;
		if (t.kind === 'scenario') return `Eval scenario: ${t.scenario}`;
		return 'Custom eval scenario';
	};

	// ---------- eval report ----------
	interface Report {
		demo?: boolean;
		coverage?: { ok: boolean; problems: string[] };
		probes?: { label: string; pass: boolean; detail: string }[];
		scenarios?: { label: string; id: string; status: string; detail: string }[];
	}
	const reportOf = (json: string): Report => {
		try {
			return JSON.parse(json) as Report;
		} catch {
			return {};
		}
	};
	let openReport = $state<Record<string, boolean>>({});
	const roleLabel = (r: string) => roleName(r as Parameters<typeof roleName>[0]);

	// ---------- the Charter in force and the role's tools ----------
	const builtin = $derived(builtinBody(catalog, role));
	const inForce = $derived(charterView(live?.bodyMd ?? builtin.bodyMd));
	const tools = $derived(toolGroups(catalog, role));
	const toolCount = $derived(tools.groups.reduce((n, g) => n + g.tools.filter((t) => t.kind === 'tool').length, 0));
	const SECTIONS_SHOWN = [
		{ key: 'may', title: 'May propose' },
		{ key: 'mustNever', title: 'Must never' },
		{ key: 'escalates', title: 'Leaves for a person' }
	] as const;
</script>

<svelte:head><title>Charters · Cafoo</title></svelte:head>

<div class="flex flex-col gap-2">
	<h1 class="text-[34px] sm:text-[42px]">Charters</h1>
	<p class="max-w-[68ch] text-ink-2">
		Each agent works to a Charter: plain-English lines saying what it may propose, what it must never do and what it leaves for a person. Edit one and save it as a new version. A custom
		Charter can only make the gate stricter, and you can publish a version only after its latest eval is a passing full eval.
	</p>
	{#if seat !== 'you'}
		<p class="text-sm text-ink-3">This browser is read-only: only the CFO's browser can save, evaluate, publish or retire a Charter.</p>
	{/if}
</div>

{#if catalogError}
	<div class="mt-6 flex flex-col gap-2 rounded-card bg-error-container px-4 py-3 text-on-error-container sm:flex-row sm:items-center sm:justify-between" role="alert">
		<p class="text-[15px]">{catalogError} The versions below still show; editing needs the agent gateway.</p>
		<button class="btn btn-quiet self-start text-on-error-container" onclick={() => void loadCatalog()}>Try again</button>
	</div>
{/if}

<div class="mt-6 flex flex-wrap gap-2" role="group" aria-label="Agent">
	{#each CHARTER_ROLES as r (r)}
		{@const lv = liveOf(r)}
		<button
			type="button"
			class="chip"
			aria-pressed={role === r}
			onclick={() => {
				role = r;
				editing = false;
			}}
		>
			{roleLabel(r)}
			<span class="text-xs opacity-80">{lv ? `v${lv.version}` : 'built-in'}</span>
		</button>
	{/each}
</div>

<section class="mt-6 flex flex-col gap-4" aria-labelledby="role-h">
	<div class="card flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
		<div class="min-w-0">
			<h2 id="role-h" class="text-2xl">{roleLabel(role)}</h2>
			<p class="mt-1 text-ink-2">
				{#if live}
					In force: version {live.version}, published {live.publishedAt ? dateTime(live.publishedAt) : ''}. {live.summaryPlain}
				{:else}
					In force: the Built-in Charter (version 0), as the agent shipped.
				{/if}
			</p>
		</div>
		<div class="flex flex-wrap gap-2">
			<button class="btn btn-primary" disabled={!catalog || !canAct} onclick={() => edit()}><Icon name="book" size={18} />Edit</button>
			{#if live}
				<button class="btn" disabled={!canAct} onclick={() => (retireOpen = true)}><Icon name="undo" size={18} />Restore built-in</button>
			{/if}
		</div>
	</div>

	<div class="card flex flex-col gap-5 p-5" aria-labelledby="in-force-h">
		<div>
			<h3 id="in-force-h" class="text-subtitle">{live ? `Version ${live.version}` : 'Built-in Charter'}: what the {roleLabel(role)} works to</h3>
			{#if inForce.intro}<p class="mt-2 max-w-prose text-body-sm text-ink-2">{inForce.intro}</p>{/if}
			{#if !live && builtin.bundled}<p class="mt-1 text-caption text-ink-3">Shown from the copy bundled with this app, because the agent gateway did not answer.</p>{/if}
		</div>
		<div class="grid gap-5 md:grid-cols-3">
			{#each SECTIONS_SHOWN as sec (sec.key)}
				<section aria-label={sec.title}>
					<h4 class="eyebrow">{sec.title}</h4>
					<ol class="mt-2 flex flex-col gap-3">
						{#each inForce[sec.key] as l (l.label)}
							<li class="flex gap-2 text-body-sm"><span class="num shrink-0 text-ink-3">{l.label.replace(/^\D+/, '')}.</span><span>{l.text}</span></li>
						{:else}
							<li class="text-body-sm text-ink-3">No lines.</li>
						{/each}
					</ol>
				</section>
			{/each}
		</div>
		{#if inForce.plain}
			<p class="border-t border-line pt-4 text-body-sm text-ink-2"><span class="font-medium text-ink">Plain summary rule:</span> {inForce.plain}</p>
		{/if}
	</div>

	<div class="card flex flex-col gap-4 p-5" aria-labelledby="tools-h">
		<div>
			<h3 id="tools-h" class="text-subtitle">Tools</h3>
			<p class="mt-1 text-body-sm text-ink-2">
				The {toolCount} tools the {roleLabel(role)} may call. The harness refuses any other tool, and every call is checked against the lines above before it runs; the ledger module checks again when it writes.
			</p>
			{#if tools.bundled && tools.groups.length}<p class="mt-1 text-caption text-ink-3">Listed from the copy bundled with this app; the agent gateway did not report its tools.</p>{/if}
		</div>
		{#each tools.groups as g (g.source)}
			<section aria-label={g.label}>
				<h4 class="eyebrow">{g.label}</h4>
				<ul class="mt-2 flex flex-col divide-y divide-line border-y border-line">
					{#each g.tools as t (t.name)}
						<li class="flex flex-col gap-1 py-2 sm:flex-row sm:items-baseline sm:gap-4">
							<span class="flex shrink-0 items-center gap-2 sm:w-64">
								<code class="font-mono text-caption text-ink">{t.name}</code>
								{#if t.kind === 'service'}<Pill tone="muted">service</Pill>{/if}
							</span>
							<span class="text-body-sm text-ink-2">{t.description}</span>
						</li>
					{/each}
				</ul>
			</section>
		{:else}
			<p class="text-body-sm text-ink-3">No tool list is available for this role.</p>
		{/each}
	</div>

	{#if editing && catalog}
		<div class="card flex flex-col gap-5 p-5" aria-label="Charter editor">
			<div class="flex flex-wrap items-baseline justify-between gap-2">
				<h3 class="text-xl">New draft of the {roleLabel(role)} Charter</h3>
				<p class="text-sm text-ink-3">Based on {basedOn ? `version ${basedOn.version}` : 'the Built-in Charter'}</p>
			</div>
			<label class="flex flex-col gap-1 text-sm text-ink-2">
				Charter text
				<textarea class="field min-h-[320px] font-mono text-[13px] leading-6 text-ink" spellcheck="false" value={draftBody} oninput={(ev) => onBodyInput((ev.currentTarget as HTMLTextAreaElement).value)}></textarea>
				<span class="text-ink-3">Sections: ## May, ## Must never, ## Escalates (numbered lines) and ## Plain summary rule. Reword a shipped line freely; you cannot remove it.</span>
			</label>

			<div>
				<h4 class="text-lg">What checks each line</h4>
				<p class="mt-1 text-sm text-ink-3">Every line maps to a rule the gate runs or an eval scenario. A shipped line keeps its rule, or a template that tightens it.</p>
				<ul class="mt-3 flex flex-col divide-y divide-line border-y border-line">
					{#each draftMapping as e, i (e.label)}
						{@const isShipped = shipped.has(e.label)}
						{@const sh = shipped.get(e.label)}
						{@const tpls = templatesFor(catalog, role, e.label)}
						{@const tpl = templateOf(e.target)}
						<li class="flex flex-col gap-2 py-3">
							<div class="flex flex-wrap items-baseline gap-2">
								<span class="num text-sm font-medium">{e.label}</span>
								{#if isShipped}<Pill tone="muted">shipped</Pill>{:else}<Pill tone="accent">new</Pill>{/if}
							</div>
							<p class="text-[15px]">{e.text}</p>
							{#if sh?.kind === 'scenario'}
								<p class="text-sm text-ink-2">Checked by its shipped eval scenario.</p>
							{:else}
								<label class="flex flex-col gap-1 text-sm text-ink-2">
									<span class="sr-only">Check for {e.label}</span>
									<select class="field text-ink" aria-label="Check for {e.label}" value={targetKey(e.target)} onchange={(ev) => setTarget(i, (ev.currentTarget as HTMLSelectElement).value)}>
										{#each tpls as t (t.id)}
											<option value="rule:{t.id}">{t.id.startsWith('builtin:') ? 'As shipped' : t.titlePlain}</option>
										{/each}
										{#if !isShipped}
											{#each scenariosFor(catalog, role) as s (s.id)}
												<option value="scenario:{s.id}">Eval scenario: {s.charterLine}</option>
											{/each}
											{#if e.target.kind === 'custom_scenario'}<option value="custom">Custom eval scenario</option>{/if}
										{/if}
										{#if !tpls.some((t) => targetKey(e.target) === `rule:${t.id}`) && e.target.kind === 'rule'}
											<option value={targetKey(e.target)}>{titleOf(e.target)}</option>
										{/if}
									</select>
								</label>
							{/if}
							{#if e.target.kind === 'rule' && tpl?.params.length}
								<div class="flex flex-wrap gap-4">
									{#each tpl.params as p (p.name)}
										{#if p.type === 'kinds'}
											<fieldset class="flex flex-col gap-1 text-sm text-ink-2">
												<legend>{p.labelPlain}</legend>
												<div class="flex flex-wrap gap-x-4 gap-y-1">
													{#each p.options ?? [] as k (k)}
														{@const on = Array.isArray(e.target.params?.[p.name]) && (e.target.params![p.name] as string[]).includes(k)}
														<label class="flex min-h-[32px] items-center gap-2 text-ink"><input type="checkbox" checked={on} onchange={(ev) => toggleKind(i, p, k, (ev.currentTarget as HTMLInputElement).checked)} />{k.replace(/_/g, ' ')}</label>
													{/each}
												</div>
											</fieldset>
										{:else}
											<label class="flex flex-col gap-1 text-sm text-ink-2">
												{p.labelPlain}{p.type === 'bp' ? ' (%)' : p.type === 'minor' ? ' ($)' : ''}
												<input
													class="field num w-40 text-ink"
													type={p.type === 'text' ? 'text' : 'number'}
													step={p.type === 'bp' ? '0.01' : p.type === 'minor' ? '0.01' : '1'}
													value={paramShown(p, e.target.params?.[p.name])}
													onchange={(ev) => setParam(i, p, (ev.currentTarget as HTMLInputElement).value)}
												/>
												{#if p.min !== undefined || p.max !== undefined}
													<span class="text-xs text-ink-3">{p.min !== undefined ? `from ${showParam(p, p.min)}` : ''}{p.min !== undefined && p.max !== undefined ? ' ' : ''}{p.max !== undefined ? `to ${showParam(p, p.max)}` : ''}</span>
												{/if}
											</label>
										{/if}
									{/each}
								</div>
							{/if}
							{#if e.target.kind === 'custom_scenario'}
								<label class="flex flex-col gap-1 text-sm text-ink-2">
									Custom scenario (YAML)
									<textarea
										class="field min-h-[120px] font-mono text-[13px] text-ink"
										value={e.target.yaml}
										oninput={(ev) => (draftMapping[i]!.target = { kind: 'custom_scenario', yaml: (ev.currentTarget as HTMLTextAreaElement).value })}
									></textarea>
								</label>
							{/if}
						</li>
					{/each}
				</ul>
				{#if !parseCharterLines(draftBody).length}<p class="mt-2 text-sm text-neg">The text has no numbered lines under May, Must never or Escalates.</p>{/if}
			</div>

			<label class="flex flex-col gap-1 text-sm text-ink-2">
				What changed, in one plain sentence
				<input class="field text-ink" bind:value={draftSummary} placeholder="e.g. Batch bank matches only when every match is at least ninety percent confident." />
			</label>

			{#if problems.length}
				<div class="rounded-card bg-warning-container px-4 py-3 text-on-warning-container" role="status">
					<p class="font-medium">Fix before saving</p>
					<ul class="mt-1 list-disc pl-5 text-[15px]">{#each problems as p (p)}<li>{p}</li>{/each}</ul>
				</div>
			{/if}

			<div class="flex flex-wrap gap-2">
				<button class="btn btn-primary" disabled={!canAct || saving || problems.length > 0 || !summaryOk} onclick={() => void save()}>{saving ? 'Saving...' : 'Save as new draft'}</button>
				<button class="btn btn-text" onclick={() => (editing = false)}>Cancel</button>
				{#if !summaryOk && !problems.length}<span class="self-center text-sm text-ink-3">Add a plain sentence about the change (at least 10 characters).</span>{/if}
			</div>
		</div>
	{/if}

	<div>
		<h3 class="text-xl">Versions</h3>
		{#if !roleVersions.length}
			<p class="mt-2 text-ink-2">No custom versions yet. The Built-in Charter applies.</p>
		{:else}
			<ul class="mt-3 flex flex-col gap-3">
				{#each roleVersions as v (v.id)}
					{@const e = latestEval(evals, v.id)}
					{@const run = runs[v.id]}
					{@const pill = evalPill(v)}
					{@const ready = publishable(v, evals)}
					<li class="card flex flex-col gap-3 p-4">
						<div class="flex flex-wrap items-center gap-2">
							<span class="font-medium">Version {v.version}</span>
							<Pill tone={STATUS_PILL[v.status].tone}>{STATUS_PILL[v.status].label}</Pill>
							{#if v.status !== 'live'}<Pill tone={pill.tone}>{pill.label}</Pill>{/if}
							<span class="text-sm text-ink-3">saved {dateTime(v.createdAt)}{v.publishedAt ? ` · published ${dateTime(v.publishedAt)}` : ''}</span>
						</div>
						<p class="text-[15px]">{v.summaryPlain}</p>
						{#if e}
							<p class="text-sm text-ink-2">{e.summaryPlain} <span class="text-ink-3">({MODE_WORDS[e.mode]}, {dateTime(e.ranAt)})</span></p>
						{/if}
						{#if run && (run.status === 'running' || run.status === 'error')}
							<div class="rounded-card bg-surface-container px-4 py-3" role="status" aria-live="polite">
								<p class="text-sm font-medium">{run.status === 'running' ? `${run.mode ? MODE_WORDS[run.mode] : 'Eval'} running` : 'The eval stopped with an error'}</p>
								<ol class="mt-1 list-decimal pl-5 text-sm text-ink-2">{#each run.steps as s, k (k)}<li>{s}</li>{/each}</ol>
								{#if run.error}<p class="mt-1 text-sm text-neg">{run.error}</p>{/if}
							</div>
						{/if}
						<div class="flex flex-wrap gap-2">
							{#if v.status !== 'live'}
								<button class="btn btn-tonal" disabled={!canAct || anyRunning} onclick={() => void startEval(v, 'dry_run')}><Icon name="play" size={16} />Run full eval</button>
								<button class="btn" disabled={!canAct || anyRunning} onclick={() => void startEval(v, 'snapshot')}>Quick check</button>
								<button
									class="btn btn-primary"
									disabled={!canAct || !ready}
									title={ready ? '' : 'Publishing needs a passing full eval as the latest eval of this version'}
									onclick={() => {
										publishing = v;
										publishOpen = true;
									}}><Icon name="check" size={16} />Publish</button
								>
							{/if}
							<button class="btn btn-text" disabled={!catalog || !canAct} onclick={() => edit(v)}>Edit from this version</button>
							{#if e}
								<button class="btn btn-text" aria-expanded={!!openReport[v.id]} onclick={() => (openReport[v.id] = !openReport[v.id])}>{openReport[v.id] ? 'Hide' : 'Show'} eval report</button>
							{/if}
						</div>
						{#if v.status !== 'live' && !ready}
							<p class="text-sm text-ink-3">
								{#if !e}Run the full eval: publishing needs its latest eval to be a passing full eval.
								{:else if !e.passed && e.mode === 'snapshot'}A quick check judges the close already recorded under the old Charter, so a tightened line can fail it. The full eval reruns the close under this version.
								{:else if !e.passed}Fix what failed, save a new draft and evaluate it.
								{:else}A quick check only informs; run the full eval before publishing.{/if}
							</p>
						{/if}
						{#if e && openReport[v.id]}
							{@const rep = reportOf(e.resultsJson)}
							<div class="flex flex-col gap-2 rounded-card border border-line p-4 text-sm">
								{#if rep.demo}<p class="text-ink-3">Demo mode replays no close: this eval checked the line mapping only.</p>{/if}
								<p><span class="font-medium">Line mapping:</span> {rep.coverage?.ok ? 'every line is mapped and every shipped rule stays' : `${rep.coverage?.problems.length ?? 0} problem(s)`}</p>
								{#if rep.coverage && !rep.coverage.ok}
									<ul class="list-disc pl-5 text-neg">{#each rep.coverage.problems as p (p)}<li>{p}</li>{/each}</ul>
								{/if}
								{#if rep.probes?.length}
									<p><span class="font-medium">Gate probes:</span> {rep.probes.filter((p) => p.pass).length} of {rep.probes.length} got the expected verdict</p>
									<ul class="flex flex-col gap-1">
										{#each rep.probes.filter((p) => !p.pass) as p (p.label)}
											<li class={p.pass ? 'text-ink-2' : 'text-neg'}>{p.pass ? 'Held' : 'Failed'}: {p.label}</li>
										{/each}
									</ul>
								{/if}
								{#if rep.scenarios?.length}
									{@const bad = rep.scenarios.filter((s) => s.status === 'FAIL' || s.status === 'ERROR')}
									<p><span class="font-medium">Eval scenarios:</span> {rep.scenarios.filter((s) => s.status === 'PASS').length} passed, {bad.length} failed, {rep.scenarios.filter((s) => s.status !== 'PASS' && s.status !== 'FAIL' && s.status !== 'ERROR').length} skipped or not applicable</p>
									<ul class="flex flex-col gap-1">
										{#each rep.scenarios.filter((s) => s.status === 'FAIL' || s.status === 'ERROR') as s (s.id + s.label)}
											<li class={s.status === 'FAIL' || s.status === 'ERROR' ? 'text-neg' : 'text-ink-2'}><span class="num">{s.status}</span> {s.label}: {s.detail}</li>
										{/each}
									</ul>
								{/if}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</section>

<ConfirmDialog
	bind:open={publishOpen}
	title={publishing ? `Publish version ${publishing.version} of the ${roleLabel(publishing.role)} Charter?` : 'Publish?'}
	body={publishing ? `It goes live for the next close and replaces ${live ? `version ${live.version}` : 'the Built-in Charter'}. ${publishing.summaryPlain}` : ''}
	confirmLabel="Publish"
	inputLabel="Note for the record (optional)"
	onconfirm={async (note) => {
		if (!publishing) return;
		const v = publishing;
		await attempt(() => db.publishCharter(v.id, note), `Version ${v.version} of the ${roleLabel(v.role)} Charter is live.`);
	}}
/>

<ConfirmDialog
	bind:open={retireOpen}
	title="Restore the built-in Charter?"
	body={live ? `Version ${live.version} retires and the ${roleLabel(role)} works to the Built-in Charter again from the next close.` : ''}
	confirmLabel="Restore built-in"
	inputLabel="Why (optional)"
	onconfirm={async (note) => {
		const r = role;
		await attempt(() => db.retireLiveCharter(r, note), `The built-in ${roleLabel(r)} Charter applies again.`);
	}}
/>

