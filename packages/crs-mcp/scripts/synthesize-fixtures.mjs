// Synthesizes fixtures/crs/<product>/<name>.json for every persona row of crs-sandbox-dataset.csv,
// from the documented sandbox outcomes (expected_outcome column + CRS product guides).
// Run: pnpm -F @cafoo/crs-mcp fixtures:synth   (builds dist first)
// Live recordings (CrsClient { record }) overwrite these files with synthesized:false.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDataset, fixtureName, bureauOf } from '../dist/csv.js';
import { fixturesDir } from '../dist/paths.js';

const AS_OF = '2026-10-20';
const ORDERED = `${AS_OF}T15:04:05Z`;
const SHORT = { transunion: 'tu', equifax: 'efx', experian: 'exp' };
const SRC = { transunion: 'TransUnion', equifax: 'Equifax', experian: 'Experian' };
const MODEL = {
  transunion: 'TransUnionVantageScore4.0',
  equifax: 'EquifaxVantageScore4.0',
  experian: 'ExperianVantageScore4.0',
};

// ---------- tradeline builders (CRS Standard Format Tradeline) ----------
let acct = 1000;
const tl = (o) => ({
  accountIdentifier: `XXXX${++acct}`,
  accountOwnershipType: 'Individual',
  borrowerSourceType: 'Borrower',
  accountReportedDate: '2026-09-30',
  accountStatusType: 'Open',
  accountType: 'Revolving',
  currentRatingType: 'AsAgreed',
  currentRatingCode: '1',
  derogatoryDataIndicator: false,
  pastDueAmount: '0',
  _30DayLates: '0',
  _60DayLates: '0',
  _90DayLates: '0',
  ...o,
});
const card = (creditorName, opened, limit, balance, extra = {}) =>
  tl({ creditorName, accountOpenedDate: opened, creditLimitAmount: String(limit), highBalanceAmount: String(Math.max(balance, Math.round(limit * 0.4))), currentBalanceAmount: String(balance), monthlyPaymentAmount: String(Math.max(25, Math.round(balance * 0.03))), termsDescription: 'Revolving', businessType: 'Banking', ...extra });
const installment = (creditorName, opened, amount, balance, payment, loanType, extra = {}) =>
  tl({ creditorName, accountOpenedDate: opened, accountType: 'Installment', highBalanceAmount: String(amount), currentBalanceAmount: String(balance), monthlyPaymentAmount: String(payment), loanType, termsMonthsCount: '60', businessType: 'Finance', ...extra });
const mortgage = (creditorName, opened, amount, balance, payment) =>
  tl({ creditorName, accountOpenedDate: opened, accountType: 'Mortgage', highBalanceAmount: String(amount), currentBalanceAmount: String(balance), monthlyPaymentAmount: String(payment), termsMonthsCount: '360', businessType: 'Banking' });
const closed = (t, closedDate) => ({ ...t, accountStatusType: 'Closed', accountClosedDate: closedDate, currentBalanceAmount: '0', monthlyPaymentAmount: '0' });
const collection = (creditorName, originalCreditorName, amount, opened) =>
  tl({ creditorName, originalCreditorName, accountOpenedDate: opened, accountType: 'Open', businessType: 'CollectionServices', currentRatingType: 'Collection', currentRatingCode: '9', derogatoryDataIndicator: true, highBalanceAmount: String(amount), currentBalanceAmount: String(amount), pastDueAmount: String(amount) });
const chargeOff = (creditorName, opened, amount, chargeOffDate, paid) =>
  tl({ creditorName, accountOpenedDate: opened, accountType: 'Revolving', currentRatingType: 'ChargeOff', currentRatingCode: '9', derogatoryDataIndicator: true, chargeOffAmount: String(amount), chargeOffDate, highBalanceAmount: String(amount), _90DayLates: '1', ...(paid ? { accountStatusType: 'Paid', accountPaidDate: paid, currentBalanceAmount: '0', pastDueAmount: '0' } : { accountStatusType: 'Closed', currentBalanceAmount: String(amount), pastDueAmount: String(amount) }) });
const inBankruptcy = (t, balance = '0') => ({ ...t, accountStatusType: 'Closed', currentRatingType: 'BankruptcyOrWageEarnerPlan', currentRatingCode: '7', derogatoryDataIndicator: true, currentBalanceAmount: balance, monthlyPaymentAmount: '0' });
const inquiry = (creditorName, inquiryDate, businessType = 'Banking') => ({ creditorName, inquiryDate, businessType, accountOwnershipType: 'Individual', borrowerSourceType: 'Borrower' });

