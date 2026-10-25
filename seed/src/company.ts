/**
 * Quillmesh company records outside the ledger: people and payroll, funding and the cap table, cost of service and
 * credit packs, the CRM and integrations. Deterministic: a fixed PRNG seed and the close month decide everything.
 *
 * Quillmesh, Inc. sells an AI document-automation API to insurance and logistics back offices (platform fee plus
 * per-page usage). Series A at $50M post-money closed March 2026 ($12M raised). See plan.md for the full profile.
 *
 * Rows use the web app's types (apps/web/src/lib/data/types.ts). Money is a string of minor units; dates are ISO.
 * Subsidiary and customer ids are the database ids the loader passes in, so the records join to the books.
 */

export type CompanyKind =
  | 'employee'
  | 'pto_request'
  | 'pay_run'
  | 'payslip'
  | 'funding_round'
  | 'investor'
  | 'commitment'
  | 'instrument'
  | 'cap_table_entry'
  | 'cloud_cost'
  | 'batch'
  | 'integration'
  | 'deal'
  | 'promotion'
  | 'support_ticket';

export type CompanyRecords = Record<CompanyKind, Record<string, unknown>[]>;

export type CompanyInput = {
  /** The month the demo closes, "YYYY-MM". History runs the 18 months up to and including it. */
  closeYm: string;
  /** Subsidiary code ("US", "UK") to database id. */
  subsidiaryIds: Map<string, string>;
  customers: { id: string; name: string }[];
};

export const COMPANY = {
  name: 'Quillmesh, Inc.',
  ukName: 'Quillmesh Ltd',
  postMoneyMinor: 5_000_000_000n,
  seriesAMinor: 1_200_000_000n,
} as const;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const ymAdd = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
};
const iso = (ym: string, day: number, hour = 0) => {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1, Math.min(day, last), hour)).toISOString().replace('.000Z', 'Z');
};
const lastDay = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
/** Round half away from zero to whole minor units. */
const money = (n: number) => String(Math.sign(n) * Math.round(Math.abs(n)));

// ---------- people ----------

type Seat = { title: string; department: string; country: 'US' | 'UK'; salary: number; type?: string; start: string };

const FIRST = ['Maya', 'Theo', 'Priya', 'Jonah', 'Amara', 'Lucas', 'Sofia', 'Ravi', 'Hana', 'Owen', 'Leila', 'Mateo', 'Ines', 'Kofi', 'Elena', 'Daniel', 'Yuki', 'Nadia', 'Samuel', 'Grace', 'Arjun', 'Zara', 'Felix', 'Imani', 'Noah', 'Chloe', 'Tariq', 'Ruth', 'Emil', 'Ana', 'Ben', 'Clara', 'Dev', 'Esther', 'Farid', 'Gemma', 'Hugo', 'Ivy', 'Jamal', 'Kira', 'Liam', 'Mira', 'Nico', 'Olga', 'Pablo', 'Quinn', 'Rosa', 'Sven', 'Tara', 'Uma', 'Victor', 'Wren', 'Xavi', 'Yara', 'Zane', 'Aiden', 'Bea', 'Cyrus', 'Dina', 'Eli', 'Fiona', 'Gus'];
const LAST = ['Okonkwo', 'Lindgren', 'Raman', 'Castillo', 'Haddad', 'Moreau', 'Nakamura', 'Fitzgerald', 'Abara', 'Petrov', 'Delgado', 'Brennan', 'Sato', 'Mensah', 'Kowalski', 'Ferreira', 'Iqbal', 'Larsen', 'Osei', 'Varga', 'Quinlan', 'Whitaker', 'Ashby', 'Rinaldi', 'Takahashi', 'Ndiaye', 'Holm', 'Kapoor', 'Silva', 'Marsh', 'Novak', 'Ahmed'];

