import { describe, expect, it } from 'vitest';
import type { AIModelConfig } from '../types';
import { COMPARISON_USAGE, MODEL_BILLING_KEY, compareModelCosts, estimateModelCost, getModelBilling, isModelBillingCurrent, modelBillingBinding, updateModelBilling, withModelBilling } from './modelBilling';
import { preserveModelAnnotations } from './modelTags';

const base = (id = 'one'): AIModelConfig => ({
  id, provider: 'openai', base_url: 'https://provider.test/v1', name: 'Provider', model_name: 'same-model',
  category: 'text', capabilities: ['text_chat'], enabled: true,
});
const priced = (input: number, output: number, id = 'one') => {
  const model = base(id);
  return withModelBilling(model, {
    version: 1, kind: 'api', currency: 'CNY', input, output,
    binding: modelBillingBinding(model), source: 'Account quote', account: 'Work', updatedAt: '2026-10-16T00:00:00Z',
  });
};

describe('configured-channel billing annotations', () => {
  it('leaves legacy models and malformed/newer annotations unknown, without altering the record', () => {
    const legacy = base();
    expect(estimateModelCost(legacy, COMPARISON_USAGE)).toBeUndefined();
    const future = { ...legacy, metadata: { [MODEL_BILLING_KEY]: { version: 2, future: 'kept' } } };
    expect(getModelBilling(future)).toBeUndefined();
    expect(JSON.parse(JSON.stringify(future))).toEqual(future);
    const bad = priced(1, 2);
    bad.metadata![MODEL_BILLING_KEY].input = -1;
    expect(getModelBilling(bad)).toBeUndefined();
  });

  it('compares the same workload for two configured channels, not model names', () => {
    expect(compareModelCosts(priced(1, 2), priced(3, 4, 'two')).status).toBe('fastHigher');
    expect(compareModelCosts(priced(3, 4), priced(1, 2, 'two')).status).toBe('comparable');
    expect(estimateModelCost(priced(1, 2), COMPARISON_USAGE)).toBeCloseTo(0.014);
  });

  it('counts cached input once and requires the cache price only when applicable', () => {
    const m = priced(2, 4);
    expect(estimateModelCost(m, { input: 10000, output: 2000, cachedInput: 5000 })).toBeUndefined();
    m.metadata![MODEL_BILLING_KEY].cacheRead = 0.2;
    expect(estimateModelCost(m, { input: 10000, output: 2000, cachedInput: 5000 })).toBeCloseTo(0.019);
    expect(estimateModelCost(m, { input: 1, output: 0, cachedInput: 2 })).toBeUndefined();
    expect(estimateModelCost(m, { input: NaN, output: 0, cachedInput: 0 })).toBeUndefined();
  });

  it('distinguishes unknown rates, explicit zero, plans and currencies', () => {
    const free = priced(0, 0);
    expect(estimateModelCost(free, COMPARISON_USAGE)).toBe(0);
    delete free.metadata![MODEL_BILLING_KEY].input;
    expect(estimateModelCost(free, COMPARISON_USAGE)).toBeUndefined();
    const plan = priced(1, 2);
    plan.metadata![MODEL_BILLING_KEY].kind = 'subscription';
    expect(compareModelCosts(plan, priced(2, 3)).status).toBe('unknown');
    const usd = priced(1, 2, 'usd');
    usd.metadata![MODEL_BILLING_KEY].currency = 'USD';
    expect(compareModelCosts(usd, priced(1, 2)).status).toBe('currency');
  });

  it('does not infer billing from API keys or a subscription login', () => {
    const m = { ...base(), auth: { type: 'subscription', provider: 'opencode', plan: 'zen' } } as AIModelConfig;
    expect(getModelBilling(m)).toBeUndefined();
    expect(compareModelCosts(m, base('second')).status).toBe('unknown');
  });

  it('invalidates a changed endpoint, model, auth or credential while preserving the quote', () => {
    const m = priced(1, 2);
    for (const change of [{ base_url: 'https://other.test' }, { model_name: 'new-model' }, { api_key: 'rotated' }]) {
      const next = preserveModelAnnotations(m, { ...m, ...change });
      expect(getModelBilling(next)?.needsReview).toBe(true);
      expect(estimateModelCost(next, COMPARISON_USAGE)).toBeUndefined();
      expect(getModelBilling(next)?.input).toBe(1);
    }
    expect(isModelBillingCurrent({ ...m, base_url: 'https://other.test' })).toBe(false);
    m.api_key = 'secret-credential';
    expect(JSON.stringify(getModelBilling(m))).not.toContain('secret-credential');
  });

  it('preserves latest per-model billing during group edits and never copies it to a new model', () => {
    const one = priced(1, 2);
    const two = priced(5, 6, 'two');
    const next = preserveModelAnnotations(two, { ...two, metadata: one.metadata });
    expect(getModelBilling(next)?.input).toBe(5);
    expect(getModelBilling(preserveModelAnnotations(undefined, { ...one, id: 'new' }))).toBeUndefined();
  });

  it('saves into the latest host snapshot and rejects concurrent changes or removal', () => {
    const m = priced(1, 2);
    const quote = { ...getModelBilling(m)!, input: 3 };
    const withTag = { ...m, metadata: { ...m.metadata, user_tags: ['keep'] } };
    const updated = updateModelBilling([withTag, base('other')], m, quote);
    expect(updated[0].metadata?.user_tags).toEqual(['keep']);
    expect(getModelBilling(JSON.parse(JSON.stringify(updated[0])))?.input).toBe(3);
    expect(() => updateModelBilling([], m, quote)).toThrow();
    expect(() => updateModelBilling([{ ...m, api_key: 'changed' }], m, quote)).toThrow();
    expect(() => updateModelBilling([priced(7, 8)], m, quote)).toThrow();
  });
});