const primeTrades = () => [
  mortgage('WELLS HOME LENDING', '2012-06-15', 410000, 238500, 2140),
  installment('CAPITAL AUTO FINANCE', '2023-04-02', 32000, 14200, 610, 'Automobile'),
  card('CHASE CARD SERVICES', '2006-02-11', 18000, 640),
  card('AMERICAN EXPRESS', '2009-08-20', 25000, 1210),
  card('CITI CARDS', '2011-03-05', 12000, 0),
  card('DISCOVER BANK', '2014-10-12', 9000, 310),
  closed(installment('NAVIENT', '2003-09-01', 28000, 0, 0, 'Educational'), '2013-05-30'),
  closed(card('MACYS', '2008-11-01', 3000, 0), '2019-01-15'),
  card('US BANK', '2016-07-22', 15000, 420),
];

// ---------- persona specs ----------
const clean = (score, trades = primeTrades(), inquiries = [inquiry('CHASE CARD SERVICES', '2025-02-10')]) => {
  const b = { status: 'FileReturned', score, tradelines: trades, inquiries, publicRecords: [] };
  return { transunion: b, equifax: b, experian: b };
};
const all = (b) => ({ transunion: b, equifax: b, experian: b });
const NOHIT = { status: 'NoFileReturnedNoHit' };