function seats(): Seat[] {
  const s: Seat[] = [
    { title: 'Chief executive officer and co-founder', department: 'leadership', country: 'US', salary: 210_000, start: '2024-02' },
    { title: 'Chief technology officer and co-founder', department: 'leadership', country: 'US', salary: 205_000, start: '2024-02' },
    { title: 'Chief financial officer', department: 'finance', country: 'US', salary: 235_000, start: '2026-04' },
    { title: 'Controller', department: 'finance', country: 'US', salary: 165_000, start: '2026-05' },
    { title: 'AP and AR specialist', department: 'finance', country: 'US', salary: 92_000, start: '2026-06' },
    { title: 'Head of people', department: 'people', country: 'US', salary: 150_000, start: '2025-09' },
    { title: 'VP of sales', department: 'sales', country: 'US', salary: 190_000, start: '2025-06' },
    { title: 'Managing director, UK', department: 'leadership', country: 'UK', salary: 140_000, start: '2025-10' },
  ];
  const add = (n: number, title: string, department: string, country: 'US' | 'UK', lo: number, hi: number, firstStart: string, type?: string) => {
    for (let i = 0; i < n; i++) s.push({ title, department, country, salary: lo + Math.round(((hi - lo) * i) / Math.max(1, n - 1)), start: ymAdd(firstStart, Math.floor((i * 17) / Math.max(1, n))), type });
  };
  add(15, 'Software engineer', 'engineering', 'US', 150_000, 205_000, '2024-04');
  add(4, 'Software engineer', 'engineering', 'UK', 85_000, 110_000, '2025-11');
  add(6, 'Machine learning engineer', 'research', 'US', 185_000, 240_000, '2024-06');
  add(3, 'Product manager', 'product', 'US', 160_000, 185_000, '2025-01');
  add(2, 'Product designer', 'design', 'US', 140_000, 160_000, '2025-03');
  add(6, 'Account executive', 'sales', 'US', 120_000, 150_000, '2025-07');
  add(3, 'Account executive', 'sales', 'UK', 70_000, 85_000, '2025-12');
  add(2, 'Marketing manager', 'marketing', 'US', 130_000, 145_000, '2025-08');
  add(4, 'Customer success manager', 'customer_success', 'US', 95_000, 120_000, '2025-05');
  add(3, 'Customer success manager', 'customer_success', 'UK', 55_000, 65_000, '2026-01');
  add(2, 'Solutions engineer', 'operations', 'US', 150_000, 165_000, '2025-10');
  add(3, 'Operations analyst', 'operations', 'UK', 50_000, 58_000, '2026-02');
  add(1, 'Annotation contractor', 'operations', 'US', 0, 0, '2026-03', 'contractor');
  return s;
}

