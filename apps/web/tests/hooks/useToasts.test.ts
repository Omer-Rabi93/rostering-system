import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useToasts } from '../../src/hooks/useToasts.js';

describe('useToasts', () => {
  it('pushes toasts with incrementing ids and preserves order', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.pushToast('success', 'Saved');
    });
    act(() => {
      result.current.pushToast('error', 'Failed');
    });

    expect(result.current.toasts).toEqual([
      { id: 1, variant: 'success', message: 'Saved' },
      { id: 2, variant: 'error', message: 'Failed' },
    ]);
  });

  it('dismisses only the toast with the matching id', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.pushToast('success', 'First');
    });
    act(() => {
      result.current.pushToast('warning', 'Second');
    });
    act(() => {
      result.current.dismissToast(1);
    });

    expect(result.current.toasts).toEqual([{ id: 2, variant: 'warning', message: 'Second' }]);
  });
});