const CREDIT = {
  P01: clean(790),
  P02: clean(815, [
    mortgage('JPMORGAN CHASE MORTGAGE', '2015-05-01', 1250000, 1068000, 6420),
    mortgage('BANK OF THE HILLS HELOC', '2019-02-14', 150000, 40500, 380),
    card('AMERICAN EXPRESS', '1998-04-10', 40000, 820),
    card('CHASE CARD SERVICES', '2001-09-18', 30000, 0),
    card('CITI CARDS', '2005-01-25', 22000, 150),
    closed(installment('TOYOTA MOTOR CREDIT', '2018-03-01', 48000, 0, 0, 'Automobile'), '2023-03-01'),
  ], [inquiry('LEXUS FINANCIAL SERVICES', '2026-09-02', 'Automotive')]),
  P03: {
    transunion: { status: 'FileReturned', score: 660, tradelines: [card('DISCOVER STUDENT', '2026-02-01', 500, 140)], inquiries: [inquiry('DISCOVER BANK', '2026-01-28')], publicRecords: [] },
    equifax: { status: 'FileReturned', score: 660, tradelines: [card('DISCOVER STUDENT', '2026-02-01', 500, 140)], inquiries: [inquiry('DISCOVER BANK', '2026-01-28')], publicRecords: [] },
    experian: {
      status: 'FileReturned', score: 660, inquiries: [inquiry('DISCOVER BANK', '2026-01-28')], publicRecords: [],
      tradelines: [
        card('DISCOVER STUDENT', '2026-02-01', 500, 140),
        tl({ creditorName: 'T-MOBILE', accountOpenedDate: '2026-02-15', accountType: 'Open', businessType: 'Utilities', currentBalanceAmount: '65', monthlyPaymentAmount: '65' }),
        installment('AFFIRM INC', '2026-05-03', 420, 210, 35, 'Unsecured'),
        installment('AFFIRM INC', '2026-08-11', 300, 250, 25, 'Unsecured'),
        card('CAPITAL ONE (AUTHORIZED USER)', '2021-06-01', 3000, 220, { accountOwnershipType: 'AuthorizedUser' }),
      ],
    },
  },
  P04: all(NOHIT),
  P05: all({
    status: 'FileReturned', score: 540, publicRecords: [],
    tradelines: [
      card('CAPITAL ONE', '2017-03-10', 3000, 3010, { currentRatingType: 'Late90Days', currentRatingCode: '4', derogatoryDataIndicator: true, pastDueAmount: '412', _30DayLates: '3', _60DayLates: '2', _90DayLates: '1' }),
      card('CREDIT ONE BANK', '2019-08-21', 1500, 1488, { _30DayLates: '2' }),
      card('SYNCHRONY BANK', '2020-01-14', 2500, 2470, { _30DayLates: '1' }),
      installment('WESTLAKE FINANCIAL', '2022-06-30', 18500, 13900, 455, 'Automobile', { _30DayLates: '2' }),
      collection('PORTFOLIO RECOVERY ASSOCIATES', 'COMENITY BANK', 1840, '2024-11-02'),
      collection('MIDLAND CREDIT MANAGEMENT', 'VERIZON WIRELESS', 690, '2025-07-19'),
    ],
    inquiries: [
      inquiry('CARVANA', '2026-09-28', 'Automotive'), inquiry('CREDIT ONE BANK', '2026-09-15'), inquiry('MISSION LANE', '2026-09-03'),
      inquiry('UPSTART NETWORK', '2026-08-27', 'Finance'), inquiry('OPORTUN', '2026-08-12', 'Finance'), inquiry('AVANT', '2026-07-30', 'Finance'),
    ],
  }),
  P06: all({
    status: 'FileReturned', score: 580, inquiries: [inquiry('OPENSKY SECURED', '2024-05-02')],
    tradelines: [
      card('OPENSKY SECURED VISA', '2024-05-10', 500, 90, { termsDescription: 'Secured' }),
      inBankruptcy(card('CAPITAL ONE', '2012-04-01', 6000, 0)),
      inBankruptcy(card('BARCLAYS BANK', '2015-09-12', 8000, 0)),
      inBankruptcy(installment('LENDINGCLUB', '2020-02-03', 15000, 0, 0, 'Unsecured')),
      inBankruptcy(card('SYNCHRONY BANK', '2017-11-30', 4000, 0)),
    ],
    publicRecords: [{ publicRecordType: 'BankruptcyChapter7', dispositionType: 'Discharged', filedDate: '2023-02-14', dispositionDate: '2024-01-22', reportedDate: '2024-01-31', courtName: 'US BANKRUPTCY COURT SOUTHERN DISTRICT OF OHIO', docketIdentifier: '2:23-bk-50411', bankruptcyType: 'Personal', accountOwnershipType: 'Individual', borrowerSourceType: 'Borrower' }],
  }),
  P07: all({
    status: 'FileReturned', score: 560, inquiries: [],
    tradelines: [
      inBankruptcy(card('CITI CARDS', '2010-05-01', 9000, 0), '7420'),
      inBankruptcy(card('DISCOVER BANK', '2013-08-01', 6000, 0), '5110'),
      inBankruptcy(installment('ALLY FINANCIAL', '2021-09-15', 26000, 0, 0, 'Automobile'), '11800'),
      mortgage('ROCKET MORTGAGE', '2016-04-01', 210000, 171000, 1380),
    ],
    publicRecords: [{ publicRecordType: 'BankruptcyChapter13', dispositionType: 'Filed', filedDate: '2025-03-10', reportedDate: '2025-03-31', courtName: 'US BANKRUPTCY COURT NORTHERN DISTRICT OF GEORGIA', docketIdentifier: '25-52187', bankruptcyType: 'Personal', bankruptcyRepaymentPercent: '60', accountOwnershipType: 'Individual', borrowerSourceType: 'Borrower' }],
  }),
  P08: all({
    status: 'FileReturned', score: 690, publicRecords: [], inquiries: [inquiry('DISCOVER BANK', '2026-03-12')],
    tradelines: [
      card('CHASE CARD SERVICES', '2010-01-04', 12000, 5900),
      card('BANK OF AMERICA', '2013-06-19', 8000, 4100),
      installment('HONDA FINANCIAL SERVICES', '2022-08-01', 29000, 16400, 540, 'Automobile'),
      installment('SOFI LENDING', '2023-11-15', 20000, 13200, 470, 'Unsecured', { _30DayLates: '1' }),
      card('TARGET CARD SERVICES', '2016-09-09', 2000, 300),
    ],
  }),
  P09: clean(700, primeTrades().slice(1, 7), [inquiry('CAPITAL ONE', '2025-06-01')]),
  P10: clean(720, primeTrades().slice(1, 8)),
  P11: all({
    status: 'FileReturned', score: 610, publicRecords: [], inquiries: [inquiry('MISSION LANE', '2026-06-14'), inquiry('PETAL CARD', '2026-02-02')],
    tradelines: [
      card('CAPITAL ONE', '2016-05-01', 2000, 1720, { _30DayLates: '2', _60DayLates: '1' }),
      card('CREDIT ONE BANK', '2018-03-11', 1000, 860, { _30DayLates: '1' }),
      installment('SANTANDER CONSUMER USA', '2021-10-05', 16000, 9100, 389, 'Automobile', { _30DayLates: '2' }),
      tl({ creditorName: 'SDG&E', accountOpenedDate: '2022-01-01', accountType: 'Open', businessType: 'Utilities', currentBalanceAmount: '120', monthlyPaymentAmount: '120' }),
    ],
  }),
  P12: all(NOHIT),
  P13: all({
    status: 'FileReturned', score: 640, publicRecords: [],
    tradelines: [
      card('CAPITAL ONE (AUTHORIZED USER)', '2026-05-02', 8000, 260, { accountOwnershipType: 'AuthorizedUser' }),
      card('MERRICK BANK', '2026-07-19', 1000, 940),
    ],
    inquiries: ['2026-10-12', '2026-10-05', '2026-10-01', '2026-09-26', '2026-09-20', '2026-09-11', '2026-09-03', '2026-08-28', '2026-08-24'].map((d, i) =>
      inquiry(['SYNCHRONY BANK', 'CAPITAL ONE', 'DISCOVER BANK', 'CITI CARDS', 'BARCLAYS BANK', 'GOLDMAN SACHS BANK', 'AMERICAN EXPRESS', 'WELLS FARGO CARD', 'US BANK'][i], d)),
  }),
  P14: all({ status: 'deceased' }),
  P15: {
    transunion: { status: 'NoFileReturnedCreditFreeze' },
    equifax: { status: 'FileReturned', score: 740, tradelines: primeTrades().slice(1, 7), inquiries: [inquiry('US BANK', '2025-12-01')], publicRecords: [] },
    experian: { status: 'FileReturned', score: 740, tradelines: primeTrades().slice(1, 7), inquiries: [inquiry('US BANK', '2025-12-01')], publicRecords: [] },
  },
  P16: clean(730, primeTrades().slice(0, 6)),
  P17: {
    transunion: { status: 'FileReturned', score: 760, tradelines: primeTrades().slice(1, 7), inquiries: [], publicRecords: [] },
    equifax: NOHIT,
    experian: {
      status: 'FileReturned', score: 700, inquiries: [], publicRecords: [],
      tradelines: [...primeTrades().slice(1, 7), chargeOff('COMENITY CAPITAL BANK', '2019-04-01', 1240, '2023-08-31', null)],
    },
  },
  P18: all({
    status: 'FileReturned', score: 650, publicRecords: [], inquiries: [inquiry('CAPITAL ONE', '2025-11-03')],
    tradelines: [
      chargeOff('CREDIT ONE BANK', '2017-02-01', 1150, '2020-03-31', '2022-06-15'),
      chargeOff('SYNCHRONY BANK', '2016-10-01', 2300, '2020-05-31', '2022-11-30'),
      card('CAPITAL ONE PLATINUM', '2021-04-11', 1500, 280),
      card('DISCOVER IT SECURED', '2021-01-20', 1000, 120, { termsDescription: 'Secured' }),
      installment('CARMAX AUTO FINANCE', '2023-02-10', 17000, 9800, 365, 'Automobile'),
    ],
  }),
  P19: clean(770),
  P20: all({
    status: 'FileReturned', score: null, noScore: 'ScoringNotAvailable', publicRecords: [], inquiries: [],
    tradelines: [
      closed(mortgage('WASHINGTON MUTUAL', '1978-06-01', 92000, 0, 0), '2008-06-01'),
      closed(card('SEARS', '1971-04-01', 2500, 0), '2014-02-01'),
      closed(card('AMERICAN EXPRESS', '1983-09-01', 15000, 0), '2018-07-01'),
      closed(installment('GMAC', '2004-03-01', 21000, 0, 0, 'Automobile'), '2009-03-01'),
      closed(card('BANK OF AMERICA', '1990-11-01', 10000, 0), '2019-05-01'),
    ].map((t) => ({ ...t, accountReportedDate: '2019-05-31', lastActivityDate: '2019-05-01' })),
  }),
};

