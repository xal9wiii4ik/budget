// The ONLY file importing RN AppState. Wraps the foreground-resume edge
// (background/inactive -> active) into the coordinator's injectable ResumeSubscribe
// seam (O5). Kept OUT of the vitest graph (S4/R5): the coordinator injects this;
// tests inject a fake that captures the handler.
import { AppState } from 'react-native';

import type { ResumeSubscribe } from './coordinator';

export const subscribeAppStateResume: ResumeSubscribe = (onResume) => {
  let previous = AppState.currentState;
  const subscription = AppState.addEventListener('change', (next) => {
    // Fire only on the transition INTO the foreground, not on every change.
    if ((previous === 'background' || previous === 'inactive') && next === 'active') {
      onResume();
    }
    previous = next;
  });
  return () => subscription.remove();
};