function buildPeople(input: CompanyInput, rand: () => number) {
  const us = input.subsidiaryIds.get('US') ?? '1';
  const uk = input.subsidiaryIds.get('UK') ?? us;
  const employees: Record<string, unknown>[] = [];
  const all = seats();
  all.forEach((seat, i) => {
    const id = `qm-emp-${String(i + 1).padStart(2, '0')}`;
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;
    const ukSeat = seat.country === 'UK';
    const contractor = seat.type === 'contractor';
    const onLeave = i === 23;
    employees.push({
      id,
      subsidiaryId: ukSeat ? uk : us,
      name,
      title: seat.title,
      department: seat.department,
      managerId: i < 2 ? undefined : i < 8 ? 'qm-emp-01' : seat.department === 'engineering' || seat.department === 'research' ? 'qm-emp-02' : seat.country === 'UK' ? 'qm-emp-08' : 'qm-emp-01',
      email: `${name.split(' ')[0].toLowerCase()}@quillmesh.example`,
      location: ukSeat ? 'London, UK' : i % 3 === 0 ? 'New York, NY' : 'San Francisco, CA',
      startAt: iso(seat.start, 1),
      type: contractor ? 'contractor' : 'full_time',
      status: onLeave ? 'on_leave' : 'active',
      annualSalaryMinor: contractor ? '0' : String(seat.salary * 100),
      hourlyRateMinor: contractor ? '8500' : undefined,
      ccy: ukSeat ? 'GBP' : 'USD',
      payFrequency: ukSeat ? 'monthly' : contractor ? 'monthly' : 'semi_monthly',
      retirementBp: ukSeat ? 500 : 400,
      benefitsMonthlyMinor: ukSeat ? '0' : String(85_000 + Math.round(rand() * 30_000)),
      serviceShareBp: seat.department === 'customer_success' || seat.department === 'operations' ? 6000 : 0,
      optionsGranted: i < 2 ? undefined : Math.round((seat.salary || 60_000) * (i < 8 ? 1.2 : 0.35)),
      deposit: [{ bankName: ukSeat ? 'Barclays' : 'Chase', accountLast4: String(1000 + ((i * 7919) % 9000)), accountType: ukSeat ? 'current' : 'checking', remainder: true }],
      pto: { accrualHoursPerRun: ukSeat ? 0 : 5, unlimited: !ukSeat, balanceHours: ukSeat ? 120 + (i % 5) * 8 : 0, usedHoursYtd: 16 + ((i * 13) % 72), sickBalanceHours: 40 },
    });
  });

  const pto: Record<string, unknown>[] = [];
  const kinds = ['vacation', 'vacation', 'sick', 'vacation', 'parental', 'vacation', 'bereavement', 'vacation'];
  for (let k = 0; k < 16; k++) {
    const e = employees[(k * 5 + 3) % employees.length];
    const ym = ymAdd(input.closeYm, (k % 4) - 1);
    const kind = k === 4 ? 'parental' : kinds[k % kinds.length];
    const days = kind === 'parental' ? 60 : kind === 'sick' ? 2 : 3 + (k % 5);
    pto.push({
      id: `qm-pto-${String(k + 1).padStart(2, '0')}`,
      employeeId: e.id,
      kind,
      startAt: iso(ym, 3 + k),
      endAt: iso(ym, 3 + k + Math.min(days, 25)),
      hours: days * 8,
      status: k < 10 ? 'taken' : k < 14 ? 'approved' : 'pending',
      notePlain: kind === 'parental' ? 'Parental leave, approved by the head of people.' : undefined,
    });
  }

  // Pay runs: the six months to the close. US twice a month, UK monthly. Employees count from their start month.
  const runs: Record<string, unknown>[] = [];
  const slips: Record<string, unknown>[] = [];
  for (let back = 5; back >= 0; back--) {
    const ym = ymAdd(input.closeYm, -back);
    const halves: { sub: 'US' | 'UK'; part: string; end: number }[] = [
      { sub: 'US', part: 'a', end: 15 },
      { sub: 'US', part: 'b', end: lastDay(ym) },
      { sub: 'UK', part: 'm', end: lastDay(ym) - 2 },
    ];
    for (const h of halves) {
      const staff = employees.filter((e) => (h.sub === 'UK') === (e.ccy === 'GBP') && e.type !== 'contractor' && String(e.startAt).slice(0, 7) <= ym);
      const perRun = h.sub === 'US' ? 24 : 12;
      const runId = `qm-run-${h.sub.toLowerCase()}-${ym}-${h.part}`;
      let gross = 0;
      let eeTax = 0;
      let ded = 0;
      for (const e of staff) {
        const g = Math.round(Number(e.annualSalaryMinor) / perRun);
        const t = Math.round(g * (h.sub === 'US' ? 0.26 : 0.22));
        const d = Math.round(g * (Number(e.retirementBp) / 10_000));
        gross += g;
        eeTax += t;
        ded += d;
        slips.push({ id: `${runId}-${String(e.id).slice(-2)}`, payRunId: runId, employeeId: e.id, grossMinor: money(g), employeeTaxMinor: money(t), deductionsMinor: money(d), netMinor: money(g - t - d), ptoHoursUsed: 0, ccy: e.ccy });
      }
      const erTax = Math.round(gross * (h.sub === 'US' ? 0.0765 : 0.138));
      const benefits = h.sub === 'US' ? staff.reduce((n, e) => n + Number(e.benefitsMonthlyMinor), 0) / 2 : 0;
      const current = back === 0 && h.part !== 'a';
      runs.push({
        id: runId,
        subsidiaryId: h.sub === 'UK' ? uk : us,
        periodStart: iso(ym, h.part === 'b' ? 16 : 1),
        periodEnd: iso(ym, h.end),
        payDate: iso(ym, h.end),
        debitDate: iso(ym, h.end - 2),
        status: current ? 'scheduled' : 'paid',
        ccy: h.sub === 'UK' ? 'GBP' : 'USD',
        employeeCount: staff.length,
        grossMinor: money(gross),
        employeeTaxMinor: money(eeTax),
        deductionsMinor: money(ded),
        employerTaxMinor: money(erTax),
        employerBenefitsMinor: money(benefits),
        netMinor: money(gross - eeTax - ded),
        provider: h.sub === 'UK' ? 'Deel' : 'Gusto',
      });
    }
  }
  return { employees, pto, runs, slips };
}