// Per bureau quirk from the dataset: P20 Experian carries a different no-score reason.
const NO_SCORE_OVERRIDE = { 'P20.experian': 'NotScoredNoRecentAccountInformation' };

const FRAUD = {
  P01: { score: 11, emailSince: '2014-03-02' }, P02: { score: 9, emailSince: '2009-07-19' },
  P03: { score: 14, emailSince: '2023-09-14', longevity: 2 }, P04: { score: 18, emailSince: '2025-10-03', longevity: 1 },
  P05: { score: 52, emailSince: '2019-01-08', tumbling: 1, velocity: 7 }, P06: { score: 12, emailSince: '2011-05-30' },
  P07: { score: 12, emailSince: '2010-02-17' }, P08: { score: 10, emailSince: '2012-12-01' }, P09: { score: 11, emailSince: '2015-04-22' },
  P10: { score: 10, emailSince: '2013-08-09' }, P11: { score: 11, emailSince: '2016-06-30' },
  P12: { score: 85, emailSince: '2024-02-11', longevity: 1, phoneOwner: 'no_match', ipDistance: '> 1000 miles', postalOwner: 'no_match' },
  P13: { score: 88, emailSince: '2026-10-17', longevity: 0, velocity: 9, tumbling: 2, phoneOwner: 'no_match', lineType: 'voip', prepaid: true, ipDistance: '500-1000 miles', postalOwner: 'no_match' },
  P14: { score: 80, emailSince: '2008-01-12', emailStatus: 'invalid', phoneStatus: 'dead' },
  P15: { score: 10, emailSince: '2012-03-03' }, P16: { score: 50, emailSince: '2018-10-10', velocity: 6, tumbling: 1 },
  P17: { score: 11, emailSince: '2014-11-11' }, P18: { score: 12, emailSince: '2017-02-02' }, P19: { score: 9, emailSince: '2010-09-09' },
  P20: { score: 8, emailSince: '2006-05-05', lineType: 'landline' },
};

const IDENTITY = {
  P12: [
    { code: '2201', text: 'SSN issued to a different name; DOB mismatch' },
    { code: '2101', text: 'Address not associated with SSN' },
  ],
  P13: [
    { code: '2202', text: 'SSN issue date inconsistent with DOB' },
    { code: '2201', text: 'Multiple names linked to SSN' },
  ],
  P14: [{ code: '2301', text: 'SSN reported as belonging to a deceased person (Death Master File)' }],
  P16: [{ code: '2401', text: 'Fraud alert on file: basic verification passes but step-up is required (KBA questions, then OTP to phone on file)' }],
};

