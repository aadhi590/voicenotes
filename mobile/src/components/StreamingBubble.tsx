import { memo, useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";

import { useTokenBuffer } from "../hooks/useTokenBuffer";
import { isBusy } from "../state/machine";
import { streamBuffer, useStore } from "../state/store";
import { colors } from "../theme";
import { bubbleStyles } from "./MessageBubble";

const DOT_COUNT = 3;

function ThinkingDots() {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(anim, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);
  return (
    <View style={styles.dots} accessibilityLabel="Thinking">
      {Array.from({ length: DOT_COUNT }, (_, i) => {
        const start = i / DOT_COUNT;
        const opacity = anim.interpolate({
          inputRange: [0, start, Math.min(start + 0.33, 1), 1],
          outputRange: [0.25, 0.25, 1, 0.25],
        });
        return <Animated.View key={i} style={[styles.dot, { opacity }]} />;
      })}
    </View>
  );
}

/**
 * The live answer. The ONLY component that re-renders during streaming: it subscribes to the
 * throttled token buffer (≤ 20 updates/s). Plain text while streaming; citation chips appear
 * when the finished message replaces it.
 */
function StreamingBubbleBase() {
  const status = useStore((s) => s.machine.status);
  const text = useTokenBuffer(streamBuffer);
  if (!isBusy(status)) return null;
  return (
    <View style={bubbleStyles.row}>
      <View style={[bubbleStyles.bubble, bubbleStyles.assistant]}>
        {text ? <Text style={bubbleStyles.text}>{text}</Text> : <ThinkingDots />}
      </View>
    </View>
  );
}

export const StreamingBubble = memo(StreamingBubbleBase);

const styles = StyleSheet.create({
  dots: { flexDirection: "row", gap: 6, paddingVertical: 6 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.textDim },
});
