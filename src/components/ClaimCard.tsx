import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Claim } from '../types';
import { colors, radius, spacing } from '../theme';

export function ClaimCard({
  claim,
  receiptCount,
  onAddDocuments,
}: {
  claim: Claim;
  receiptCount: number;
  onAddDocuments: () => void;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.title}>{claim.name}</Text>
          <Text style={styles.subtitle}>{claim.trip}</Text>
        </View>
        <Text style={styles.total}>
          {claim.currency} {claim.total.toFixed(2)}
        </Text>
      </View>
      <Text style={styles.meta}>
        {receiptCount} document{receiptCount === 1 ? '' : 's'} linked • {claim.status}
      </Text>
      <Pressable style={styles.button} onPress={onAddDocuments}>
        <Text style={styles.buttonText}>Add receipts</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.sandSoft,
    gap: spacing.sm,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.ink,
  },
  subtitle: {
    color: colors.mutedInk,
    fontSize: 13,
    marginTop: 2,
  },
  total: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.tealDeep,
  },
  meta: {
    fontSize: 13,
    color: colors.mutedInk,
  },
  button: {
    alignSelf: 'flex-start',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.tealDeep,
  },
  buttonText: {
    color: colors.white,
    fontWeight: '700',
  },
});