const BLJ = {
  P06: { bankruptcies: [{ Chapter: '7', CaseNumber: '2:23-bk-50411', CourtName: 'US BANKRUPTCY COURT SOUTHERN DISTRICT OF OHIO', FilingDate: '2023-02-14', Status: 'Discharged', StatusDate: '2024-01-22', DischargeDate: '2024-01-22' }] },
  P07: { bankruptcies: [{ Chapter: '13', CaseNumber: '25-52187', CourtName: 'US BANKRUPTCY COURT NORTHERN DISTRICT OF GEORGIA', FilingDate: '2025-03-10', Status: 'Open', StatusDate: '2025-03-10' }] },
  P08: {
    judgments: [{ CaseNumber: '2024-M1-118842', CourtName: 'CIRCUIT COURT OF COOK COUNTY', FilingDate: '2024-06-18', Amount: '12300.00', Plaintiff: 'LAKEVIEW RENOVATION CONTRACTORS INC', Status: 'Unsatisfied' }],
    liens: [{ LienType: 'State Tax Lien', CaseNumber: 'IL-TL-2025-004417', CourtName: 'COOK COUNTY RECORDER OF DEEDS', FilingDate: '2025-02-03', Amount: '7450.00', Creditor: 'ILLINOIS DEPARTMENT OF REVENUE', Status: 'Unreleased' }],
  },
  P11: { judgments: [{ CaseNumber: '37-2024-00006121-CL-UD-CTL', CourtName: 'SUPERIOR COURT OF CALIFORNIA, COUNTY OF SAN DIEGO', FilingDate: '2024-02-12', JudgmentDate: '2024-04-19', Amount: '4850.00', Plaintiff: 'HIGHLAND PARK APARTMENTS LLC', Status: 'Unsatisfied' }] },
};

const CRIMINAL = {
  P09: [{ jurisdiction: 'DENVER COUNTY', state: 'CO', caseNumber: '20CR06211', offense: { caseType: 'FELONY', description: 'BURGLARY - 2ND DEGREE', statute: 'CRS 18-4-203', offenseDate: '2020-11-07', filingDate: '2020-11-16', disposition: 'CONVICTED', dispositionDate: '2021-06-04', convictionDate: '2021-06-04', court: 'DENVER DISTRICT COURT', sentenceLength: '4 YEARS PROBATION', status: 'CLOSED' } }],
  P10: [{ jurisdiction: 'WAYNE COUNTY', state: 'MI', caseNumber: '14-003318-SM', offense: { caseType: 'MISDEMEANOR', description: 'DISORDERLY CONDUCT', statute: 'MCL 750.167', offenseDate: '2014-07-04', filingDate: '2014-07-07', disposition: 'DISMISSED', dispositionDate: '2014-09-15', court: '36TH DISTRICT COURT', status: 'CLOSED' } }],
};

const EVICTION = {
  P11: [
    { court: 'SUPERIOR COURT OF CALIFORNIA, COUNTY OF SAN DIEGO', agencyState: 'CA', agencyCounty: 'SAN DIEGO', filingDate: '2022-03-08', caseNo: '37-2022-00009034-CL-UD-CTL', plaintiff: 'BAYVIEW TERRACE LP', noticeType: 'UNLAWFUL DETAINER', judgement: 'DISMISSED', dismissalDate: '2022-05-02' },
    { court: 'SUPERIOR COURT OF CALIFORNIA, COUNTY OF SAN DIEGO', agencyState: 'CA', agencyCounty: 'SAN DIEGO', filingDate: '2024-02-12', caseNo: '37-2024-00006121-CL-UD-CTL', plaintiff: 'HIGHLAND PARK APARTMENTS LLC', noticeType: 'UNLAWFUL DETAINER', judgement: 'JUDGMENT FOR PLAINTIFF', judgementFor: 'PLAINTIFF', judgementDate: '2024-04-19', judgementAmount: '4850.00' },
  ],
};

// ---------- response builders ----------
const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

