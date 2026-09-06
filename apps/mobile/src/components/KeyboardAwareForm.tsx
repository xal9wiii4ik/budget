// Shared keyboard-aware form wrapper (plan Platform concerns): KeyboardAvoidingView
// (padding on iOS, height on Android) around a ScrollView with
// keyboardShouldPersistTaps='handled' so amount/note/password fields aren't covered
// and a tap on a button while the keyboard is open still registers. The bottom
// safe-area inset is the host screen's SafeAreaView's job, not this wrapper's.
//
// It also owns SCROLL-TO-FIRST-ERROR (defects N-2 / N-1, catch-up 3 line B); the
// rule and why it is driven from here rather than from each form is on
// `scrollToTopmostError` below.
import {
  createContext,
  use,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, spacing } from './theme';

/**
 * A node that can report where it is on screen — every `FieldError` registers
 * itself as one while it has a message to show.
 */
export interface MeasurableNode {
  measureInWindow: (
    callback: (x: number, y: number, width: number, height: number) => void,
  ) => void;
}

interface FormScrollValue {
  /**
   * Called by FieldError while it has a message; returns the unregister. A NEW
   * registration is what tells the wrapper an error just appeared — which is the
   * whole trigger, so no form has to remember to call anything on submit.
   */
  registerError: (node: MeasurableNode) => () => void;
}

// A FieldError outside any KeyboardAwareForm (a tab screen, a modal notice) must
// keep working, so the default is a no-op rather than a thrown "missing provider".
const FormScrollContext = createContext<FormScrollValue>({
  registerError: () => () => {},
});

/** The seam FieldError uses; nothing else should need it. */
export function useFormScroll(): FormScrollValue {
  return use(FormScrollContext);
}

interface KeyboardAwareFormProps {
  children: ReactNode;
  /**
   * D-4: the form's primary actions (Save, and Delete/Archive next to it),
   * rendered OUTSIDE the ScrollView but INSIDE the KeyboardAvoidingView.
   *
   * Inside the scroll content they sat at the very bottom of the tallest forms,
   * i.e. in the home-indicator gesture strip (Save at y 829 of 874 on the
   * transfer edit form), and they were only reachable after a scroll nobody
   * expects to need. Outside it they are pinned above that strip and
   * still lifted by the keyboard, because the avoiding view still wraps them.
   *
   * The footer pays NO safe-area inset of its own: every host screen already
   * wraps this in a SafeAreaView whose `edges` include 'bottom', so adding the
   * inset here would pay it twice and leave a dead band under Save.
   *
   * Optional: the non-form screens that use this wrapper have no such actions.
   */
  footer?: ReactNode;
  /** Escape hatch for a host that needs the scroll ref itself. */
  scrollRef?: RefObject<ScrollView | null>;
}

// How much of the form above the error stays visible once we scroll to it — an
// error pinned to the very top edge reads as if it belongs to nothing.
const ERROR_MARGIN = spacing.xl;
// A hair of the error's own height must be inside the viewport for it to count as
// "already visible"; a line clipped by the pinned footer is not.
const VISIBLE_SLACK = 24;

export function KeyboardAwareForm({ children, footer, scrollRef }: KeyboardAwareFormProps) {
  const insets = useSafeAreaInsets();
  const ownRef = useRef<ScrollView>(null);
  const ref = scrollRef ?? ownRef;
  // The scroll VIEWPORT's rect on screen. Measured off a plain View wrapped
  // around the ScrollView rather than off the ScrollView itself: RN's ScrollView
  // class does not expose the measure methods (they live on the nodes it wraps),
  // and this View has exactly the same rect.
  const frame = useRef<View>(null);
  // The live scroll offset, so a window measurement can be turned into a content
  // offset without measuring the content view (which the new architecture does
  // not hand out as a stable node).
  const offset = useRef(0);
  // Insertion order does not matter: we take the MINIMUM y, i.e. the error
  // closest to the top of the form, which is the one to bring into view first.
  const errors = useRef(new Set<MeasurableNode>()).current;
  // One scroll per frame, however many errors appear at once.
  const scheduled = useRef(false);

  /**
   * N-2 / N-1: with Save pinned to the footer, a long form is submitted from its
   * bottom while the failing field — or the form-level error, which always sits
   * at the very top — is above the viewport (measured y = −434 on the shipped
   * transaction form). The tap then looks like it did nothing.
   *
   * THE TRIGGER IS AN ERROR APPEARING, not a submit: a `setError` from a server
   * 422 lands the same way a resolver failure does, and neither form nor screen
   * has to remember to call anything. Deliberately NOT a copy of web's
   * `scrollIntoView` — there is no DOM node to scroll to, so the topmost error is
   * MEASURED against the wrapper's own window rect and turned into a content
   * offset with the live scroll position.
   *
   * An error that is ALREADY on screen is left alone: after the first submit
   * react-hook-form revalidates on change, and yanking the view while someone
   * types into the very field they are being told about is worse than the defect.
   */
  const scrollToTopmostError = useCallback(() => {
    if (scheduled.current) return;
    scheduled.current = true;
    // One frame, because the caller is the registration effect of an error that
    // has only just rendered; its siblings register in the same commit.
    requestAnimationFrame(() => {
      scheduled.current = false;
      const scroll = ref.current;
      const viewport = frame.current;
      if (!scroll || !viewport || errors.size === 0) return;
      viewport.measureInWindow((_x, formY, _width, formHeight) => {
        const nodes = [...errors];
        let pending = nodes.length;
        let topmost = Number.POSITIVE_INFINITY;
        for (const node of nodes) {
          node.measureInWindow((_nodeX, nodeY) => {
            topmost = Math.min(topmost, nodeY);
            pending -= 1;
            if (pending > 0 || !Number.isFinite(topmost)) return;
            const visible = topmost >= formY && topmost <= formY + formHeight - VISIBLE_SLACK;
            if (visible) return;
            const target = offset.current + (topmost - formY) - ERROR_MARGIN;
            scroll.scrollTo({ y: Math.max(0, target), animated: true });
          });
        }
      });
    });
  }, [errors, ref]);

  const registerError = useCallback(
    (node: MeasurableNode) => {
      errors.add(node);
      scrollToTopmostError();
      return () => {
        errors.delete(node);
      };
    },
    [errors, scrollToTopmostError],
  );

  const value = useMemo<FormScrollValue>(() => ({ registerError }), [registerError]);

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    offset.current = event.nativeEvent.contentOffset.y;
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <FormScrollContext value={value}>
        <View ref={frame} style={styles.flex}>
          <ScrollView
            ref={ref}
            style={styles.flex}
            contentContainerStyle={[
              styles.content,
              // With a pinned footer the scroll content only needs breathing room —
              // the footer below it is what sits against the screen's bottom edge.
              { paddingBottom: footer ? spacing.xl : insets.bottom + spacing.xl },
            ]}
            keyboardShouldPersistTaps="handled"
            onScroll={onScroll}
            // 16ms would be a bridge event per frame for a value only read when an
            // error appears; a coarse tick is plenty, and the drift is bounded by
            // how far a finger can scroll in a tenth of a second.
            scrollEventThrottle={100}
          >
            {children}
          </ScrollView>
        </View>
        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </FormScrollContext>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: spacing.lg,
    gap: spacing.lg,
  },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
  },
});
