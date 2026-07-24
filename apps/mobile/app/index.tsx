import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PACKAGE_NAME } from '@budget/shared';

export default function Index() {
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text>Budget — mobile scaffold ({PACKAGE_NAME})</Text>
      </View>
    </SafeAreaView>
  );
}