function creditReport(row, bureau) {
  const spec = CREDIT[row.personaId][bureau];
  const body = row.body;
  const base = {
    requestData: { firstName: body.firstName, lastName: body.lastName, ssn: `XXXXX${body.ssn.slice(-4)}`, addresses: body.addresses },
    repositoryIncluded: { transunion: bureau === 'transunion', transunionConfig: bureau === 'transunion' ? row.config : null, equifax: bureau === 'equifax', equifaxConfig: bureau === 'equifax' ? row.config : null, experian: bureau === 'experian', experianConfig: bureau === 'experian' ? row.config : null },
    responseDetail: { dateOrdered: ORDERED, dateRequested: ORDERED, referenceNumber: `fx-${row.personaId}-${SHORT[bureau]}`, creditPullType: 'Soft' },
    responseAlertMessages: [],
    errorMessages: null,
    creditFiles: [],
    inquiries: [],
    tradelines: [],
    publicRecords: [],
    scores: [],
    summaries: null,
  };
  if (spec.status === 'deceased') {
    return {
      ...base,
      creditFiles: null,
      errorMessages: [{ creditErrorMessageCode: 'DECEASED', creditErrorMessageSourceType: SRC[bureau], creditErrorMessageText: 'Subject is reported as deceased. No credit file returned.' }],
    };
  }
  const fileDetail = { borrowerSourceType: 'Borrower', creditFileResultStatusType: spec.status, sourceType: SRC[bureau] };
  if (spec.status !== 'FileReturned') {
    return { ...base, creditFiles: [{ creditFileDetail: fileDetail }] };
  }
  const src = (x) => ({ ...x, sourceType: SRC[bureau] });
  const tradelines = spec.tradelines.map(src);
  const name = bureau === 'equifax' ? [] : [{ firstName: body.firstName, lastName: body.lastName }];
  const noScore = NO_SCORE_OVERRIDE[`${row.personaId}.${bureau}`] ?? spec.noScore;
  const score = {
    borrowerSourceType: 'Borrower', modelName: MODEL[bureau], sourceType: SRC[bureau], createdDate: AS_OF,
    scoreValue: spec.score == null ? null : String(spec.score), scoreMinimumValue: '300', scoreMaximumValue: '850',
    ...(noScore ? { noScoreReasonType: noScore, noScoreReasonTypeDescription: noScore === 'ScoringNotAvailable' ? 'Scoring not available' : 'No recent account information' } : {}),
    scoreFactors: spec.score == null ? [] : scoreFactors(spec, tradelines),
  };
  const n = (f) => tradelines.filter(f).length;
  const sum = (f, k) => tradelines.filter(f).reduce((a, t) => a + Number(t[k] ?? 0), 0);
  const open = (t) => t.accountStatusType === 'Open';
  const revolving = (t) => t.accountType === 'Revolving';
  const revBal = sum((t) => open(t) && revolving(t), 'currentBalanceAmount');
  const revLim = sum((t) => open(t) && revolving(t), 'creditLimitAmount');
  return {
    ...base,
    creditFiles: [{
      creditFileDetail: { ...fileDetail, creditFileInfileDate: tradelines.map((t) => t.accountOpenedDate).sort()[0] ?? AS_OF },
      aliases: name,
      ssns: [{ ssn: `XXXXX${body.ssn.slice(-4)}` }],
      dobs: [],
      addresses: body.addresses.map((a) => ({ ...a, dateReported: '2026-09-30' })),
      employments: [],
    }],
    tradelines,
    inquiries: spec.inquiries.map(src),
    publicRecords: spec.publicRecords.map(src),
    scores: [score],
    summaries: {
      tradeSummary: {
        tradesCount: String(tradelines.length), openTradesCount: String(n(open)), revolvingTradesCount: String(n(revolving)),
        mortgageTradesCount: String(n((t) => t.accountType === 'Mortgage')), installmentTradesCount: String(n((t) => t.accountType === 'Installment')),
        balanceTotal: String(sum(() => true, 'currentBalanceAmount')), revolvingBalanceTotal: String(revBal), revolvingHighCreditTotal: String(revLim),
        revolvingCreditUtilization: revLim ? String(Math.round((revBal / revLim) * 100)) : '0',
        pastDueTotal: String(sum(() => true, 'pastDueAmount')),
        oldestTradelineDate: tradelines.map((t) => t.accountOpenedDate).sort()[0] ?? null,
      },
      derogatorySummary: {
        chargeOffsCount: String(n((t) => t.currentRatingType === 'ChargeOff')),
        collectionsCount: String(n((t) => t.currentRatingType === 'Collection')),
        bankruptciesCount: String(spec.publicRecords.filter((p) => p.publicRecordType.startsWith('Bankruptcy')).length),
        publicRecordsCount: String(spec.publicRecords.length),
        _30DayLates: String(sum(() => true, '_30DayLates')), _60DayLates: String(sum(() => true, '_60DayLates')), _90DayLates: String(sum(() => true, '_90DayLates')),
        inquiriesCount: String(spec.inquiries.length),
        currentAdverseTradelineCount: String(n((t) => t.derogatoryDataIndicator && Number(t.currentBalanceAmount) > 0)),
        priorAdverseTradelineCount: String(n((t) => t.derogatoryDataIndicator && Number(t.currentBalanceAmount) === 0)),
      },
    },
  };
}

function scoreFactors(spec, tradelines) {
  const f = [];
  if (spec.publicRecords.length) f.push({ scoreFactorCode: '84', scoreFactorText: 'Public record or collection on file' });
  if (tradelines.some((t) => t.currentRatingType === 'Collection')) f.push({ scoreFactorCode: '04', scoreFactorText: 'Number of accounts in collection' });
  if (tradelines.some((t) => Number(t._90DayLates) > 0 || Number(t._30DayLates) > 0)) f.push({ scoreFactorCode: '18', scoreFactorText: 'Number of accounts with delinquency' });
  if (tradelines.length < 3) f.push({ scoreFactorCode: '20', scoreFactorText: 'Length of time accounts have been established' });
  if (spec.inquiries.length > 3) f.push({ scoreFactorCode: '08', scoreFactorText: 'Too many inquiries last 12 months' });
  if (!f.length) f.push({ scoreFactorCode: '14', scoreFactorText: 'Length of time accounts have been established' });
  return f.slice(0, 4);
}

