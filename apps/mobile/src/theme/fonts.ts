// Inter on the phone: the SAME typeface as web, a different container. Native
// RN loads TTF/OTF, so web's `public/fonts/*.woff2` cannot be these files —
// these are the four static weights from @expo-google-fonts/inter (400/500/600/
// 700, the four the app writes). Licence: SIL Open Font License 1.1, shipped in
// node_modules/@expo-google-fonts/inter/LICENSE_FONT.
//
// Imported per WEIGHT rather than from the package root: the root module
// requires all 18 TTFs (incl. italics), which Metro would then bundle.
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold';
import * as Font from 'expo-font';

import { INTER_FAMILY } from './applyTypeface';

/**
 * Awaited in the root layout's splash gate (alongside token hydration and the
 * theme preference), so no first frame is painted in the system font.
 *
 * NEVER throws and never rejects: a missing family must not hold the splash. On
 * failure it logs one line and resolves `false`, which makes `applyTypeface` a
 * no-op and leaves every style honouring its own `fontWeight` under the system
 * font — a plainer app, not a broken one.
 */
export async function loadFonts(): Promise<boolean> {
  try {
    await Font.loadAsync({
      [INTER_FAMILY[400]]: Inter_400Regular,
      [INTER_FAMILY[500]]: Inter_500Medium,
      [INTER_FAMILY[600]]: Inter_600SemiBold,
      [INTER_FAMILY[700]]: Inter_700Bold,
    });
    console.log(
      `[theme:fonts] loaded ${INTER_FAMILY[400]} ${INTER_FAMILY[500]} ${INTER_FAMILY[600]} ${INTER_FAMILY[700]}`,
    );
    return true;
  } catch (error) {
    console.log('[theme:fonts] load failed, falling back to the system font:', String(error));
    return false;
  }
}