// ---------- financing and the cap table ----------

function buildFinancing(input: CompanyInput) {
  const us = input.subsidiaryIds.get('US') ?? '1';
  const investors = [
    { id: 'qm-inv-harbor', name: 'Harborline Capital', kind: 'fund', country: 'US', payerNames: ['Harborline Capital Fund III LP'], contactName: 'Renee Calder' },
    { id: 'qm-inv-tidal', name: 'Tidal Ventures', kind: 'fund', country: 'US', payerNames: ['Tidal Ventures II LP'], contactName: 'Marcus Webb' },
    { id: 'qm-inv-forge', name: 'Forge Accelerator', kind: 'accelerator', country: 'US', payerNames: ['Forge Accelerator LLC'] },
    { id: 'qm-inv-lowe', name: 'Dana Lowe', kind: 'angel', country: 'US', payerNames: ['Dana Lowe'] },
    { id: 'qm-inv-ash', name: 'Ashgrove Partners', kind: 'fund', country: 'UK', payerNames: ['Ashgrove Partners LLP'], contactName: 'Imogen Hale' },
    { id: 'qm-inv-north', name: 'Northpier Insurance Ventures', kind: 'corporate', country: 'US', payerNames: ['Northpier Strategic Investments'] },
    { id: 'qm-inv-spv', name: 'Operators SPV I', kind: 'spv', country: 'US', payerNames: ['Operators SPV I LLC'] },
  ];
  const rounds = [
    { id: 'qm-rd-preseed', subsidiaryId: us, name: 'Pre-seed (SAFEs)', targetMinor: '75000000', ccy: 'USD', openedAt: '2024-02-15T00:00:00Z', closedAt: '2024-05-31T00:00:00Z', status: 'closed', leadInvestorId: 'qm-inv-forge' },
    { id: 'qm-rd-seed', subsidiaryId: us, name: 'Seed', targetMinor: '350000000', ccy: 'USD', openedAt: '2025-01-10T00:00:00Z', closedAt: '2025-03-28T00:00:00Z', status: 'closed', leadInvestorId: 'qm-inv-tidal', pricePerShareE4: '1580000', preMoneyMinor: '1400000000' },
    { id: 'qm-rd-a', subsidiaryId: us, name: 'Series A', targetMinor: '1200000000', ccy: 'USD', openedAt: '2026-01-12T00:00:00Z', closedAt: '2026-03-20T00:00:00Z', status: 'closed', leadInvestorId: 'qm-inv-harbor', pricePerShareE4: '3050000', preMoneyMinor: '3800000000' },
    { id: 'qm-rd-b', subsidiaryId: us, name: 'Series B (planning)', targetMinor: '4000000000', ccy: 'USD', openedAt: '2027-03-01T00:00:00Z', status: 'planned' },
  ];
  const ins = (id: string, roundId: string, investorId: string, kind: string, principal: string, signedAt: string, shares: number, extra: Record<string, unknown> = {}) => ({
    id, roundId, investorId, kind, principalMinor: principal, ccy: 'USD', signedAt, mfn: false, proRata: kind !== 'safe_post_money', shares, documentIds: [],
    classification: 'equity',
    classificationPlain: kind.startsWith('safe') ? 'Equity: the SAFE converted into Seed preferred stock in March 2025, so no SAFE balance remains.' : 'Equity: preferred stock issued for cash, held in paid-in capital.',
    status: kind.startsWith('safe') ? 'converted' : 'outstanding',
    ...extra,
  });
  const instruments = [
    ins('qm-ins-forge', 'qm-rd-preseed', 'qm-inv-forge', 'safe_post_money', '50000000', '2024-02-20T00:00:00Z', 506_329, { valuationCapMinor: '800000000' }),
    ins('qm-ins-lowe', 'qm-rd-preseed', 'qm-inv-lowe', 'safe_post_money', '25000000', '2024-05-10T00:00:00Z', 253_164, { valuationCapMinor: '800000000' }),
    ins('qm-ins-tidal', 'qm-rd-seed', 'qm-inv-tidal', 'preferred_shares', '250000000', '2025-03-28T00:00:00Z', 1_582_278),
    ins('qm-ins-spv', 'qm-rd-seed', 'qm-inv-spv', 'preferred_shares', '100000000', '2025-03-28T00:00:00Z', 632_911),
    ins('qm-ins-harbor', 'qm-rd-a', 'qm-inv-harbor', 'preferred_shares', '800000000', '2026-03-20T00:00:00Z', 2_622_951),
    ins('qm-ins-north', 'qm-rd-a', 'qm-inv-north', 'preferred_shares', '250000000', '2026-03-20T00:00:00Z', 819_672),
    ins('qm-ins-ash', 'qm-rd-a', 'qm-inv-ash', 'preferred_shares', '150000000', '2026-03-20T00:00:00Z', 491_803),
  ];
  const commitments = instruments.map((x, i) => ({
    id: `qm-cm-${i + 1}`,
    roundId: x.roundId,
    investorId: x.investorId,
    instrumentId: x.id,
    amountMinor: x.principalMinor,
    ccy: 'USD',
    receivedMinor: x.principalMinor,
    status: 'funded',
    expectedBy: x.signedAt,
  }));
  const cap = [
    { id: 'qm-ct-ceo', holderName: 'Maya Okonkwo', security: 'common', shares: 3_792_167, investedMinor: '0', employeeId: 'qm-emp-01', asOf: '2024-02-01T00:00:00Z' },
    { id: 'qm-ct-cto', holderName: 'Theo Fitzgerald', security: 'common', shares: 3_792_167, investedMinor: '0', employeeId: 'qm-emp-02', asOf: '2024-02-01T00:00:00Z' },
    ...instruments.map((x) => ({
      id: `qm-ct-${x.id.slice(7)}`,
      holderName: investors.find((v) => v.id === x.investorId)!.name,
      investorId: x.investorId,
      security: 'preferred',
      shares: x.shares,
      investedMinor: x.principalMinor,
      asOf: x.signedAt,
    })),
    { id: 'qm-ct-granted', holderName: 'Employees (options granted)', security: 'options_granted', shares: 1_310_000, investedMinor: '0', asOf: iso(input.closeYm, 30) },
    { id: 'qm-ct-pool', holderName: 'Unallocated option pool', security: 'option_pool', shares: 590_000, investedMinor: '0', asOf: iso(input.closeYm, 30) },
  ].map((r) => ({ ccy: 'USD', ...r }));
  return { investors, rounds, instruments, commitments, cap };
}