function identity(row) {
  const b = row.body;
  const messages = IDENTITY[row.personaId] ?? [];
  const [num, ...rest] = b.street1.split(' ');
  return {
    fileNumber: '01',
    consumerID: `fx-${row.personaId}-tuid`,
    fileSummary: { fileHitIndicator: row.personaId === 'P04' || row.personaId === 'P12' ? 'noHit' : 'regularHit', ssnMatchIndicator: messages.some((m) => m.code === '2201') ? 'noMatch' : 'exact', consumerStatementIndicator: false, creditDataStatus: { suppressed: false, doNotPromote: false, freeze: row.personaId === 'P15', minor: false, disputed: false } },
    indicative: {
      name: [{ person: { first: b.firstName, last: b.lastName } }],
      address: [{ status: 'current', street: { number: num, name: rest.join(' ') }, location: { city: b.city, state: b.state, zipCode: b.zip } }],
      socialSecurity: { number: `XXXXX${b.ssn.slice(-4)}` },
      dateOfBirth: b.dob,
    },
    originalInputs: { ...b, ssn: `XXXXX${b.ssn.slice(-4)}` },
    addOnProducts: [{ code: '07030', status: 'defaultDelivered', idManagerVerification: { messages } }],
  };
}

function fraud(row) {
  const s = FRAUD[row.personaId];
  const b = row.body;
  const since = s.emailSince;
  return {
    eam: { date_first_seen: since, longevity: s.longevity ?? 3, velocity: s.velocity ?? 2, popularity: s.longevity === 0 ? 0 : 6 },
    dam: { date_first_seen: '1995-08-13', longevity: 3, velocity: 10, popularity: 10 },
    risk: {
      score: s.score,
      tumbling_risk: s.tumbling ?? 0,
      query_id: `fx-${row.personaId}-fraud_finder`,
      domain: { domain_risk_score: s.score >= 70 ? 6 : 1 },
      ip: { routing_type: s.ipDistance ? 'international proxy' : 'fixed', organization: s.ipDistance ? 'HOSTING PROVIDER' : 'RESIDENTIAL ISP', proxy_type: s.ipDistance ? 'web' : '', hosting_facility: Boolean(s.ipDistance), latitude: '0', longitude: '0' },
      postal: {
        first_name_match: s.postalOwner ?? 'match', last_name_match: s.postalOwner ?? 'match', street_match: s.postalOwner ?? 'match', city_match: 'match', zip_match: 'match',
        address_type: 'Street', deliverability: 'deliverable', deliverability_substatus: 'deliverable', ip_postal_distance: s.ipDistance ?? '< 5 miles',
      },
      phone: {
        line_type: s.lineType ?? 'mobile', carrier: s.lineType === 'voip' ? 'BANDWIDTH.COM' : s.lineType === 'landline' ? 'FRONTIER' : 'VERIZON WIRELESS',
        status: s.phoneStatus ?? 'live', prepaid: Boolean(s.prepaid),
        owner: { first_name_match: s.phoneOwner ?? 'match', last_name_match: s.phoneOwner ?? 'match', street_match: s.phoneOwner ?? 'match', city_match: s.phoneOwner ?? 'match', zip_match: s.phoneOwner ?? 'match', type: 'person' },
      },
    },
    email_validation: { address: b.email, status: s.emailStatus ?? 'valid', status_code: s.emailStatus === 'invalid' ? 10 : 50, domain_type: 'freeisp', role_account: false },
  };
}

function pitchpoint(row) {
  const p = row.body.terms.term[0].person;
  const r = BLJ[row.personaId] ?? {};
  const one = (arr, key) => (!arr?.length ? null : { [key]: arr.length === 1 ? arr[0] : arr }); // XML-derived: single element is an object
  return {
    TransactionID: `fx-${row.personaId}-pitchpoint_blj`,
    Status: { Code: 'S000', Description: 'Success' },
    Report: {
      Subject: { FirstName: p.firstName, LastName: p.lastName, SSN: `XXXXX${p.ssn.slice(-4)}` },
      Summary: { BankruptciesFound: String(r.bankruptcies?.length ?? 0), JudgmentsFound: String(r.judgments?.length ?? 0), LiensFound: String(r.liens?.length ?? 0) },
      Bankruptcies: one(r.bankruptcies, 'Bankruptcy'),
      Judgments: one(r.judgments, 'Judgment'),
      Liens: one(r.liens, 'Lien'),
    },
  };
}

