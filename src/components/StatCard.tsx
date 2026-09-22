import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from '../theme';

export function StatCard({
  label,
  value,
  tone = 'light',
}: {
  label: string;
  value: string;
  tone?: 'light' | 'dark';
}) {
  return (
    <View style={[styles.card, tone === 'dark' && styles.cardDark]}>
      <Text style={[styles.label, tone === 'dark' && styles.labelDark]}>{label}</Text>
      <Text style={[styles.value, tone === 'dark' && styles.valueDark]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    minWidth: 150,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardDark: {
    backgroundColor: colors.tealDeep,
    borderColor: colors.tealDeep,
  },
  label: {
    fontSize: 13,
    color: colors.mutedInk,
    marginBottom: spacing.xs,
  },
  labelDark: {
    color: '#CEE3E1',
  },
  value: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink,
  },
  valueDark: {
    color: colors.white,
  },
});