// ---------- cost of service and credit packs ----------

function buildCosts(input: CompanyInput, rand: () => number) {
  const us = input.subsidiaryIds.get('US') ?? '1';
  const uk = input.subsidiaryIds.get('UK') ?? us;
  const lines: { provider: string; service: string; env: string; category: string; base: number; unit: string; perUnit: number; growth: number; sub?: string; product: string }[] = [
    { provider: 'aws', service: 'GPU inference fleet (p5)', env: 'production', category: 'cost_of_revenue', base: 18_000, unit: 'GPU-hours', perUnit: 4.1, growth: 0.072, product: 'Extract API' },
    { provider: 'aws', service: 'API and queue servers', env: 'production', category: 'cost_of_revenue', base: 6_500, unit: 'instance-hours', perUnit: 0.21, growth: 0.05, product: 'Extract API' },
    { provider: 'aws', service: 'Document storage (S3)', env: 'production', category: 'cost_of_revenue', base: 1_900, unit: 'TB-months', perUnit: 23, growth: 0.06, product: 'Extract API' },
    { provider: 'anthropic', service: 'Claude API, layout reasoning', env: 'production', category: 'cost_of_revenue', base: 9_000, unit: 'M tokens', perUnit: 6, growth: 0.08, product: 'Extract API' },
    { provider: 'openai', service: 'Embedding API', env: 'production', category: 'cost_of_revenue', base: 2_200, unit: 'M tokens', perUnit: 0.13, growth: 0.07, product: 'Search' },
    { provider: 'together', service: 'Fine-tuning jobs', env: 'development', category: 'r_and_d', base: 7_500, unit: 'GPU-hours', perUnit: 3.2, growth: 0.04, product: 'Model research' },
    { provider: 'gcp', service: 'Eval cluster', env: 'staging', category: 'r_and_d', base: 3_800, unit: 'GPU-hours', perUnit: 2.9, growth: 0.03, product: 'Model research' },
    { provider: 'aws', service: 'EU inference region (London)', env: 'production', category: 'cost_of_revenue', base: 2_600, unit: 'GPU-hours', perUnit: 4.4, growth: 0.11, sub: 'UK', product: 'Extract API' },
    { provider: 'datadog', service: 'Observability', env: 'shared', category: 'g_and_a', base: 2_400, unit: 'hosts', perUnit: 23, growth: 0.03, product: 'Platform' },
    { provider: 'snowflake', service: 'Usage metering warehouse', env: 'shared', category: 'g_and_a', base: 1_600, unit: 'credits', perUnit: 3, growth: 0.04, product: 'Platform' },
    { provider: 'vercel', service: 'Dashboard hosting', env: 'production', category: 'cost_of_revenue', base: 450, unit: 'GB-hours', perUnit: 0.18, growth: 0.03, product: 'Dashboard' },
    { provider: 'github', service: 'Seats and Actions', env: 'shared', category: 'r_and_d', base: 900, unit: 'seats', perUnit: 21, growth: 0.04, product: 'Platform' },
  ];
  const costs: Record<string, unknown>[] = [];
  let n = 0;
  for (let back = 17; back >= 0; back--) {
    const ym = ymAdd(input.closeYm, -back);
    const t = 17 - back;
    for (const l of lines) {
      if (l.sub === 'UK' && ym < '2025-11') continue;
      let usd = l.base * Math.pow(1 + l.growth, t) * (0.94 + rand() * 0.12);
      // A planted spike: an eval job left running on the GPU fleet in the close month's prior month.
      if (l.service.startsWith('GPU inference') && back === 1) usd *= 1.38;
      n++;
      costs.push({
        id: `qm-cc-${String(n).padStart(4, '0')}`,
        subsidiaryId: l.sub === 'UK' ? uk : us,
        provider: l.provider,
        service: l.service,
        ym,
        environment: l.env,
        category: l.category,
        amountMinor: money(usd * 100),
        ccy: 'USD',
        usageQuantity: Math.round(usd / l.perUnit),
        usageUnit: l.unit,
        product: l.product,
      });
    }
  }

  const batches: Record<string, unknown>[] = [];
  const customers = input.customers;
  for (let k = 0; k < 24; k++) {
    const c = customers.length ? customers[(k * 7) % customers.length] : undefined;
    const ym = ymAdd(input.closeYm, -(k % 9));
    const qty = [50, 100, 250, 500, 1000][k % 5];
    const used = Math.min(qty, Math.round(qty * (0.2 + rand() * 0.95)));
    const expires = ymAdd(ym, 6);
    const expired = expires < input.closeYm;
    const remaining = qty - used;
    batches.push({
      id: `qm-bt-${String(k + 1).padStart(2, '0')}`,
      subsidiaryId: us,
      kind: 'credit_pack',
      sku: `PG-${qty}K`,
      name: `Page credits, ${qty}k pages`,
      customerId: c?.id,
      quantity: qty,
      remaining,
      unit: 'k pages',
      amountMinor: String(qty * 9_000),
      ccy: 'USD',
      acquiredAt: iso(ym, 5),
      expiresAt: iso(expires, 5),
      status: remaining === 0 ? 'depleted' : expired ? 'expired' : expires <= ymAdd(input.closeYm, 1) ? 'expiring' : 'active',
    });
  }
  return { costs, batches };
}

