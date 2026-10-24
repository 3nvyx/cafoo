import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixturesDir } from '../src/paths.js';
import { interpretAppend, interpretCreditReport, interpretFraud, interpretIdentity, interpretPublicRecords } from '../src/interpret.js';

const fx = (product: string, name: string): unknown => JSON.parse(readFileSync(join(fixturesDir(), product, `${name}.json`), 'utf8')).body;

describe('interpretCreditReport', () => {
  it('reads a clean prime file', () => {
    const f = interpretCreditReport(fx('credit_report', 'P01.transunion'));
    expect(f).toMatchObject({ bureau: 'transunion', fileStatus: 'returned', score: 790, scoreModel: 'TransUnionVantageScore4.0', derogatories: 0, publicRecords: [] });
  });
  it('maps no-hit, freeze and deceased (all HTTP 200)', () => {
    expect(interpretCreditReport(fx('credit_report', 'P04.equifax')).fileStatus).toBe('no_hit');
    expect(interpretCreditReport(fx('credit_report', 'P15.transunion')).fileStatus).toBe('frozen');
    expect(interpretCreditReport(fx('credit_report', 'P14.experian'))).toMatchObject({ fileStatus: 'deceased', score: null });
  });
  it('reads no-score, collections and bankruptcy records', () => {
    expect(interpretCreditReport(fx('credit_report', 'P20.transunion'))).toMatchObject({ score: null, noScoreReason: 'ScoringNotAvailable' });
    expect(interpretCreditReport(fx('credit_report', 'P05.experian'))).toMatchObject({ score: 540, collections: 2, activeDerogatories: 3, late90: 1 });
    expect(interpretCreditReport(fx('credit_report', 'P06.equifax')).publicRecords).toEqual([
      { type: 'BankruptcyChapter7', status: 'Discharged', date: '2023-02-14', amount: null, open: false },
    ]);
    expect(interpretCreditReport(fx('credit_report', 'P18.transunion'))).toMatchObject({ chargeOffs: 2, activeDerogatories: 0 });
  });
  it('tolerates garbage', () => {
    expect(interpretCreditReport(null).fileStatus).toBe('error');
  });
});

describe('interpretIdentity', () => {
  it('maps PASS, FAIL and KBA_REQUIRED', () => {
    expect(interpretIdentity(fx('tu_identity_verification', 'P01')).result).toBe('PASS');
    expect(interpretIdentity(fx('tu_identity_verification', 'P12'))).toMatchObject({ result: 'FAIL', codes: ['2201', '2101'] });
    expect(interpretIdentity(fx('tu_identity_verification', 'P14'))).toMatchObject({ result: 'FAIL', deceased: true });
    expect(interpretIdentity(fx('tu_identity_verification', 'P13'))).toMatchObject({ result: 'FAIL', synthetic: true });
    expect(interpretIdentity(fx('tu_identity_verification', 'P16'))).toMatchObject({ result: 'KBA_REQUIRED', codes: ['2401'] });
  });
});

describe('interpretFraud', () => {
  it('levels and signals', () => {
    expect(interpretFraud(fx('fraud_finder', 'P01'))).toMatchObject({ score: 11, level: 'low', signals: [] });
    expect(interpretFraud(fx('fraud_finder', 'P05')).level).toBe('medium');
    const p13 = interpretFraud(fx('fraud_finder', 'P13'), new Date('2026-10-20'));
    expect(p13.level).toBe('high');
    expect(p13.signals).toEqual(expect.arrayContaining(['email first seen 3 days ago', 'phone owner does not match applicant', 'VoIP phone', 'prepaid phone']));
  });
});

describe('interpretPublicRecords', () => {
  it('reads PitchPoint single-object elements', () => {
    const r = interpretPublicRecords(fx('pitchpoint_blj', 'P08'));
    expect(r.counts).toEqual({ bankruptcies: 0, judgments: 1, liens: 1 });
    expect(r.judgments[0]).toMatchObject({ amount: 12300, satisfied: false });
    expect(r.liens[0]).toMatchObject({ type: 'State Tax Lien', amount: 7450, released: false });
    expect(interpretPublicRecords(fx('pitchpoint_blj', 'P07')).bankruptcies[0]).toMatchObject({ chapter: '13', open: true });
    expect(interpretPublicRecords(fx('pitchpoint_blj', 'P06')).bankruptcies[0]).toMatchObject({ chapter: '7', open: false });
  });
  it('reads criminal and eviction candidates', () => {
    const p09 = interpretPublicRecords(fx('pitchpoint_blj', 'P09'), fx('criminal', 'P09'), fx('eviction', 'P09'));
    expect(p09.criminal).toEqual([expect.objectContaining({ level: 'felony', convicted: true, date: '2021-06-04' })]);
    const p10 = interpretPublicRecords({}, fx('criminal', 'P10'));
    expect(p10.criminal[0]).toMatchObject({ level: 'misdemeanor', convicted: false });
    const p11 = interpretPublicRecords({}, undefined, fx('eviction', 'P11'));
    expect(p11.evictions.map((e) => e.outcome)).toEqual(['dismissed', 'judgment']);
  });
});

describe('interpretAppend', () => {
  it('flags a reverse lookup that returns someone else', () => {
    expect(interpretAppend(fx('accurate_append', 'P12'), 'ANAND').matchesSubject).toBe(false);
    expect(interpretAppend(fx('accurate_append', 'P01'), 'OKAFOR').matchesSubject).toBe(true);
    expect(interpretAppend(fx('accurate_append', 'P04'), 'LINDQVIST')).toEqual({ records: [], matchesSubject: null });
  });
});
