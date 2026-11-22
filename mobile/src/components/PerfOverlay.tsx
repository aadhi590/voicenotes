import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import type { Metrics } from "../state/machine";
import { streamBuffer } from "../state/store";

const SAMPLE_MS = 1000;

/** Dev-only overlay (long-press the title): token-buffer flushes/sec + last server metrics. */
export function PerfOverlay({ metrics }: { metrics: Metrics | null }) {
  const [rate, setRate] = useState(0);
  const last = useRef(streamBuffer.flushCount);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = streamBuffer.flushCount;
      setRate(now - last.current);
      last.current = now;
    }, SAMPLE_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <View style={styles.box} pointerEvents="none">
      <Text style={styles.text}>{`flushes/s ${rate}   total ${streamBuffer.flushCount}`}</Text>
      <Text style={styles.text}>
        {metrics
          ? `retrieval ${metrics.retrieval_ms}ms · ttft ${metrics.ttft_ms ?? "-"}ms · total ${metrics.total_ms}ms · ${metrics.tokens} tok`
          : "no answer yet"}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { position: "absolute", top: 4, right: 8, left: 8, backgroundColor: "rgba(0,0,0,0.75)", borderRadius: 8, padding: 8, zIndex: 10 },
  text: { color: "#7CFC9A", fontFamily: "monospace", fontSize: 11 },
});