// ---------- CRM and integrations ----------

const PROSPECTS = ['Meridian Mutual', 'Bluewater Freight', 'Cascade Claims Group', 'Ironbridge Logistics', 'Palisade Insurance', 'Redwood Cargo', 'Summit Underwriters', 'Atlas Brokerage', 'Lakeshore Health Plans', 'Granite Freight Lines', 'Beacon Specialty', 'Copperline Shipping', 'Harbor Assurance', 'Northgate 3PL', 'Silverleaf Risk', 'Tri-County Haulers', 'Evergreen Mutual', 'Keystone Forwarding'];

function buildCrm(input: CompanyInput, rand: () => number) {
  const stages = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];
  const owners = ['Ravi Raman', 'Sofia Castillo', 'Owen Haddad', 'Leila Nakamura'];
  const deals = PROSPECTS.map((name, i) => {
    const stage = stages[i % stages.length];
    const enterprise = i % 4 === 0;
    const amount = enterprise ? 250_000 + Math.round(rand() * 400_000) : 25_000 + Math.round(rand() * 90_000);
    const prob = { lead: 1000, qualified: 2500, proposal: 5000, negotiation: 7500, won: 10000, lost: 0 }[stage] ?? 0;
    return {
      id: `qm-dl-${String(i + 1).padStart(2, '0')}`,
      source: 'hubspot',
      companyName: name,
      stage,
      amountMinor: String(amount * 100),
      ccy: 'USD',
      probabilityBp: prob,
      expectedCloseAt: iso(ymAdd(input.closeYm, 1 + (i % 4)), 10 + (i % 15)),
      ownerName: owners[i % owners.length],
      updatedAt: iso(input.closeYm, 20 + (i % 9), 15),
    };
  });
  const promotions = [
    { id: 'qm-pm-1', source: 'stripe', code: 'FREIGHT25', descriptionPlain: '25% off the first three months for logistics teams', discountBp: 2500, ccy: 'USD', startsAt: iso(ymAdd(input.closeYm, -2), 1), endsAt: iso(ymAdd(input.closeYm, 1), 30), redemptions: 31, discountGivenMinor: '1162500', status: 'active' },
    { id: 'qm-pm-2', source: 'stripe', code: 'PAGES10K', descriptionPlain: '10,000 free pages on any annual plan', amountOffMinor: '90000', ccy: 'USD', startsAt: iso(ymAdd(input.closeYm, -6), 1), endsAt: iso(ymAdd(input.closeYm, -3), 30), redemptions: 18, discountGivenMinor: '1620000', status: 'ended' },
    { id: 'qm-pm-3', source: 'stripe', code: 'RENEW2027', descriptionPlain: '8% off a two-year renewal signed before year end', discountBp: 800, ccy: 'USD', startsAt: iso(ymAdd(input.closeYm, 2), 1), redemptions: 0, discountGivenMinor: '0', status: 'scheduled' },
  ];
  const subjects = ['Bill of lading fields missing on scanned pages', 'Webhook retries after 502s', 'Invoice totals extracted with wrong currency', 'Need SOC 2 report for procurement', 'Claims batch stuck in processing', 'API key rotation question', 'Usage overage on the September invoice', 'Handwritten claim forms accuracy'];
  const priorities = ['urgent', 'high', 'normal', 'normal', 'high', 'low', 'normal', 'high'];
  const tickets = Array.from({ length: 24 }, (_, i) => {
    const c = input.customers.length ? input.customers[(i * 5) % input.customers.length] : undefined;
    const ym = ymAdd(input.closeYm, i < 16 ? 0 : 1);
    const opened = iso(ym, 1 + ((i * 3) % 27), 9 + (i % 8));
    const slaHours = { urgent: 1, high: 4, normal: 24, low: 72 }[priorities[i % 8]] ?? 24;
    const status = i < 14 ? 'solved' : i < 19 ? 'open' : i < 22 ? 'pending' : 'new';
    return {
      id: `qm-tk-${String(i + 1).padStart(2, '0')}`,
      source: 'zendesk',
      customerId: c?.id,
      requesterName: c ? `Ops team, ${c.name}` : 'Prospect',
      subject: subjects[i % subjects.length],
      priority: priorities[i % 8],
      status,
      channel: ['email', 'chat', 'slack', 'phone'][i % 4],
      openedAt: opened,
      firstResponseAt: status === 'new' ? undefined : new Date(Date.parse(opened) + (20 + (i % 5) * 25) * 60_000).toISOString().replace('.000Z', 'Z'),
      solvedAt: status === 'solved' ? new Date(Date.parse(opened) + (6 + i) * 3_600_000).toISOString().replace('.000Z', 'Z') : undefined,
      slaDueAt: new Date(Date.parse(opened) + slaHours * 3_600_000).toISOString().replace('.000Z', 'Z'),
    };
  });
  const sync = iso(ymAdd(input.closeYm, 1), 2, 11);
  const integrations = [
    { id: 'hubspot', name: 'HubSpot', category: 'crm', recordsSynced: 4_812, readsPlain: 'Deals, pipeline stages and expected close dates' },
    { id: 'zendesk', name: 'Zendesk', category: 'support', recordsSynced: 2_290, readsPlain: 'Tickets, priorities and SLA timers' },
    { id: 'stripe', name: 'Stripe', category: 'billing', recordsSynced: 18_406, readsPlain: 'Self-serve subscriptions, card payments and promotions' },
    { id: 'gusto', name: 'Gusto', category: 'payroll', recordsSynced: 1_104, readsPlain: 'US pay runs and payslips' },
    { id: 'deel', name: 'Deel', category: 'payroll', recordsSynced: 168, readsPlain: 'UK pay runs and payslips' },
    { id: 'aws', name: 'AWS Cost Explorer', category: 'cloud', recordsSynced: 9_870, readsPlain: 'GPU, compute and storage cost by service and environment' },
    { id: 'anthropic', name: 'Anthropic usage', category: 'model_usage', recordsSynced: 540, readsPlain: 'Model usage and spend by API key' },
    { id: 'openai', name: 'OpenAI usage', category: 'model_usage', recordsSynced: 540, readsPlain: 'Embedding usage and spend' },
    { id: 'carta', name: 'Carta', category: 'cap_table', recordsSynced: 64, readsPlain: 'Shareholders, option grants and rounds' },
  ].map((x) => ({ status: 'connected', connectedAt: '2026-04-06T16:00:00Z', lastSyncAt: sync, ...x }));
  return { deals, promotions, tickets, integrations };
}

/** Every Quillmesh company record, by kind. Pure: same input, same output. */
export function buildCompany(input: CompanyInput): CompanyRecords {
  const rand = mulberry32(5_000_000);
  const people = buildPeople(input, rand);
  const fin = buildFinancing(input);
  const cost = buildCosts(input, rand);
  const crm = buildCrm(input, rand);
  const strip = (rows: Record<string, unknown>[]) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)));
  return {
    employee: strip(people.employees),
    pto_request: strip(people.pto),
    pay_run: strip(people.runs),
    payslip: strip(people.slips),
    funding_round: strip(fin.rounds),
    investor: strip(fin.investors),
    commitment: strip(fin.commitments),
    instrument: strip(fin.instruments),
    cap_table_entry: strip(fin.cap),
    cloud_cost: strip(cost.costs),
    batch: strip(cost.batches),
    integration: strip(crm.integrations),
    deal: strip(crm.deals),
    promotion: strip(crm.promotions),
    support_ticket: strip(crm.tickets),
  };
}