function criminal(row) {
  const s = row.body.subjectInfo;
  const recs = CRIMINAL[row.personaId] ?? [];
  const candidate = recs.map((r) => ({
    firstName: s.first, lastName: s.last, state: r.state, zipCode: s.zip, zone: r.state,
    subject: { fullName: `${s.last}, ${s.first}`, dob: s.dob, caseNumber: r.caseNumber, jurisdiction: r.jurisdiction, state: r.state, category: 'CRIMINAL', source: `${r.jurisdiction} COURT RECORDS` },
    offenses: { count: '1', offense: [r.offense] },
  }));
  return {
    orderResponse: { message: 'Request Results', reference: null, responseID: `fx-${row.personaId}-cic-crim`, name: `${s.first} ${s.last}`, disclaimer: 'Synthesized sandbox fixture. Records must be verified before any adverse action.', status: null },
    cicCriminal: { candidates: { count: candidate.length, message: candidate.length ? 'Records Found' : 'No Records Found' }, errorCode: null, errorMessage: null },
    response: { notice: null, count: candidate.length, countWest4: 0, countNational1: candidate.length, candidate },
  };
}

function eviction(row) {
  const s = row.body.subjectInfo;
  const acts = EVICTION[row.personaId] ?? [];
  const candidate = acts.map((activity) => ({ firstName: s.first, lastName: s.last, zipCode: s.zip, state: activity.agencyState, subject: { fullName: `${s.last}, ${s.first}`, dob: s.dob, caseNumber: activity.caseNo }, activity }));
  return {
    orderResponse: { message: 'Request Processed Successfully', reference: null, responseID: `fx-${row.personaId}-cic-evct`, name: `${s.first} ${s.last}`, disclaimer: 'Synthesized sandbox fixture.', status: null },
    response: { notice: null, count: candidate.length, countWest4: 0, countNational1: candidate.length, candidate },
  };
}

function accurateAppend(row, idRow) {
  const pid = row.personaId;
  let records = [];
  if (pid === 'P12') records = [{ firstName: 'RAJESH', lastName: 'MENON', houseNo: '1120', streetName: 'OAK TREE RD', address: '1120 OAK TREE RD', city: 'EDISON', state: 'NJ', postalCode: '08820' }];
  else if (pid !== 'P04' && pid !== 'P13' && idRow) {
    const b = idRow.body;
    const [houseNo, ...rest] = b.street1.split(' ');
    records = [{ firstName: b.firstName, lastName: b.lastName, houseNo, streetName: rest.join(' '), address: b.street1, city: b.city, state: b.state, postalCode: b.zip }];
  }
  return { success: true, message: 'Unified reverse completed successfully', data: { transactionId: `fx-${pid}-aa-reverse`, records } };
}

// ---------- write ----------
const rows = loadDataset().filter((r) => r.source === 'persona');
const out = fixturesDir();
let count = 0;
for (const row of rows) {
  const bureau = bureauOf(row);
  const idRow = rows.find((r) => r.personaId === row.personaId && r.product === 'tu_identity_verification');
  let body;
  switch (row.product) {
    case 'credit_report': body = creditReport(row, bureau); break;
    case 'tu_identity_verification': body = identity(row); break;
    case 'fraud_finder': body = fraud(row); break;
    case 'pitchpoint_blj': body = pitchpoint(row); break;
    case 'criminal': body = criminal(row); break;
    case 'eviction': body = eviction(row); break;
    case 'accurate_append': body = accurateAppend(row, idRow); break;
    default: throw new Error(`unknown product ${row.product}`);
  }
  const fx = {
    status: 200,
    requestId: `fx-${row.personaId}-${row.product}${bureau ? `-${SHORT[bureau]}` : ''}`,
    synthesized: true,
    endpoint: row.endpoint,
    expectedOutcome: row.expectedOutcome,
    body,
  };
  const dir = join(out, row.product);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${fixtureName(row)}.json`), JSON.stringify(fx, null, 2) + '\n');
  count++;
}
writeFileSync(
  join(out, '_meta.json'),
  JSON.stringify(
    {
      synthesized: true,
      asOf: AS_OF,
      count,
      layout: 'fixtures/crs/<product>/<personaId>.json; credit_report uses <personaId>.<bureau>.json',
      note:
        'These responses are synthesized from the documented sandbox outcomes (expected_outcome in crs-sandbox-dataset.csv and the CRS product guides), ' +
        'using the documented response shapes. Request ids are fake (fx-<persona>-<product>[-<bureau>]). They are not recordings. ' +
        'Once CRS credentials exist, refresh them with `pnpm -F @cafoo/crs-mcp fixtures:record`, which overwrites each file with the live body and RequestID (synthesized:false). ' +
        'Unconfirmed shapes: PitchPoint /pp/fcrablj/data keys (free-form XML-derived JSON), the deceased errorMessages code, TU identity SubjectRecord fields beyond addOnProducts[0].idManagerVerification.messages, score modelName strings.',
      generator: 'packages/crs-mcp/scripts/synthesize-fixtures.mjs',
    },
    null,
    2,
  ) + '\n',
);
console.log(`wrote ${count} fixtures to ${out}`);
