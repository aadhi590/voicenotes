import { memo, useCallback } from "react";
import { StyleSheet, Text } from "react-native";

import { colors } from "../theme";

interface Props {
  n: number;
  onPress: (n: number) => void;
}

/** Inline, tappable "[n]" chip. A nested <Text> so it flows with the sentence. */
function CitationChipBase({ n, onPress }: Props) {
  const handlePress = useCallback(() => onPress(n), [n, onPress]);
  return (
    <Text style={styles.chip} onPress={handlePress} accessibilityRole="button" accessibilityLabel={`Source ${n}`} suppressHighlighting>
      {` ${n} `}
    </Text>
  );
}

export const CitationChip = memo(CitationChipBase);

const styles = StyleSheet.create({
  chip: {
    backgroundColor: colors.chipBg,
    color: colors.chipText,
    fontSize: 12,
    fontWeight: "700",
    borderRadius: 6,
    overflow: "hidden",
  },
});
