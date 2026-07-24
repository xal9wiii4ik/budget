import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { formatMoney } from '@budget/shared';

export default function Index() {
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text>Budget — mobile scaffold ({formatMoney(12345, 'USD', { locale: 'en-US' })})</Text>
      </View>
    </SafeAreaView>
  );
}
