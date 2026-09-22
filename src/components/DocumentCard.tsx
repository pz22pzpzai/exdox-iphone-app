import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ExpenseDocument } from '../types';
import { colors, radius, spacing } from '../theme';

const statusLabel = {
  awaiting_review: 'Awaiting review',
  ready_to_submit: 'Ready to submit',
  submitted: 'Submitted',
  payment_processing: 'Payment processing',
  paid: 'Paid',
} as const;

const statusTone = {
  awaiting_review: '#F6E6C6',
  ready_to_submit: '#D9EBDD',
  submitted: '#DDE8F2',
  payment_processing: '#DDE8F2',
  paid: '#D7EEE2',
} as const;

export function DocumentCard({
  document,
  onPress,
}: {
  document: ExpenseDocument;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.card} onPress={onPress}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.kicker}>{document.type === 'receipt' ? 'Receipt' : 'Invoice'}</Text>
          <Text style={styles.title}>{document.title}</Text>
        </View>
        <View style={[styles.badge, { backgroundColor: statusTone[document.status] }]}>
          <Text style={styles.badgeText}>{statusLabel[document.status]}</Text>
        </View>
      </View>
      <Text style={styles.subtitle}>{document.supplier}</Text>
      <View style={styles.metaRow}>
        <Text style={styles.amount}>
          {document.currency} {document.amount.toFixed(2)}
        </Text>
        <Text style={styles.category}>{document.category}</Text>
      </View>
      <Text style={styles.notes} numberOfLines={2}>
        {document.notes}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
    shadowColor: colors.ink,
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 2,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  kicker: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    color: colors.teal,
    marginBottom: 4,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.ink,
    maxWidth: 180,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: radius.pill,
  },
  badgeText: {
    fontSize: 11,
    color: colors.ink,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: 14,
    color: colors.mutedInk,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  amount: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.tealDeep,
  },
  category: {
    fontSize: 13,
    color: colors.mutedInk,
  },
  notes: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.mutedInk,
  },
});
