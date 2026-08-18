import { register as authRegister, ApiError } from '@budget/api-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

import { authClient, coordinator } from '../lib/api';
import { RegisterLoginFailedError } from './errors';
import { meQueryKey } from './meQueryKey';

interface Credentials {
  email: string;
  password: string;
}

/** Reactive, synchronous auth gate for the route guard (token presence). */
export function useIsAuthenticated(): boolean {
  return useSyncExternalStore(
    coordinator.subscribe,
    coordinator.getSnapshot,
    coordinator.getSnapshot,
  );
}

/** Login mutation — pending/error state for the form; invalidates ['me'] on success. */
export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, password }: Credentials) => coordinator.login(email, password),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: meQueryKey });
    },
  });
}

/**
 * Register mutation. On 201 it auto-chains into login (mirrors web). If the login
 * leg fails after the account was created, it throws RegisterLoginFailedError so the
 * screen hands off to /login prefilled — it does NOT re-register.
 */
export function useRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ email, password }: Credentials) => {
      const result = await authRegister(authClient, email, password);
      if (result.error !== undefined || !result.response.ok || result.data === undefined) {
        throw new ApiError(result.response.status, result.error);
      }
      try {
        await coordinator.login(email, password);
      } catch (loginError) {
        throw new RegisterLoginFailedError(email, loginError);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: meQueryKey });
    },
  });
}

/** Logout mutation — revoke + clear; the guard reacts and the listener clears cache. */
export function useLogout() {
  return useMutation({
    mutationFn: () => coordinator.logout(),
  });
}
