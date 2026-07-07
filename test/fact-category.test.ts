import { describe, it, expect } from 'vitest';
import { FACT_CATEGORIES, isFactCategory, normalizeFactCategory } from '../src/fact-category.js';

describe('normalizeFactCategory', () => {
  it('passes every valid category through unchanged', () => {
    for (const c of FACT_CATEGORIES) {
      expect(normalizeFactCategory(c)).toBe(c);
    }
  });

  it('is case/whitespace-insensitive for valid values', () => {
    expect(normalizeFactCategory(' Decision ')).toBe('decision');
    expect(normalizeFactCategory('CONSTRAINT')).toBe('constraint');
  });

  it("maps 'requirement(s)' to 'constraint'", () => {
    expect(normalizeFactCategory('requirement')).toBe('constraint');
    expect(normalizeFactCategory('Requirements')).toBe('constraint');
  });

  it('resolves enum echoes to the first valid token', () => {
    expect(normalizeFactCategory('decision|preference|pattern|knowledge|constraint')).toBe('decision');
    expect(normalizeFactCategory('bogus|constraint')).toBe('constraint');
  });

  it('falls back to knowledge for everything else', () => {
    expect(normalizeFactCategory('null')).toBe('knowledge');
    expect(normalizeFactCategory(null)).toBe('knowledge');
    expect(normalizeFactCategory(undefined)).toBe('knowledge');
    expect(normalizeFactCategory('')).toBe('knowledge');
    expect(normalizeFactCategory('architecture')).toBe('knowledge');
    expect(normalizeFactCategory(42)).toBe('knowledge');
    expect(normalizeFactCategory('foo|bar')).toBe('knowledge');
  });
});

describe('isFactCategory', () => {
  it('accepts only exact vocabulary members', () => {
    expect(isFactCategory('decision')).toBe(true);
    expect(isFactCategory('Decision')).toBe(false);
    expect(isFactCategory('requirement')).toBe(false);
    expect(isFactCategory(null)).toBe(false);
  });
});
