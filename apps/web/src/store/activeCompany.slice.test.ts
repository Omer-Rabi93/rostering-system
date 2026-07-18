import { afterEach, describe, expect, it } from 'vitest';

import {
  activeCompanyReducer,
  companyCleared,
  companySelected,
  readPersistedCompanyId,
  selectActiveCompanyId,
  writePersistedCompanyId,
} from './activeCompany.slice.js';
import type { RootState } from './index.js';

const STORAGE_KEY = 'rostering.activeCompanyId';

afterEach(() => {
  localStorage.clear();
});

describe('activeCompany slice', () => {
  it('starts with no active company (nothing persisted at module load)', () => {
    const state = activeCompanyReducer(undefined, { type: '@@INIT' });
    expect(state.activeCompanyId).toBeNull();
  });

  it('companySelected sets the active company id', () => {
    const state = activeCompanyReducer(undefined, companySelected(7));
    expect(selectActiveCompanyId({ activeCompany: state } as RootState)).toBe(7);
  });

  it('companyCleared resets to no active company', () => {
    const selected = activeCompanyReducer(undefined, companySelected(7));
    const cleared = activeCompanyReducer(selected, companyCleared());
    expect(selectActiveCompanyId({ activeCompany: cleared } as RootState)).toBeNull();
  });

  it('selecting a different company replaces the previous one', () => {
    let state = activeCompanyReducer(undefined, companySelected(1));
    state = activeCompanyReducer(state, companySelected(2));
    expect(selectActiveCompanyId({ activeCompany: state } as RootState)).toBe(2);
  });
});

describe('readPersistedCompanyId', () => {
  it('returns null when nothing is persisted', () => {
    expect(readPersistedCompanyId()).toBeNull();
  });

  it('returns the persisted id when a valid value is stored', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(42));
    expect(readPersistedCompanyId()).toBe(42);
  });

  it('treats a corrupt (non-JSON) value as unset rather than throwing', () => {
    localStorage.setItem(STORAGE_KEY, 'not-json{{{');
    expect(() => readPersistedCompanyId()).not.toThrow();
    expect(readPersistedCompanyId()).toBeNull();
  });

  it('treats a JSON value that is not a positive integer as unset', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify('not-a-number'));
    expect(readPersistedCompanyId()).toBeNull();

    localStorage.setItem(STORAGE_KEY, JSON.stringify(-3));
    expect(readPersistedCompanyId()).toBeNull();

    localStorage.setItem(STORAGE_KEY, JSON.stringify(0));
    expect(readPersistedCompanyId()).toBeNull();

    localStorage.setItem(STORAGE_KEY, JSON.stringify(1.5));
    expect(readPersistedCompanyId()).toBeNull();

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: 1 }));
    expect(readPersistedCompanyId()).toBeNull();
  });
});

describe('writePersistedCompanyId', () => {
  it('writes a value that readPersistedCompanyId reads back', () => {
    writePersistedCompanyId(9);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('9');
    expect(readPersistedCompanyId()).toBe(9);
  });

  it('removes the key when given null', () => {
    writePersistedCompanyId(9);
    writePersistedCompanyId(null);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(readPersistedCompanyId()).toBeNull();
  });
});
